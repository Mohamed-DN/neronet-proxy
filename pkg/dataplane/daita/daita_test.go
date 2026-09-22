package daita

import (
	"context"
	"encoding/binary"
	"net/netip"
	"sync"
	"testing"
	"time"
)

func TestNormalizePacketSize_Modes(t *testing.T) {
	localVIP := netip.MustParseAddr("100.64.0.1")
	peerVIP := netip.MustParseAddr("100.64.0.2")

	shaper, err := NewShaper(ModeOff, 1380, localVIP, peerVIP, nil)
	if err != nil {
		t.Fatalf("Failed to create shaper: %v", err)
	}

	rawPkt := make([]byte, 100)
	rawPkt[0] = 0x45
	binary.BigEndian.PutUint16(rawPkt[2:4], 100)

	// Mode Off: no padding
	outOff := shaper.NormalizePacketSize(rawPkt)
	if len(outOff) != 100 {
		t.Fatalf("ModeOff padded packet: got len %d, want 100", len(outOff))
	}

	// Mode Balanced: 100 -> 256; 300 -> 512; 700 -> 1024; 1100 -> 1280
	_ = shaper.SetMode(ModeBalanced)
	out256 := shaper.NormalizePacketSize(rawPkt)
	if len(out256) != Bucket256 {
		t.Fatalf("ModeBalanced 100-byte packet: got len %d, want %d", len(out256), Bucket256)
	}

	pkt300 := make([]byte, 300)
	out512 := shaper.NormalizePacketSize(pkt300)
	if len(out512) != Bucket512 {
		t.Fatalf("ModeBalanced 300-byte packet: got len %d, want %d", len(out512), Bucket512)
	}

	pkt700 := make([]byte, 700)
	out1024 := shaper.NormalizePacketSize(pkt700)
	if len(out1024) != Bucket1024 {
		t.Fatalf("ModeBalanced 700-byte packet: got len %d, want %d", len(out1024), Bucket1024)
	}

	pkt1100 := make([]byte, 1100)
	out1280 := shaper.NormalizePacketSize(pkt1100)
	if len(out1280) != Bucket1280 {
		t.Fatalf("ModeBalanced 1100-byte packet: got len %d, want %d", len(out1280), Bucket1280)
	}

	// Mode Paranoid: constant 1280
	_ = shaper.SetMode(ModeParanoid)
	outParanoid := shaper.NormalizePacketSize(rawPkt)
	if len(outParanoid) != Bucket1280 {
		t.Fatalf("ModeParanoid 100-byte packet: got len %d, want %d", len(outParanoid), Bucket1280)
	}
}

func TestParseRealLength(t *testing.T) {
	// IPv4 Packet with declared total length 80, but padded to 256 bytes
	pkt := make([]byte, 256)
	pkt[0] = 0x45
	binary.BigEndian.PutUint16(pkt[2:4], 80)

	realLen, err := ParseRealLength(pkt)
	if err != nil {
		t.Fatalf("ParseRealLength failed: %v", err)
	}
	if realLen != 80 {
		t.Fatalf("Real length mismatch: got %d, want 80", realLen)
	}
}

func TestIsDummyPacket(t *testing.T) {
	localVIP := netip.MustParseAddr("100.64.0.1")
	peerVIP := netip.MustParseAddr("100.64.0.2")

	shaper, _ := NewShaper(ModeBalanced, 1380, localVIP, peerVIP, nil)

	// Normal IPv4 TCP packet (Protocol 6)
	tcpPkt := make([]byte, 60)
	tcpPkt[0] = 0x45
	tcpPkt[9] = 6
	if IsDummyPacket(tcpPkt) {
		t.Fatal("Normal TCP packet recognized as dummy")
	}

	// Dummy packet (Protocol 253)
	dummy := shaper.BuildDummyPacket(Bucket256)
	if !IsDummyPacket(dummy) {
		t.Fatal("Built dummy packet was not recognized as dummy")
	}
	if len(dummy) != Bucket256 {
		t.Fatalf("Dummy packet size mismatch: got %d, want %d", len(dummy), Bucket256)
	}
}

func TestCoverTraffic_BurstTrigger(t *testing.T) {
	localVIP := netip.MustParseAddr("100.64.0.1")
	peerVIP := netip.MustParseAddr("100.64.0.2")

	var mu sync.Mutex
	var sentCount int

	sender := func(packet []byte) error {
		mu.Lock()
		sentCount++
		mu.Unlock()
		return nil
	}

	shaper, _ := NewShaper(ModeBalanced, 1380, localVIP, peerVIP, sender)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	shaper.StartCoverTraffic(ctx)
	defer shaper.StopCoverTraffic()

	// Simulate an outbound packet burst
	for i := 0; i < 5; i++ {
		shaper.NormalizePacketSize([]byte{0x45, 0, 0, 40})
	}

	// Wait for cover loop to process burst trigger
	time.Sleep(100 * time.Millisecond)

	mu.Lock()
	count := sentCount
	mu.Unlock()

	if count == 0 {
		t.Fatal("Cover traffic generator did not emit any dummy packets on burst")
	}
}
