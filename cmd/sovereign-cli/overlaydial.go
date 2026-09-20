package main

import (
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"strconv"
	"time"
)

// overlay-dial asks this node to reach another node's overlay address and read the
// echo back, and reports one machine-readable line.
//
// It goes through the node's own SOCKS5 inbound, which is the path a real client
// takes: the bridge sends overlay destinations through the mesh and everything else
// through the egress sandbox. Opening a tunnel of its own would measure a path the
// product does not have.
//
// The exit status is the result, so a scenario script can branch on it without
// parsing: 0 reached, 2 refused by policy, 3 timed out, 1 could not run at all.
const (
	exitOverlayOK      = 0
	exitOverlayUsage   = 1
	exitOverlayDenied  = 2
	exitOverlayTimeout = 3
)

// echoMode is the responder's mode byte for "copy every byte back". It is one byte
// rather than a negotiation because what is being measured is the transport.
const echoMode = 'E'

func overlayDial(args []string) int {
	if len(args) < 2 {
		fmt.Fprintln(os.Stderr, "Usage: sovereign-cli overlay-dial <socks5 host:port> <overlay host:port> [timeout seconds] [hold seconds]")
		return exitOverlayUsage
	}

	socksAddr := args[0]
	target := args[1]

	timeout := 5 * time.Second
	if len(args) > 2 {
		seconds, err := strconv.Atoi(args[2])
		if err != nil || seconds <= 0 {
			fmt.Fprintf(os.Stderr, "timeout %q is not a positive number of seconds\n", args[2])
			return exitOverlayUsage
		}
		timeout = time.Duration(seconds) * time.Second
	}

	// A hold turns one round trip into a long-lived connection: the same TCP stream is
	// kept open and exercised once a second. It is what shows that an established flow
	// survives a control plane going away, which a sequence of new connections cannot.
	if len(args) > 3 {
		seconds, err := strconv.Atoi(args[3])
		if err != nil || seconds <= 0 {
			fmt.Fprintf(os.Stderr, "hold %q is not a positive number of seconds\n", args[3])
			return exitOverlayUsage
		}
		return holdThroughSocks(socksAddr, target, timeout, time.Duration(seconds)*time.Second)
	}

	rtt, err := echoThroughSocks(socksAddr, target, timeout)
	if err == nil {
		fmt.Printf("ok %s %.3f\n", target, float64(rtt.Microseconds())/1000)
		return exitOverlayOK
	}

	// A filter that drops the packet produces a timeout, because a dropped packet is
	// indistinguishable from a peer that is not there -- which is the point. A reset
	// or a refusal means something answered and said no.
	var netErr net.Error
	if errors.As(err, &netErr) && netErr.Timeout() {
		fmt.Printf("timeout %s\n", target)
		return exitOverlayTimeout
	}
	if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
		fmt.Printf("denied %s (%v)\n", target, err)
		return exitOverlayDenied
	}

	fmt.Printf("denied %s (%v)\n", target, err)
	return exitOverlayDenied
}

// holdThroughSocks keeps one connection open and exercises it once a second.
//
// It reports how many round trips succeeded, how long the stream lasted and, when it
// broke, at which second and why. A stream that survives the whole window is the
// evidence that an established flow is not torn down by the control plane going away.
func holdThroughSocks(socksAddr, target string, timeout, hold time.Duration) int {
	conn, err := net.DialTimeout("tcp", socksAddr, timeout)
	if err != nil {
		fmt.Printf("denied %s (dialling the local SOCKS5 inbound: %v)\n", target, err)
		return exitOverlayDenied
	}
	defer conn.Close()

	_ = conn.SetDeadline(time.Now().Add(timeout))
	if err := socksConnect(conn, target); err != nil {
		fmt.Printf("denied %s (%v)\n", target, err)
		return exitOverlayDenied
	}

	if _, err := conn.Write([]byte{echoMode}); err != nil {
		fmt.Printf("denied %s (%v)\n", target, err)
		return exitOverlayDenied
	}

	start := time.Now()
	deadline := start.Add(hold)
	exchanges := 0

	for time.Now().Before(deadline) {
		_ = conn.SetDeadline(time.Now().Add(timeout))
		marker := fmt.Sprintf("HOLD-%06d", exchanges)
		if _, err := conn.Write([]byte(marker)); err != nil {
			fmt.Printf("held %s broke after %s and %d exchange(s): %v\n", target, time.Since(start).Round(time.Second), exchanges, err)
			return exitOverlayDenied
		}
		echoed := make([]byte, len(marker))
		if _, err := io.ReadFull(conn, echoed); err != nil {
			fmt.Printf("held %s broke after %s and %d exchange(s): %v\n", target, time.Since(start).Round(time.Second), exchanges, err)
			return exitOverlayTimeout
		}
		if string(echoed) != marker {
			fmt.Printf("held %s returned %q, not what was sent\n", target, echoed)
			return exitOverlayDenied
		}
		exchanges++
		time.Sleep(time.Second)
	}

	fmt.Printf("held %s for %s, %d exchange(s), unbroken\n", target, time.Since(start).Round(time.Second), exchanges)
	return exitOverlayOK
}

