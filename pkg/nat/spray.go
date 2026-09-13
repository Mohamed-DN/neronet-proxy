package nat

import (
	"bytes"
	"context"
	"crypto/rand"
	"errors"
	"net"
	"sync"
	"time"
)

var (
	SprayProbeMagic    = []byte("SVRN_DISCO_SPRAY_V4")
	SprayAckMagic      = []byte("SVRN_DISCO_ACK_V4")
	ErrHolePunchFailed = errors.New("hole punching timed out: no bidirectional path established")
)

// SprayResult contains the verified direct UDP endpoint
type SprayResult struct {
	RemoteAddr *net.UDPAddr
	RTT        time.Duration
	ProbesSent int
}

// ExecuteBirthdaySpray runs the multi-port birthday paradox spraying strategy.
// Sends UDP probe bursts across a port window while concurrently listening on localConn.
func ExecuteBirthdaySpray(
	ctx context.Context,
	localConn *net.UDPConn,
	targetIP net.IP,
	targetBasePort int,
	portWindow int,
) (*SprayResult, error) {
	if portWindow <= 0 {
		portWindow = 256
	}

	var sessionToken [16]byte
	rand.Read(sessionToken[:])

	probePayload := append([]byte(nil), SprayProbeMagic...)
	probePayload = append(probePayload, sessionToken[:]...)

	ackPayload := append([]byte(nil), SprayAckMagic...)
	ackPayload = append(ackPayload, sessionToken[:]...)

	var matchedAddr *net.UDPAddr
	var matchedMu sync.Mutex
	done := make(chan struct{})
	startTime := time.Now()

	// Inbound Listener Goroutine
	go func() {
		buf := make([]byte, 1024)
		for {
			select {
			case <-done:
				return
			case <-ctx.Done():
				return
			default:
				localConn.SetReadDeadline(time.Now().Add(50 * time.Millisecond))
				n, from, err := localConn.ReadFromUDP(buf)
				if err != nil {
					continue
				}

				// Check if from target IP
				if !from.IP.Equal(targetIP) {
					continue
				}

				if n >= len(probePayload) && bytes.HasPrefix(buf[:n], SprayProbeMagic) {
					// Received probe -> Echo Ack immediately back to sender
					_, _ = localConn.WriteToUDP(ackPayload, from)
					matchedMu.Lock()
					if matchedAddr == nil {
						matchedAddr = from
						close(done)
					}
					matchedMu.Unlock()
					return
				} else if n >= len(ackPayload) && bytes.HasPrefix(buf[:n], SprayAckMagic) {
					// Received Ack -> Confirmed path!
					matchedMu.Lock()
					if matchedAddr == nil {
						matchedAddr = from
						close(done)
					}
					matchedMu.Unlock()
					return
				}
			}
		}
	}()

	// Outbound Spray Burst Loop
	probesSent := 0
	halfWindow := portWindow / 2
	minPort := targetBasePort - halfWindow
	if minPort < 1024 {
		minPort = 1024
	}
	maxPort := targetBasePort + halfWindow
	if maxPort > 65535 {
		maxPort = 65535
	}

	ticker := time.NewTicker(2 * time.Millisecond)
	defer ticker.Stop()

	for port := minPort; port <= maxPort; port++ {
		select {
		case <-done:
			matchedMu.Lock()
			res := &SprayResult{
				RemoteAddr: matchedAddr,
				RTT:        time.Since(startTime),
				ProbesSent: probesSent,
			}
			matchedMu.Unlock()
			return res, nil
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-ticker.C:
			dst := &net.UDPAddr{IP: targetIP, Port: port}
			_, _ = localConn.WriteToUDP(probePayload, dst)
			probesSent++
		}
	}

	// Wait brief duration for lingering Acks
	select {
	case <-done:
		matchedMu.Lock()
		res := &SprayResult{
			RemoteAddr: matchedAddr,
			RTT:        time.Since(startTime),
			ProbesSent: probesSent,
		}
		matchedMu.Unlock()
		return res, nil
	case <-time.After(500 * time.Millisecond):
	case <-ctx.Done():
	}

	// Signal the reader to stop. Returning without this left it blocked on the socket
	// for the lifetime of the process, holding memory and consuming inbound packets
	// that belonged to whatever used the port next.
	close(done)

	return nil, ErrHolePunchFailed
}

// ExecuteSequentialPrediction probes a sequence of contiguous ports based on observed delta.
func ExecuteSequentialPrediction(
	ctx context.Context,
	localConn *net.UDPConn,
	targetIP net.IP,
	basePort int,
	delta int,
	attempts int,
) (*SprayResult, error) {
	if delta == 0 {
		delta = 1
	}
	if attempts <= 0 {
		attempts = 32
	}

	var sessionToken [16]byte
	rand.Read(sessionToken[:])

	probePayload := append([]byte(nil), SprayProbeMagic...)
	probePayload = append(probePayload, sessionToken[:]...)

	ackPayload := append([]byte(nil), SprayAckMagic...)
	ackPayload = append(ackPayload, sessionToken[:]...)

	var matchedAddr *net.UDPAddr
	var matchedMu sync.Mutex
	done := make(chan struct{})
	startTime := time.Now()

	// Inbound Listener
	go func() {
		buf := make([]byte, 1024)
		for {
			select {
			case <-done:
				return
			case <-ctx.Done():
				return
			default:
				localConn.SetReadDeadline(time.Now().Add(50 * time.Millisecond))
				n, from, err := localConn.ReadFromUDP(buf)
				if err != nil {
					continue
				}

				if !from.IP.Equal(targetIP) {
					continue
				}

				if n >= len(probePayload) && bytes.HasPrefix(buf[:n], SprayProbeMagic) {
					_, _ = localConn.WriteToUDP(ackPayload, from)
					matchedMu.Lock()
					if matchedAddr == nil {
						matchedAddr = from
						close(done)
					}
					matchedMu.Unlock()
					return
				} else if n >= len(ackPayload) && bytes.HasPrefix(buf[:n], SprayAckMagic) {
					matchedMu.Lock()
					if matchedAddr == nil {
						matchedAddr = from
						close(done)
					}
					matchedMu.Unlock()
					return
				}
			}
		}
	}()

	probesSent := 0
	for i := 1; i <= attempts; i++ {
		candidatePort := basePort + (i * delta)
		if candidatePort < 1024 || candidatePort > 65535 {
			continue
		}

		select {
		case <-done:
			matchedMu.Lock()
			res := &SprayResult{
				RemoteAddr: matchedAddr,
				RTT:        time.Since(startTime),
				ProbesSent: probesSent,
			}
			matchedMu.Unlock()
			return res, nil
		case <-ctx.Done():
			return nil, ctx.Err()
		default:
			dst := &net.UDPAddr{IP: targetIP, Port: candidatePort}
			_, _ = localConn.WriteToUDP(probePayload, dst)
			probesSent++
			time.Sleep(5 * time.Millisecond)
		}
	}

	select {
	case <-done:
		matchedMu.Lock()
		res := &SprayResult{
			RemoteAddr: matchedAddr,
			RTT:        time.Since(startTime),
			ProbesSent: probesSent,
		}
		matchedMu.Unlock()
		return res, nil
	case <-time.After(300 * time.Millisecond):
	case <-ctx.Done():
	}

	return nil, ErrHolePunchFailed
}
