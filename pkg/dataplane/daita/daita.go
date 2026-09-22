package daita

import (
	"context"
	"crypto/rand"
	"encoding/binary"
	"errors"
	"math"
	"math/big"
	"net/netip"
	"sync"
	"time"
)

// Supported DAITA protection modes
const (
	ModeOff      = "off"
	ModeBalanced = "balanced"
	ModeParanoid = "paranoid"
)

// ProtocolExperimental is used for dummy cover traffic packets (RFC 3692)
const ProtocolExperimental = 253

// Discrete bucket sizes for Balanced mode (bytes)
const (
	Bucket256  = 256
	Bucket512  = 512
	Bucket1024 = 1024
	Bucket1280 = 1280
	Bucket1380 = 1380
)

// Shaper handles packet size normalization and cover traffic generation.
type Shaper struct {
	mu           sync.RWMutex
	mode         string
	mtu          int
	localVIP     netip.Addr
	peerVIP      netip.Addr
	dummySender  func(packet []byte) error
	cancelCover  context.CancelFunc
	coverWg      sync.WaitGroup
	burstTrigger chan struct{}
}

// NewShaper creates a DAITA traffic analysis defense engine.
func NewShaper(mode string, mtu int, localVIP, peerVIP netip.Addr, sender func(packet []byte) error) (*Shaper, error) {
	if mode == "" {
		mode = ModeOff
	}
	if mode != ModeOff && mode != ModeBalanced && mode != ModeParanoid {
		return nil, errors.New("daita: invalid mode, must be off, balanced, or paranoid")
	}
	if mtu <= 0 {
		mtu = Bucket1380
	}

	return &Shaper{
		mode:         mode,
		mtu:          mtu,
		localVIP:     localVIP,
		peerVIP:      peerVIP,
		dummySender:  sender,
		burstTrigger: make(chan struct{}, 100),
	}, nil
}

// Mode returns the current DAITA mode.
func (s *Shaper) Mode() string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.mode
}

// SetMode dynamically changes the DAITA mode at runtime.
func (s *Shaper) SetMode(mode string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if mode != ModeOff && mode != ModeBalanced && mode != ModeParanoid {
		return errors.New("daita: invalid mode")
	}
	s.mode = mode
	return nil
}

// NormalizePacketSize pads outgoing packets according to the configured mode.
func (s *Shaper) NormalizePacketSize(packet []byte) []byte {
	s.mu.RLock()
	mode := s.mode
	mtu := s.mtu
	s.mu.RUnlock()

	if mode == ModeOff || len(packet) == 0 {
		return packet
	}

	// Trigger opportunistic burst cover traffic if in Balanced or Paranoid mode
	select {
	case s.burstTrigger <- struct{}{}:
	default:
	}

	origLen := len(packet)
	var targetLen int

	switch mode {
	case ModeParanoid:
		// Paranoid mode: constant size for every packet up to MTU
		targetLen = mtu
		if targetLen > Bucket1280 {
			targetLen = Bucket1280
		}
		if origLen > targetLen {
			targetLen = mtu
		}

	case ModeBalanced:
		// Balanced mode: bucketize to discrete powers/blocks
		switch {
		case origLen <= Bucket256:
			targetLen = Bucket256
		case origLen <= Bucket512:
			targetLen = Bucket512
		case origLen <= Bucket1024:
			targetLen = Bucket1024
		case origLen <= Bucket1280:
			targetLen = Bucket1280
		default:
			targetLen = mtu
		}
	}

	if origLen >= targetLen {
		return packet
	}

	padded := make([]byte, targetLen)
	copy(padded, packet)
	// Trailing bytes are zero-padded; standard IP stacks use header length and ignore padding
	return padded
}

// ParseRealLength extracts the true IP packet length from IPv4/IPv6 headers.
func ParseRealLength(packet []byte) (int, error) {
	if len(packet) < 20 {
		return 0, errors.New("daita: packet too short for IP header")
	}

	version := packet[0] >> 4
	switch version {
	case 4:
		// IPv4 Total Length is at offset 2..4
		totalLen := int(binary.BigEndian.Uint16(packet[2:4]))
		if totalLen > len(packet) || totalLen < 20 {
			return len(packet), nil
		}
		return totalLen, nil
	case 6:
		if len(packet) < 40 {
			return 0, errors.New("daita: packet too short for IPv6 header")
		}
		// IPv6 Payload Length is at offset 4..6 (excludes 40-byte fixed header)
		payloadLen := int(binary.BigEndian.Uint16(packet[4:6]))
		totalLen := payloadLen + 40
		if totalLen > len(packet) {
			return len(packet), nil
		}
		return totalLen, nil
	default:
		return len(packet), nil
	}
}

