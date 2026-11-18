//go:build awg

package dataplane

import (
	"errors"
	"net/netip"
	"testing"
	"time"
)

func TestStartAWGRefusesMissingAndInvalidParameters(t *testing.T) {
	g := newTestNode(t, gwAddr+"/10", nil)

	if err := g.dev.StartAWG(AWGConfig{}); !errors.Is(err, ErrAWGParams) {
		t.Fatalf("an empty configuration started a device or failed oddly: %v", err)
	}
	bad := validAWGParams()
	bad.H1 = "1-4" // WireGuard's own types
	if err := g.dev.StartAWG(AWGConfig{Params: bad}); !errors.Is(err, ErrAWGParams) {
		t.Fatalf("a header range that touches the standard message types started a device: %v", err)
	}
	if g.dev.AWGRunning() {
		t.Fatal("the device runs although both starts were refused")
	}
	if _, err := g.dev.AWGPort(); !errors.Is(err, ErrAWGNotRunning) {
		t.Fatalf("AWGPort without a device: %v", err)
	}
}

func TestSetPeersPutsAKeyOnOneDeviceOnly(t *testing.T) {
	g := newTestNode(t, gwAddr+"/10", nil)
	if err := g.dev.StartAWG(AWGConfig{Params: testAWGParams()}); err != nil {
		t.Fatal(err)
	}
	other := newTestNode(t, otherAddr+"/10", nil)
	device := Peer{
		PublicKey:    other.peerEntry().PublicKey,
		AllowedIPs:   []netip.Prefix{prefix32(awgClientAddr)},
		PresharedKey: testPSK,
		Profile:      true,
	}

	plain, onAWG := device, device
	onAWG.AWG = true
	if err := g.dev.SetPeers([]Peer{plain, onAWG}); err == nil {
		t.Fatal("a key named on both devices was accepted")
	}

	// Moving the key from one device to the other leaves it on exactly one.
	if err := g.dev.SetPeers([]Peer{onAWG}); err != nil {
		t.Fatal(err)
	}
	if _, onMain := g.dev.peerKeys[device.PublicKey]; onMain || len(g.dev.awg.peerKeys) != 1 {
		t.Fatal("an AmneziaWG peer is also on the WireGuard device, or missing from the AmneziaWG one")
	}
	if err := g.dev.SetPeers([]Peer{plain}); err != nil {
		t.Fatal(err)
	}
	if _, onMain := g.dev.peerKeys[device.PublicKey]; !onMain || len(g.dev.awg.peerKeys) != 0 {
		t.Fatal("after moving back the key is still on the AmneziaWG device, or not on the WireGuard one")
	}
}

func TestSetPeersRefusesAnAWGPeerItCannotServe(t *testing.T) {
	g := newTestNode(t, gwAddr+"/10", nil)
	other := newTestNode(t, otherAddr+"/10", nil)
	device := Peer{
		PublicKey:    other.peerEntry().PublicKey,
		AllowedIPs:   []netip.Prefix{prefix32(awgClientAddr)},
		PresharedKey: testPSK,
		Profile:      true,
		AWG:          true,
	}
	if err := g.dev.SetPeers([]Peer{device}); !errors.Is(err, ErrAWGNotRunning) {
		t.Fatalf("an AmneziaWG peer with no AmneziaWG device: %v", err)
	}
	if err := g.dev.StartAWG(AWGConfig{Params: testAWGParams()}); err != nil {
		t.Fatal(err)
	}
	mesh := device
	mesh.Profile = false
	if err := g.dev.SetPeers([]Peer{mesh}); err == nil {
		t.Fatal("a mesh peer was put on the AmneziaWG device")
	}
	wide := device
	wide.AllowedIPs = []netip.Prefix{netip.MustParsePrefix("100.64.0.0/24")}
	if err := g.dev.SetPeers([]Peer{wide}); err == nil {
		t.Fatal("an AmneziaWG peer holding a whole prefix was accepted")
	}
}

func TestAWGPeerHandshakeIsVisibleToTelemetry(t *testing.T) {
	fx := newAWGFixture(t, testAWGParams(), testAWGParams(), allowAllPolicy(), true)
	if !fx.client.pingWithin(netip.MustParseAddr(meshAddr), 15*time.Second) {
		t.Fatal("no answer through the gateway")
	}
	peers, err := fx.g.dev.Peers()
	if err != nil {
		t.Fatal(err)
	}
	for _, p := range peers {
		if p.PublicKey == fx.client.pub {
			if p.LastHandshake.IsZero() || p.RxBytes == 0 || p.TxBytes == 0 {
				t.Fatalf("the AmneziaWG peer's counters are empty: %+v", p)
			}
			return
		}
	}
	t.Fatal("the AmneziaWG peer is missing from the gateway's peer status")
}

// New parameters mean a new device: the old client stops working and a client built with
// the new values works, with the same peer set re-applied.
func TestAWGParametersCanBeRotated(t *testing.T) {
	fx := newAWGFixture(t, testAWGParams(), testAWGParams(), allowAllPolicy(), true)
	mesh := netip.MustParseAddr(meshAddr)
	if !fx.client.pingWithin(mesh, 15*time.Second) {
		t.Fatal("no answer before the rotation")
	}

	fx.g.dev.StopAWG()
	if fx.g.dev.AWGRunning() {
		t.Fatal("the device still runs after StopAWG")
	}
	if fx.client.pingWithin(mesh, 3*time.Second) {
		t.Fatal("the old client still gets through after the device was stopped")
	}

	rotated := testAWGParams()
	rotated.S1, rotated.H1 = 53, "1500000000-1500000500"
	if err := fx.g.dev.StartAWG(AWGConfig{Params: rotated}); err != nil {
		t.Fatal(err)
	}
	port, _ := fx.g.dev.AWGPort()
	device := Peer{PublicKey: fx.client.pub, AllowedIPs: []netip.Prefix{prefix32(awgClientAddr)}, PresharedKey: testPSK, Profile: true, AWG: true}
	if err := fx.g.dev.SetPeers([]Peer{fx.n.peerEntry(), device}); err != nil {
		t.Fatal(err)
	}
	fresh := newAWGTestClient(t, rotated, fx.g.keys.PublicKey, port, testPSK)
	// A new client has a new key: register it in place of the old one.
	device.PublicKey = fresh.pub
	if err := fx.g.dev.SetPeers([]Peer{fx.n.peerEntry(), device}); err != nil {
		t.Fatal(err)
	}
	gwForMesh := fx.g.peerEntry()
	gwForMesh.AllowedIPs = []netip.Prefix{prefix32(gwAddr), prefix32(awgClientAddr)}
	if err := fx.n.dev.SetPeers([]Peer{gwForMesh}); err != nil {
		t.Fatal(err)
	}
	if !fresh.pingWithin(mesh, 15*time.Second) {
		t.Fatal("a client with the rotated parameters got no answer")
	}
}
