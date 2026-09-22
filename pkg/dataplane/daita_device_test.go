package dataplane

import (
	"crypto/rand"
	"net/netip"
	"testing"

	"github.com/sovereign/proxy/v4/pkg/dataplane/daita"
)

func TestDevice_WithDaitaMode(t *testing.T) {
	var privKey [32]byte
	_, _ = rand.Read(privKey[:])

	localVIP := netip.MustParsePrefix("100.64.0.10/10")

	cfg := Config{
		Mode:       ModeNetstack,
		PrivateKey: privKey,
		Addresses:  []netip.Prefix{localVIP},
		ListenPort: 0,
		DaitaMode:  daita.ModeBalanced,
	}

	dev, err := New(cfg)
	if err != nil {
		t.Fatalf("Failed to create device with DAITA balanced: %v", err)
	}
	defer dev.Close()

	if dev.DaitaShaper() == nil {
		t.Fatal("Device DaitaShaper was nil")
	}

	if dev.DaitaShaper().Mode() != daita.ModeBalanced {
		t.Fatalf("Daita mode mismatch: got %s, want %s", dev.DaitaShaper().Mode(), daita.ModeBalanced)
	}

	// Test dummy packet drop via filteredTUN Write
	dummy := dev.DaitaShaper().BuildDummyPacket(256)
	const offset = 4
	withOffset := append(make([]byte, offset), dummy...)

	n, err := dev.filter.Write([][]byte{withOffset}, offset)
	if err != nil {
		t.Fatalf("Write: %v", err)
	}
	if n != 0 {
		t.Fatalf("Dummy packet was delivered to stack, want 0, got %d", n)
	}

	stats := dev.Stats()
	if stats.DummyDropped != 1 {
		t.Fatalf("DummyDropped = %d, want 1", stats.DummyDropped)
	}
}
