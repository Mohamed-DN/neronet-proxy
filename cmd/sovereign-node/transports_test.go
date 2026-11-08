package main

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/sovereign/proxy/v4/pkg/control"
	"github.com/sovereign/proxy/v4/pkg/dataplane"
	"github.com/sovereign/proxy/v4/pkg/transport"
)

// Only a document that names no transport policy at all is the legacy UDP permit. A
// version this node does not implement is a policy it cannot read, and reading it as
// legacy would turn "UDP denied" into "UDP allowed" for every node built before the
// version existed.
func TestTransportPolicyVersionNeverDowngradesToUDP(t *testing.T) {
	peer := control.NetmapPeer{
		NodeID:            "node-b",
		PublicKeyHex:      strings.Repeat("ab", 32),
		Endpoints:         []string{"192.0.2.10:51820"},
		AllowedTransports: []string{transport.UDP},
	}
	cases := []struct {
		name    string
		doc     control.NetmapResponse
		wantUDP bool
	}{
		{"legacy document without a version", control.NetmapResponse{}, true},
		{"known version with an empty list", control.NetmapResponse{TransportPolicyVersion: "derp-v2", AllowedTransports: []string{}}, false},
		{"known version allowing udp", control.NetmapResponse{TransportPolicyVersion: "derp-v2", AllowedTransports: []string{transport.UDP}}, true},
		{"unknown version with an empty list", control.NetmapResponse{TransportPolicyVersion: "derp-v9", AllowedTransports: []string{}}, false},
		{"unknown version listing udp", control.NetmapResponse{TransportPolicyVersion: "derp-v9", AllowedTransports: []string{transport.UDP}}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			// Through the wire: omitempty turns an empty list into an absent one, which
			// is exactly what a node receives.
			raw, err := json.Marshal(tc.doc)
			if err != nil {
				t.Fatal(err)
			}
			var doc control.NetmapResponse
			if err := json.Unmarshal(raw, &doc); err != nil {
				t.Fatal(err)
			}
			allowed, relays, err := documentTransports(&doc)
			if err != nil {
				t.Fatalf("documentTransports: %v", err)
			}
			if got := transport.Contains(allowed, transport.UDP); got != tc.wantUDP {
				t.Fatalf("device transports %v: udp allowed=%v, want %v", allowed, got, tc.wantUDP)
			}
			if !tc.wantUDP && len(relays) != 0 {
				t.Fatalf("relays %v from a document that allows nothing", relays)
			}
			paths, err := peerTransportPaths(peer, &doc)
			if err != nil {
				t.Fatalf("peerTransportPaths: %v", err)
			}
			gotPath := false
			for _, p := range paths {
				if p.Transport == transport.UDP {
					gotPath = true
				}
			}
			if gotPath != tc.wantUDP {
				t.Fatalf("peer paths %v: udp path=%v, want %v", paths, gotPath, tc.wantUDP)
			}
		})
	}
}

// A device built without the transport multiplexer (the spike lab start, before any
// netmap) cannot enforce a transport policy. The node still advertises derp-v2, so
// the control plane relies on it: a versioned document must remove the peers rather
// than leave them reachable over plain UDP.
func TestVersionedPolicyOnADeviceWithoutTheMultiplexerCarriesNothing(t *testing.T) {
	a := newOverlayNode(t, "100.64.0.1/10")
	b := newOverlayNode(t, "100.64.0.2/10")
	managerA := managerFor(t, a)
	managerB := managerFor(t, b)

	docA := netmapFor(2, a.addr, allowAllPolicy("a", a.addr, b.addr), b.peerEntry("b"))
	docB := netmapFor(2, b.addr, allowAllPolicy("b", b.addr, a.addr), a.peerEntry("a"))
	for _, doc := range []*control.NetmapResponse{docA, docB} {
		doc.TransportPolicyVersion = "derp-v2"
		doc.AllowedTransports = nil // deny all
	}
	_ = managerA.Apply(docA, time.Now())
	_ = managerB.Apply(docB, time.Now())

	echo, err := dataplane.ListenEcho(b.dev, echoPort, nil)
	if err != nil {
		t.Fatalf("starting the echo on B: %v", err)
	}
	defer echo.Close()

	if err := echoOnce(t, a, b.addr, echoPort, 3*time.Second); err == nil {
		t.Fatal("TCP crossed over UDP although the versioned policy allows no transport")
	}
	if got := peerCount(t, a.dev); got != 0 {
		t.Fatalf("A still holds %d peer(s) under a policy it cannot enforce", got)
	}
}

// The per-peer list narrows the installation list; an absent per-peer list under a
// versioned policy is deny, not "inherit".
func TestVersionedPolicyNeedsThePeerToAllowTheTransport(t *testing.T) {
	doc := &control.NetmapResponse{TransportPolicyVersion: "derp-v2", AllowedTransports: []string{transport.UDP, transport.DERP},
		RelayCandidates: []control.RelayCandidate{{RelayID: "relay-a", URL: "https://relay-a.test/derp", Capability: "derp-v2"}}}
	key := strings.Repeat("cd", 32)
	base := control.NetmapPeer{NodeID: "node-c", PublicKeyHex: key, Endpoints: []string{"192.0.2.11:51820"},
		RelayHomes: []control.RelayHome{{RelayID: "relay-a"}, {RelayID: "relay-unknown"}}}

	none, err := peerTransportPaths(base, doc)
	if err != nil || len(none) != 0 {
		t.Fatalf("peer without allowed_transports got paths %v (err %v)", none, err)
	}

	derpOnly := base
	derpOnly.AllowedTransports = []string{transport.DERP}
	paths, err := peerTransportPaths(derpOnly, doc)
	if err != nil {
		t.Fatal(err)
	}
	if len(paths) != 1 || paths[0].Transport != transport.DERP || paths[0].Address != "relay-a/"+key {
		t.Fatalf("DERP-only peer paths %v, want one path through relay-a", paths)
	}

	future := *doc
	future.TransportPolicyVersion = "derp-v9"
	if paths, _ := peerTransportPaths(derpOnly, &future); len(paths) != 0 {
		t.Fatalf("unknown version produced paths %v", paths)
	}
}
