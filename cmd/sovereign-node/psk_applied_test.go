package main

import (
	"sync"
	"testing"
	"time"

	"github.com/sovereign/proxy/v4/pkg/crypto/pskepoch"
	"github.com/sovereign/proxy/v4/pkg/dataplane"
)

type recordingPSK struct {
	mu   sync.Mutex
	keys map[string]int
}

func (r *recordingPSK) UpdatePeerPSK(peer, _ string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.keys[peer]++
	return nil
}

// D24: the rotation is told about the peers the device actually has, not every key the
// document listed. A revoked peer is in the document until the control plane stops
// sending it, but it is not on the device, and a key for it is a key for nobody.
func TestPSKRotationOnlyGetsPeersAppliedToTheDevice(t *testing.T) {
	a := newOverlayNode(t, "100.64.0.41/10")
	b := newOverlayNode(t, "100.64.0.42/10")
	c := newOverlayNode(t, "100.64.0.43/10")
	m := managerFor(t, a)

	rec := &recordingPSK{keys: map[string]int{}}
	m.SetPSKManager(pskepoch.NewManager(rec, a.keys, time.Hour))

	netmap := netmapFor(3, a.addr, allowAllPolicy("a", a.addr, b.addr, c.addr), b.peerEntry("b"), c.peerEntry("c"))
	netmap.RevokedKeys = []string{c.keyHex()}
	if err := m.Apply(netmap, time.Now()); err != nil {
		t.Fatal(err)
	}

	rec.mu.Lock()
	defer rec.mu.Unlock()
	if rec.keys[b.keyHex()] == 0 {
		t.Fatalf("the applied peer got no PSK: %v", rec.keys)
	}
	if rec.keys[c.keyHex()] != 0 {
		t.Fatalf("a PSK was installed for the revoked peer, which the device does not have: %v", rec.keys)
	}
}

func TestRotatingPSKPeersSkipsProfileDevices(t *testing.T) {
	keys := rotatingPSKPeers([]dataplane.Peer{
		{PublicKey: meshKeyHex},
		{PublicKey: profileKeyHex, Profile: true},
	})
	if len(keys) != 1 || keys[0] != meshKeyHex {
		t.Fatalf("rotating peers = %v", keys)
	}
}
