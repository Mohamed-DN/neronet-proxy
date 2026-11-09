package main

import (
	"strings"
	"testing"

	"github.com/sovereign/proxy/v4/pkg/control"
)

// ADR 0029 A3: on the gateway, a profile device is a WireGuard peer with a static PSK.
// It must keep that PSK -- the epoch rotation derives keys a standard WireGuard app
// cannot compute -- and a mesh peer must never take a static PSK from the document.

const (
	meshKeyHex    = "1111111111111111111111111111111111111111111111111111111111111111"
	profileKeyHex = "2222222222222222222222222222222222222222222222222222222222222222"
	staticPSKHex  = "abababababababababababababababababababababababababababababababab"
)

func profileDoc() []control.NetmapPeer {
	return []control.NetmapPeer{
		{NodeID: "node-mesh", PublicKeyHex: meshKeyHex, AllowedIPs: []string{"100.64.40.2/32"}, KeepaliveSeconds: 25,
			PresharedKeyHex: staticPSKHex},
		{NodeID: "dev-phone", PublicKeyHex: profileKeyHex, AllowedIPs: []string{"100.64.40.9/32"}, KeepaliveSeconds: 25,
			Profile: true, PresharedKeyHex: staticPSKHex, AllowedTransports: []string{"udp"}},
	}
}

func TestProfilePeerCarriesItsStaticPSK(t *testing.T) {
	peers, dropped, err := netmapPeers(profileDoc(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(dropped) != 0 {
		t.Fatalf("dropped: %v", dropped)
	}
	byKey := map[string]string{}
	profile := map[string]bool{}
	for _, p := range peers {
		byKey[p.PublicKey] = p.PresharedKey
		profile[p.PublicKey] = p.Profile
	}
	if !profile[profileKeyHex] || profile[meshKeyHex] {
		t.Fatalf("profile flags = %v; the device peer must reach the dataplane as a profile peer, the mesh peer must not", profile)
	}
	if byKey[profileKeyHex] != staticPSKHex {
		t.Fatalf("profile device PSK = %q, want the static one", byKey[profileKeyHex])
	}
	if byKey[meshKeyHex] != "" {
		t.Fatal("a mesh peer took a static PSK from the document; its PSK is the epoch rotation's")
	}
}

func TestProfilePeerIsLeftOutOfTheRotation(t *testing.T) {
	keys := rotatingPSKPeers(profileDoc())
	if len(keys) != 1 || keys[0] != meshKeyHex {
		t.Fatalf("rotating peers = %v, want only the mesh peer", keys)
	}
}

func TestProfilePeerWithoutAUsableStaticPSKIsDropped(t *testing.T) {
	for name, psk := range map[string]string{"missing": "", "short": "abab", "not hex": strings.Repeat("zz", 32)} {
		doc := profileDoc()
		doc[1].PresharedKeyHex = psk
		peers, dropped, err := netmapPeers(doc, nil)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		for _, p := range peers {
			if p.PublicKey == profileKeyHex {
				t.Fatalf("%s: a profile device without its PSK was kept; it would handshake with no PSK at all", name)
			}
		}
		if len(dropped) != 1 || !strings.Contains(dropped[0], "dev-phone") {
			t.Fatalf("%s: dropped = %v", name, dropped)
		}
	}
}
