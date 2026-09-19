package dataplane

import (
	"net"
	"testing"

	"github.com/sovereign/proxy/v4/pkg/acl"
)

func policyAllowing(local, peer string, port uint16) *acl.CompiledPeerPolicy {
	rule := acl.CompiledFilterRule{
		AllowedPeerVIP: net.ParseIP(peer),
		Protocol:       acl.ProtocolTCP,
		PortRanges:     []acl.PortRange{{Start: port, End: port}},
		Action:         acl.ActionAccept,
	}
	return &acl.CompiledPeerPolicy{
		NodeID:        "node-under-test",
		OverlayIPv4:   net.ParseIP(local),
		InboundRules:  []acl.CompiledFilterRule{rule},
		OutboundRules: []acl.CompiledFilterRule{rule},
		Epoch:         1,
	}
}

func TestACLFilterAppliesTheLoadedPolicy(t *testing.T) {
	nf := acl.NewNetstackFilter()
	nf.UpdatePolicy(policyAllowing("100.64.0.1", "100.64.0.2", 9999))
	f := NewACLFilter(nf)

	allowed := Packet{Version: 4, Protocol: ProtoTCP, Src: mustAddr("100.64.0.1"), Dst: mustAddr("100.64.0.2"), SrcPort: 40000, DstPort: 9999}
	if err := f.Outbound(allowed); err != nil {
		t.Fatalf("a packet the policy accepts was rejected: %v", err)
	}

	wrongPort := allowed
	wrongPort.DstPort = 22
	if err := f.Outbound(wrongPort); err == nil {
		t.Fatal("a packet to a port no rule covers was accepted")
	}

	wrongPeer := allowed
	wrongPeer.Dst = mustAddr("100.64.0.9")
	if err := f.Outbound(wrongPeer); err == nil {
		t.Fatal("a packet to a peer no rule covers was accepted")
	}
}

func TestACLFilterDefaultDeniesWithNoPolicy(t *testing.T) {
	f := NewACLFilter(acl.NewNetstackFilter())

	p := Packet{Version: 4, Protocol: ProtoTCP, Src: mustAddr("100.64.0.2"), Dst: mustAddr("100.64.0.1"), SrcPort: 40000, DstPort: 9999}
	if err := f.Inbound(p); err == nil {
		t.Fatal("a node with no policy loaded accepted inbound traffic")
	}
	if err := f.Outbound(p); err == nil {
		t.Fatal("a node with no policy loaded accepted outbound traffic")
	}
}

func TestACLFilterInboundFollowsConntrack(t *testing.T) {
	nf := acl.NewNetstackFilter()
	nf.UpdatePolicy(policyAllowing("100.64.0.1", "100.64.0.2", 9999))
	f := NewACLFilter(nf)

	// The return traffic of an allowed outbound connection arrives on an ephemeral
	// port that no inbound rule names. Without the conntrack state recorded on the
	// way out, every answer would be dropped.
	out := Packet{Version: 4, Protocol: ProtoTCP, Src: mustAddr("100.64.0.1"), Dst: mustAddr("100.64.0.2"), SrcPort: 40000, DstPort: 9999}
	if err := f.Outbound(out); err != nil {
		t.Fatalf("outbound was rejected: %v", err)
	}

	back := Packet{Version: 4, Protocol: ProtoTCP, Src: mustAddr("100.64.0.2"), Dst: mustAddr("100.64.0.1"), SrcPort: 9999, DstPort: 40000}
	if err := f.Inbound(back); err != nil {
		t.Fatalf("the answer to an allowed connection was dropped: %v", err)
	}
}

func TestToACLProtocol(t *testing.T) {
	for proto, want := range map[uint8]acl.Protocol{
		ProtoTCP:    acl.ProtocolTCP,
		ProtoUDP:    acl.ProtocolUDP,
		ProtoICMPv4: acl.ProtocolICMP,
		ProtoICMPv6: acl.ProtocolICMP,
		132:         acl.ProtocolALL,
	} {
		if got := toACLProtocol(proto); got != want {
			t.Errorf("toACLProtocol(%d) = %s, want %s", proto, got, want)
		}
	}
}
