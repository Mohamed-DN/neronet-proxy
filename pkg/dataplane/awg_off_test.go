//go:build !awg

package dataplane

import (
	"errors"
	"net/netip"
	"testing"
)

// A binary built without the awg tag says why it cannot serve AmneziaWG, and never puts an
// AmneziaWG peer on the plain WireGuard device instead.
func TestBuildWithoutAWGRefusesItClearly(t *testing.T) {
	g := newTestNode(t, gwAddr+"/10", nil)
	if err := g.dev.StartAWG(AWGConfig{Params: validAWGParams()}); !errors.Is(err, ErrAWGNotBuilt) {
		t.Fatalf("StartAWG without the awg tag: %v", err)
	}
	other := newTestNode(t, otherAddr+"/10", nil)
	device := Peer{
		PublicKey:    other.peerEntry().PublicKey,
		AllowedIPs:   []netip.Prefix{prefix32("100.64.0.9")},
		PresharedKey: testPSK,
		Profile:      true,
		AWG:          true,
	}
	if err := g.dev.SetPeers([]Peer{device}); err == nil {
		t.Fatal("an AmneziaWG peer was accepted by a binary without AmneziaWG")
	}
	if AWGBuilt() {
		t.Fatal("AWGBuilt is true without the tag")
	}
}
