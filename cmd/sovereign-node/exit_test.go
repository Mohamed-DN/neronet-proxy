package main

import (
	"net/netip"
	"testing"

	"github.com/sovereign/proxy/v4/pkg/control"
	"github.com/sovereign/proxy/v4/pkg/dataplane"
)

func exitDoc() (*control.NetmapResponse, []dataplane.Peer) {
	doc := &control.NetmapResponse{
		Peers: []control.NetmapPeer{
			{NodeID: "node-exit", PublicKeyHex: "aa", AllowedIPs: []string{"100.64.0.2/32", "0.0.0.0/0", "::/0"}},
			{NodeID: "node-subnet", PublicKeyHex: "bb", AllowedIPs: []string{"100.64.0.5/32", "10.20.0.0/16"}},
			{NodeID: "dev-self", PublicKeyHex: "cc", Profile: true, AllowedIPs: []string{"100.64.0.3/32"},
				Exit: &control.NetmapExit{Via: "self", NodeID: "node-gw"}},
			{NodeID: "dev-mesh", PublicKeyHex: "dd", Profile: true, AllowedIPs: []string{"100.64.0.4/32"},
				Exit: &control.NetmapExit{Via: "mesh", NodeID: "node-exit", InternetRules: []control.InternetRule{
					{CIDR: "198.51.100.0/24", Protocol: "ALL", PortStart: 0, PortEnd: 65535, Action: "DROP"}}}},
			{NodeID: "dev-other-exit", PublicKeyHex: "ee", Profile: true, AllowedIPs: []string{"100.64.0.6/32"},
				Exit: &control.NetmapExit{Via: "mesh", NodeID: "node-elsewhere"}},
			{NodeID: "dev-none", PublicKeyHex: "ff", Profile: true, AllowedIPs: []string{"100.64.0.7/32"}},
		},
		ExitClients: []control.ExitClient{{NodeID: "dev-behind", AllowedIPs: []string{"100.64.0.9/32"}, AllowLAN: true}},
	}
	var kept []dataplane.Peer
	for _, p := range doc.Peers {
		dp := dataplane.Peer{PublicKey: p.PublicKeyHex, Profile: p.Profile}
		for _, a := range p.AllowedIPs {
			dp.AllowedIPs = append(dp.AllowedIPs, netip.MustParsePrefix(a))
		}
		kept = append(kept, dp)
	}
	return doc, kept
}

func viaOf(t *testing.T, tab *dataplane.EgressTable, addr string) dataplane.EgressVia {
	t.Helper()
	c, ok := tab.Client(netip.MustParseAddr(addr))
	if !ok {
		t.Fatalf("%s is not an exit client", addr)
	}
	return c.Via
}

func TestEgressTableFromTheDocument(t *testing.T) {
	doc, kept := exitDoc()
	tab, _ := egressTable(doc, kept, true)
	if got := viaOf(t, tab, "100.64.0.3"); got != dataplane.EgressLocal {
		t.Errorf("device whose exit is this gateway: %v", got)
	}
	if got := viaOf(t, tab, "100.64.0.4"); got != dataplane.EgressMesh {
		t.Errorf("device whose exit holds the default route: %v", got)
	}
	if got := viaOf(t, tab, "100.64.0.6"); got != dataplane.EgressNone {
		t.Errorf("device whose exit is not the default-route holder: %v", got)
	}
	if got := viaOf(t, tab, "100.64.0.9"); got != dataplane.EgressLocal {
		t.Errorf("client behind another node: %v", got)
	}
	if _, ok := tab.Client(netip.MustParseAddr("100.64.0.7")); ok {
		t.Error("a device with no exit became an exit client")
	}
	c, _ := tab.Client(netip.MustParseAddr("100.64.0.4"))
	if len(c.Rules) != 1 || c.Rules[0].Accept || c.Rules[0].PortHi != 65535 {
		t.Errorf("internet rules: %+v", c.Rules)
	}
}

func TestEgressTableWithoutConsentNeverDialsLocally(t *testing.T) {
	doc, kept := exitDoc()
	tab, _ := egressTable(doc, kept, false)
	for _, a := range []string{"100.64.0.3", "100.64.0.9"} {
		if got := viaOf(t, tab, a); got != dataplane.EgressNone {
			t.Errorf("%s leaves from a node started without -enable-exit: %v", a, got)
		}
	}
	if tab.HasLocal() {
		t.Error("a node without consent builds a local exit")
	}
}

func TestEgressTableExitDownMeansNoExit(t *testing.T) {
	doc, kept := exitDoc()
	// The exit is gone from the peer set (stopped, quarantined or revoked).
	tab, _ := egressTable(doc, kept[1:], true)
	if got := viaOf(t, tab, "100.64.0.4"); got != dataplane.EgressNone {
		t.Errorf("device whose exit left the peer set: %v", got)
	}
}

func TestInternetRuleThatCannotBeReadDropsEverything(t *testing.T) {
	rules := internetRules([]control.InternetRule{{CIDR: "not a cidr", Action: "ACCEPT"}})
	if len(rules) != 2 || rules[0].Accept || rules[1].Accept {
		t.Fatalf("got %+v", rules)
	}
}