// IsDummyPacket determines whether an incoming packet is DAITA cover/dummy traffic.
func IsDummyPacket(packet []byte) bool {
	if len(packet) < 20 {
		return false
	}
	version := packet[0] >> 4
	if version == 4 {
		// IPv4 Protocol is at offset 9
		protocol := packet[9]
		return protocol == ProtocolExperimental
	} else if version == 6 && len(packet) >= 40 {
		// IPv6 Next Header is at offset 6
		nextHeader := packet[6]
		return nextHeader == ProtocolExperimental
	}
	return false
}

// BuildDummyPacket constructs an RFC 3692 experimental dummy IPv4 datagram.
func (s *Shaper) BuildDummyPacket(size int) []byte {
	if size < 20 {
		size = Bucket256
	}

	pkt := make([]byte, size)
	// IPv4 Version 4, IHL 5 (20 bytes)
	pkt[0] = 0x45
	pkt[1] = 0x00 // DSCP / ECN
	binary.BigEndian.PutUint16(pkt[2:4], uint16(size))
	binary.BigEndian.PutUint16(pkt[4:6], 0x4454) // ID: "DT" (DAITA)
	pkt[6] = 0x40                                // Don't Fragment
	pkt[7] = 0x00
	pkt[8] = 64                   // TTL
	pkt[9] = ProtocolExperimental // Protocol 253

	// Source & Dest IPs
	if s.localVIP.Is4() {
		copy(pkt[12:16], s.localVIP.AsSlice())
	} else {
		pkt[12], pkt[13], pkt[14], pkt[15] = 100, 64, 0, 1
	}

	if s.peerVIP.Is4() {
		copy(pkt[16:20], s.peerVIP.AsSlice())
	} else {
		pkt[16], pkt[17], pkt[18], pkt[19] = 100, 64, 0, 2
	}

	// Calculate IPv4 Header Checksum
	chk := ipChecksum(pkt[:20])
	binary.BigEndian.PutUint16(pkt[10:12], chk)

	// Fill payload with random cover noise
	if size > 20 {
		_, _ = rand.Read(pkt[20:])
	}

	return pkt
}

func ipChecksum(hdr []byte) uint16 {
	var sum uint32
	for i := 0; i < len(hdr); i += 2 {
		sum += uint32(binary.BigEndian.Uint16(hdr[i : i+2]))
	}
	for (sum >> 16) > 0 {
		sum = (sum & 0xffff) + (sum >> 16)
	}
	return ^uint16(sum)
}

// StartCoverTraffic initiates background cover traffic generation for anti-AI protection.
func (s *Shaper) StartCoverTraffic(ctx context.Context) {
	s.mu.Lock()
	if s.cancelCover != nil {
		s.mu.Unlock()
		return
	}
	ctx, s.cancelCover = context.WithCancel(ctx)
	s.mu.Unlock()

	s.coverWg.Add(1)
	go func() {
		defer s.coverWg.Done()
		s.runCoverLoop(ctx)
	}()
}

// StopCoverTraffic shuts down background cover traffic.
func (s *Shaper) StopCoverTraffic() {
	s.mu.Lock()
	cancel := s.cancelCover
	s.cancelCover = nil
	s.mu.Unlock()

	if cancel != nil {
		cancel()
	}
	s.coverWg.Wait()
}

func (s *Shaper) runCoverLoop(ctx context.Context) {
	ticker := time.NewTicker(200 * time.Millisecond)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return

		case <-s.burstTrigger:
			s.mu.RLock()
			mode := s.mode
			sender := s.dummySender
			s.mu.RUnlock()

			if (mode == ModeBalanced || mode == ModeParanoid) && sender != nil {
				// Inject 1 opportunistic dummy packet during burst
				dummy := s.BuildDummyPacket(Bucket512)
				_ = sender(dummy)
			}

		case <-ticker.C:
			s.mu.RLock()
			mode := s.mode
			sender := s.dummySender
			s.mu.RUnlock()

			if mode == ModeParanoid && sender != nil {
				// Paranoid mode sends periodic cover traffic using randomized exponential distribution
				delay := sampleExponential(150 * time.Millisecond)
				time.Sleep(delay)
				dummy := s.BuildDummyPacket(Bucket1280)
				_ = sender(dummy)
			}
		}
	}
}

func sampleExponential(mean time.Duration) time.Duration {
	n, err := rand.Int(rand.Reader, big.NewInt(1000000))
	if err != nil {
		return mean
	}
	u := float64(n.Int64()+1) / 1000001.0
	// Inverse transform sampling for exponential distribution: -mean * ln(u)
	sampleMs := -float64(mean.Milliseconds()) * math.Log(u)
	if sampleMs < 10 {
		sampleMs = 10
	}
	if sampleMs > 500 {
		sampleMs = 500
	}
	return time.Duration(sampleMs) * time.Millisecond
}
