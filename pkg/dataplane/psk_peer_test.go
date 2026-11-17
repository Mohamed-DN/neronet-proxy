package dataplane

import (
	"strings"
	"testing"
)

// D24: a pre-shared key is only ever installed for a peer the device has. wireguard-go
// would otherwise create the peer from the UAPI line.
func TestUpdatePeerPSKRefusesAPeerTheDeviceDoesNotHave(t *testing.T) {
	dev, _ := muxNode(t)
	have := meshPeer(t, "100.64.0.2/32", "127.0.0.1:41001")
	missing := meshPeer(t, "100.64.0.3/32", "127.0.0.1:41002")
	if err := dev.SetPeers([]Peer{have}); err != nil {
		t.Fatal(err)
	}
	var requests []string
	dev.ipcSet = func(r string) error { requests = append(requests, r); return nil }
	psk := strings.Repeat("ab", 32)

	if err := dev.UpdatePeerPSK(missing.PublicKey, psk); err == nil {
		t.Fatal("a PSK was accepted for a peer the device does not have")
	}
	if len(requests) != 0 {
		t.Fatalf("a UAPI request was issued for a missing peer: %q", requests)
	}
	if err := dev.UpdatePeerPSK(strings.ToUpper(have.PublicKey), psk); err != nil {
		t.Fatalf("a present peer was refused: %v", err)
	}
	if len(requests) != 1 {
		t.Fatalf("requests = %d, want 1", len(requests))
	}

	// A peer that was just removed is refused too.
	if err := dev.SetPeers(nil); err != nil {
		t.Fatal(err)
	}
	requests = nil
	if err := dev.UpdatePeerPSK(have.PublicKey, psk); err == nil || len(requests) != 0 {
		t.Fatalf("a removed peer got a PSK: err=%v requests=%q", err, requests)
	}
}
