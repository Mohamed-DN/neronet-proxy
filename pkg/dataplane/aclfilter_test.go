package dataplane

import (
	"errors"
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

// inboundOnly is the policy a one-way allow-list rule ("the phone may open port 9999
// on this node") compiles to on the node that serves: one inbound entry and nothing in
// the outbound rules, which therefore end in default deny for the phone.
func inboundOnly(local, peer string, port uint16, extraOut ...acl.CompiledFilterRule) *acl.CompiledPeerPolicy {
	p := policyAllowing(local, peer, port)
	p.OutboundRules = extraOut
	return p
}

var (
	phoneSYN   = Packet{Version: 4, Protocol: ProtoTCP, Src: mustAddr("100.64.0.2"), Dst: mustAddr("100.64.0.1"), SrcPort: 40000, DstPort: 9999}
	nodeSYNACK = Packet{Version: 4, Protocol: ProtoTCP, Src: mustAddr("100.64.0.1"), Dst: mustAddr("100.64.0.2"), SrcPort: 9999, DstPort: 40000}
)

func TestACLFilterAnswersAFlowItsInboundRuleLetIn(t *testing.T) {
	nf := acl.NewNetstackFilter()
	nf.UpdatePolicy(inboundOnly("100.64.0.1", "100.64.0.2", 9999))
	f := NewACLFilter(nf)

	if err := f.Inbound(phoneSYN); err != nil {
		t.Fatalf("the phone's SYN to an allowed port was dropped: %v", err)
	}
	if err := f.Outbound(nodeSYNACK); err != nil {
		t.Fatalf("the node dropped its own answer to a flow its inbound rule let in: %v", err)
	}
}

func TestACLFilterAnswerNeedsTheExactReverseFlow(t *testing.T) {
	nf := acl.NewNetstackFilter()
	nf.UpdatePolicy(inboundOnly("100.64.0.1", "100.64.0.2", 9999))
	f := NewACLFilter(nf)

	// Nothing was let in yet: the node may not open anything towards the phone.
	if err := f.Outbound(nodeSYNACK); err == nil {
		t.Fatal("the node sent to the phone with no outbound rule and no flow to answer")
	}
	if err := f.Inbound(phoneSYN); err != nil {
		t.Fatalf("inbound was rejected: %v", err)
	}
	otherPort := nodeSYNACK
	otherPort.DstPort = 40001
	if err := f.Outbound(otherPort); err == nil {
		t.Fatal("a packet to another port of the phone passed as an answer")
	}
	otherSrc := nodeSYNACK
	otherSrc.SrcPort = 22
	if err := f.Outbound(otherSrc); err == nil {
		t.Fatal("a packet from another local port passed as an answer")
	}
}

func TestACLFilterExplicitDropStillBlocksTheAnswer(t *testing.T) {
	drop := acl.CompiledFilterRule{
		AllowedPeerVIP: net.ParseIP("100.64.0.2"),
		Protocol:       acl.ProtocolALL,
		PortRanges:     []acl.PortRange{{Start: 0, End: 65535}},
		Action:         acl.ActionDrop,
	}
	nf := acl.NewNetstackFilter()
	nf.UpdatePolicy(inboundOnly("100.64.0.1", "100.64.0.2", 9999, drop))
	f := NewACLFilter(nf)

	if err := f.Inbound(phoneSYN); err != nil {
		t.Fatalf("inbound was rejected: %v", err)
	}
	if err := f.Outbound(nodeSYNACK); !errors.Is(err, acl.ErrOutboundBlockedDrop) {
		t.Fatalf("an explicit outbound DROP did not drop the answer: %v", err)
	}
}

func TestACLFilterDeletingOrDroppingTheRuleCutsTheOpenFlow(t *testing.T) {
	nf := acl.NewNetstackFilter()
	nf.UpdatePolicy(inboundOnly("100.64.0.1", "100.64.0.2", 9999))
	f := NewACLFilter(nf)
	if err := f.Inbound(phoneSYN); err != nil {
		t.Fatalf("inbound was rejected: %v", err)
	}
	if err := f.Outbound(nodeSYNACK); err != nil {
		t.Fatalf("answer was rejected: %v", err)
	}

	// The rule is deleted: the phone's next packet in the open flow is dropped, so
	// answering no longer reaches anything.
	deleted := inboundOnly("100.64.0.1", "100.64.0.2", 9999)
	deleted.InboundRules = nil
	nf.UpdatePolicy(deleted)
	if err := f.Inbound(phoneSYN); !errors.Is(err, acl.ErrInboundDefaultDeny) {
		t.Fatalf("the open flow survived the deletion of its rule: %v", err)
	}

	// A DROP written in front of the rule cuts it the same way.
	dropped := inboundOnly("100.64.0.1", "100.64.0.2", 9999)
	dropped.InboundRules = append([]acl.CompiledFilterRule{{
		AllowedPeerVIP: net.ParseIP("100.64.0.2"),
		Protocol:       acl.ProtocolTCP,
		PortRanges:     []acl.PortRange{{Start: 9999, End: 9999}},
		Action:         acl.ActionDrop,
	}}, dropped.InboundRules...)
	nf.UpdatePolicy(dropped)
	if err := f.Inbound(phoneSYN); !errors.Is(err, acl.ErrInboundBlockedDrop) {
		t.Fatalf("the open flow survived a DROP for it: %v", err)
	}
}
