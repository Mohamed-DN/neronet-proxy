package main

import (
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/sovereign/proxy/v4/pkg/dataplane"
)

// refuse makes the manager's data plane reject the next n peer-set changes, then
// pass every later one to the real WireGuard device.
func refuse(m *netmapManager, n int) {
	var mu sync.Mutex
	real := m.setPeers
	m.setPeers = func(peers []dataplane.Peer) error {
		mu.Lock()
		failing := n > 0
		if failing {
			n--
		}
		mu.Unlock()
		if failing {
			return errors.New("injected: the data plane refused the peer set")
		}
		return real(peers)
	}
}

// Fail-closed is a removal the node must actually carry out. With the data plane
// refusing it once, the node used to record itself as failed closed anyway: every
// later tick returned early and the peer stayed reachable past the staleness bound
// for as long as the control plane was gone.
func TestStalenessRetriesARemovalTheDataPlaneRefused(t *testing.T) {
	a := newOverlayNode(t, "100.64.0.31/10")
	b := newOverlayNode(t, "100.64.0.32/10")
	m := managerFor(t, a)

	netmap := netmapFor(7, a.addr, allowAllPolicy("a", a.addr, b.addr), b.peerEntry("b"))
	netmap.MaxStalenessSeconds = 60
	confirmed := time.Now().Add(-30 * time.Second)
	netmap.GeneratedAtUnix = confirmed.Unix()
	if err := m.Apply(netmap, time.Now()); err != nil {
		t.Fatal(err)
	}
	m.Confirm(confirmed)

	refuse(m, 1)
	past := time.Now().Add(31 * time.Second)
	if m.EnforceStaleness(past) {
		t.Fatal("reported failed closed although the data plane refused to remove the peer")
	}
	if m.FailedClosed() {
		t.Fatal("recorded as failed closed with the peer still in the data plane")
	}
	if got := peerCount(t, a.dev); got != 1 {
		t.Fatalf("%d peer(s) after a refused removal, want the 1 still there", got)
	}

	// The next tick tries again and this time the data plane accepts.
	if !m.EnforceStaleness(past.Add(time.Second)) {
		t.Fatal("the next tick did not retry the refused fail-closed removal")
	}
	if got := peerCount(t, a.dev); got != 0 {
		t.Fatalf("%d peer(s) still reachable past the staleness bound", got)
	}
	if !m.FailedClosed() {
		t.Fatal("not recorded as failed closed after the removal")
	}
}

// A revocation the data plane refused used to be recorded as applied: the heartbeat
// delivers the same revoked keys on every beat, they were no longer new, and the
// revoked peer kept its tunnel until the next netmap document.
func TestRevocationRetriesARemovalTheDataPlaneRefused(t *testing.T) {
	a := newOverlayNode(t, "100.64.0.33/10")
	b := newOverlayNode(t, "100.64.0.34/10")
	m := managerFor(t, a)

	if err := m.Apply(netmapFor(8, a.addr, allowAllPolicy("a", a.addr, b.addr), b.peerEntry("b")), time.Now()); err != nil {
		t.Fatal(err)
	}
	if got := peerCount(t, a.dev); got != 1 {
		t.Fatalf("%d peer(s) before the revocation, want 1", got)
	}

	refuse(m, 1)
	m.ApplyRevocations([]string{b.keyHex()}, 8)
	if got := peerCount(t, a.dev); got != 1 {
		t.Fatalf("%d peer(s) after a refused revocation, want the 1 still there", got)
	}

	// The next heartbeat carries the same revoked key: the removal is retried.
	m.ApplyRevocations([]string{b.keyHex()}, 8)
	if got := peerCount(t, a.dev); got != 0 {
		t.Fatalf("the revoked peer is still in the data plane after the next heartbeat (%d peer(s))", got)
	}

	// Once applied, a repeated revocation is a no-op again.
	refuse(m, 1)
	m.ApplyRevocations([]string{b.keyHex()}, 8)
	if got := peerCount(t, a.dev); got != 0 {
		t.Fatalf("%d peer(s) after a repeated revocation", got)
	}
}
