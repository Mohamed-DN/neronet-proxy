package main

import (
	"testing"
	"time"

	"github.com/sovereign/proxy/v4/pkg/control"
	"github.com/sovereign/proxy/v4/pkg/dataplane"
)

// A stock WireGuard app never heartbeats, so the gateway's own device state is the
// only evidence the console has that a profile device is connected (ADR 0029). The
// gateway reports it on its authenticated heartbeat as a peer path observation.

// noPaths is the mux view of a gateway: a profile device has no declared path, and
// nothing is confirmed on one.
type noPaths struct{}

func (noPaths) PeerPaths(string) []string      { return nil }
func (noPaths) PeerAllows(string, string) bool { return false }

func TestGatewayReportsAProfileDevicesHandshakeAndCounters(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	handshake := now.Add(-40 * time.Second)
	statuses := []dataplane.PathStatus{
		{PeerStatus: dataplane.PeerStatus{PublicKey: profileKeyHex, Endpoint: "udp://198.51.100.7:40000",
			LastHandshake: handshake, RxBytes: 4096, TxBytes: 8192}},
		{PeerStatus: dataplane.PeerStatus{PublicKey: meshKeyHex}},
	}

	got := peerPathReport(profileDoc(), nil, false, statuses, noPaths{}, now)

	byID := map[string]control.PeerPathObservation{}
	for _, o := range got {
		byID[o.PeerID] = o
	}
	phone, ok := byID["dev-phone"]
	if !ok {
		t.Fatalf("no observation for the profile device: %+v", got)
	}
	if phone.LastHandshakeUnix == nil || *phone.LastHandshakeUnix != handshake.Unix() {
		t.Fatalf("profile handshake = %v, want %d", phone.LastHandshakeUnix, handshake.Unix())
	}
	if phone.WGRxBytes != "4096" || phone.WGTxBytes != "8192" {
		t.Fatalf("profile counters = %s/%s, want 4096/8192", phone.WGRxBytes, phone.WGTxBytes)
	}
	// A profile device has no declared path by design; "the policy has no candidate"
	// would be a false claim about it.
	if phone.State != "profile" || phone.Reason != "" {
		t.Fatalf("profile state = %q/%q, want profile with no reason", phone.State, phone.Reason)
	}
	mesh := byID["node-mesh"]
	if mesh.LastHandshakeUnix != nil {
		t.Fatalf("a peer that never handshook reported a handshake: %d", *mesh.LastHandshakeUnix)
	}
	if mesh.State != "no_path" {
		t.Fatalf("mesh peer without paths: state %q, want no_path", mesh.State)
	}
}

func TestGatewayReportsNothingForARevokedOrUnknownPeer(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	statuses := []dataplane.PathStatus{
		{PeerStatus: dataplane.PeerStatus{PublicKey: profileKeyHex, LastHandshake: now}},
		{PeerStatus: dataplane.PeerStatus{PublicKey: "3333333333333333333333333333333333333333333333333333333333333333", LastHandshake: now}},
	}
	got := peerPathReport(profileDoc(), map[string]uint64{profileKeyHex: 1}, false, statuses, noPaths{}, now)
	if len(got) != 0 {
		t.Fatalf("reported %+v; a revoked or unknown key must not be named", got)
	}
	if got := peerPathReport(profileDoc(), nil, true, statuses, noPaths{}, now); len(got) != 0 {
		t.Fatalf("a fail-closed node reported %+v", got)
	}
}