// echoThroughSocks performs an RFC 1928 CONNECT and one echo round trip.
func echoThroughSocks(socksAddr, target string, timeout time.Duration) (time.Duration, error) {
	conn, err := net.DialTimeout("tcp", socksAddr, timeout)
	if err != nil {
		return 0, fmt.Errorf("dialling the local SOCKS5 inbound: %w", err)
	}
	defer conn.Close()

	deadline := time.Now().Add(timeout)
	if err := conn.SetDeadline(deadline); err != nil {
		return 0, err
	}

	if err := socksConnect(conn, target); err != nil {
		return 0, err
	}

	marker := fmt.Sprintf("NERONET-OVERLAY-PROBE-%d", time.Now().UnixNano())
	payload := append([]byte{echoMode}, []byte(marker)...)

	start := time.Now()
	if _, err := conn.Write(payload); err != nil {
		return 0, err
	}

	echoed := make([]byte, len(marker))
	if _, err := io.ReadFull(conn, echoed); err != nil {
		return 0, err
	}
	rtt := time.Since(start)

	if string(echoed) != marker {
		return 0, fmt.Errorf("the responder returned %q, not what was sent", string(echoed))
	}
	return rtt, nil
}

func socksConnect(conn net.Conn, target string) error {
	host, portText, err := net.SplitHostPort(target)
	if err != nil {
		return fmt.Errorf("target %q: %w", target, err)
	}
	port, err := strconv.ParseUint(portText, 10, 16)
	if err != nil {
		return fmt.Errorf("target port %q: %w", portText, err)
	}

	// Greeting: version 5, one method, no authentication.
	if _, err := conn.Write([]byte{0x05, 0x01, 0x00}); err != nil {
		return err
	}
	var greeting [2]byte
	if _, err := io.ReadFull(conn, greeting[:]); err != nil {
		return fmt.Errorf("SOCKS5 greeting: %w", err)
	}
	if greeting[0] != 0x05 || greeting[1] != 0x00 {
		return fmt.Errorf("SOCKS5 server refused the no-authentication method (%02x %02x)", greeting[0], greeting[1])
	}

	request := []byte{0x05, 0x01, 0x00}
	if ip := net.ParseIP(host); ip != nil && ip.To4() != nil {
		request = append(request, 0x01)
		request = append(request, ip.To4()...)
	} else if ip != nil {
		request = append(request, 0x04)
		request = append(request, ip.To16()...)
	} else {
		if len(host) > 255 {
			return fmt.Errorf("host name %q is too long for SOCKS5", host)
		}
		request = append(request, 0x03, byte(len(host)))
		request = append(request, host...)
	}
	request = append(request, byte(port>>8), byte(port))

	if _, err := conn.Write(request); err != nil {
		return err
	}

	var head [4]byte
	if _, err := io.ReadFull(conn, head[:]); err != nil {
		return fmt.Errorf("SOCKS5 reply: %w", err)
	}
	if head[1] != 0x00 {
		return fmt.Errorf("SOCKS5 CONNECT refused: %s", socksReplyName(head[1]))
	}

	// Drain the bound address so the stream starts at the payload.
	switch head[3] {
	case 0x01:
		_, err = io.ReadFull(conn, make([]byte, 4+2))
	case 0x04:
		_, err = io.ReadFull(conn, make([]byte, 16+2))
	case 0x03:
		var length [1]byte
		if _, err = io.ReadFull(conn, length[:]); err != nil {
			return err
		}
		_, err = io.ReadFull(conn, make([]byte, int(length[0])+2))
	default:
		return fmt.Errorf("SOCKS5 reply carried address type %d", head[3])
	}
	return err
}

func socksReplyName(code byte) string {
	names := map[byte]string{
		0x01: "general failure",
		0x02: "connection not allowed by ruleset",
		0x03: "network unreachable",
		0x04: "host unreachable",
		0x05: "connection refused",
		0x06: "TTL expired",
		0x07: "command not supported",
		0x08: "address type not supported",
	}
	if name, ok := names[code]; ok {
		return name
	}
	return "code " + strconv.Itoa(int(code))
}
