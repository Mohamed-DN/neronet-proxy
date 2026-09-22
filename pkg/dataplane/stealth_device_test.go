package dataplane

import (
	"crypto/rand"
	"net/netip"
	"testing"

	"github.com/sovereign/proxy/v4/pkg/dataplane/stealth"
)

func TestDevice_WithStealthConfig(t *testing.T) {
	var privKey [32]byte
	_, _ = rand.Read(privKey[:])

	stCfg := stealth.DefaultConfig()
	mgr := stealth.NewTransportManager(stealth.TransportAmneziaWG, stCfg)

	cfg := Config{
		Mode:         ModeNetstack,
		PrivateKey:   privKey,
		Addresses:    []netip.Prefix{netip.MustParsePrefix("100.64.0.10/10")},
		ListenPort:   0,
		Stealth:      &stCfg,
		TransportMgr: mgr,
	}

	dev, err := New(cfg)
	if err != nil {
		t.Fatalf("Failed to create device with stealth config: %v", err)
	}
	defer dev.Close()

	if dev.transportMgr == nil {
		t.Fatal("Device transportMgr was not set")
	}

	peerPub := "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	peers := []Peer{
		{
			PublicKey:  peerPub,
			AllowedIPs: []netip.Prefix{netip.MustParsePrefix("100.64.0.11/32")},
			Transport:  stealth.TransportAmneziaWG,
			Stealth:    &stCfg,
		},
	}

	if err := dev.SetPeers(peers); err != nil {
		t.Fatalf("SetPeers failed: %v", err)
	}

	effTransport, effStealth := dev.transportMgr.GetEffectiveTransport(peerPub)
	if effTransport != stealth.TransportAmneziaWG {
		t.Fatalf("Effective transport mismatch: got %s, want %s", effTransport, stealth.TransportAmneziaWG)
	}
	if effStealth.H1 != stCfg.H1 {
		t.Fatalf("Effective stealth H1 mismatch: got 0x%x, want 0x%x", effStealth.H1, stCfg.H1)
	}
}
