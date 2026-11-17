package acl

import (
	"net"
	"testing"
)

func reachRule(peer string, proto Protocol, start, end uint16, action Action) CompiledFilterRule {
	return CompiledFilterRule{AllowedPeerVIP: net.ParseIP(peer), Protocol: proto, PortRanges: []PortRange{{Start: start, End: end}}, Action: action}
}

func TestCanOpenToFollowsTheOutboundRulesFirstMatchWithoutRecordingState(t *testing.T) {
	nf := NewNetstackFilter()
	laptop, tablet, drop := net.ParseIP("100.64.0.9"), net.ParseIP("100.64.0.11"), net.ParseIP("100.64.0.13")
	if nf.CanOpenTo(laptop) {
		t.Fatal("no policy loaded must be default deny")
	}
	nf.UpdatePolicy(&CompiledPeerPolicy{OutboundRules: []CompiledFilterRule{
		reachRule("100.64.0.9", ProtocolTCP, 22, 22, ActionAccept),
		// A DROP over the whole range first shadows the later ACCEPT.
		reachRule("100.64.0.13", ProtocolALL, 1, 65535, ActionDrop),
		reachRule("100.64.0.13", ProtocolTCP, 443, 443, ActionAccept),
	}})
	if !nf.CanOpenTo(laptop) {
		t.Error("an accept rule for one port must make the destination reachable")
	}
	if nf.CanOpenTo(tablet) {
		t.Error("a destination with no rule must not be reachable")
	}
	if nf.CanOpenTo(drop) {
		t.Error("an ACCEPT shadowed by an earlier DROP must not count")
	}
	if n := nf.ConntrackCount(); n != 0 {
		t.Errorf("the reachability check recorded %d conntrack entries, want 0", n)
	}
}

func TestCanBeOpenedByFollowsTheInboundRules(t *testing.T) {
	nf := NewNetstackFilter()
	nf.UpdatePolicy(&CompiledPeerPolicy{InboundRules: []CompiledFilterRule{
		reachRule("100.64.0.3", ProtocolUDP, 53, 53, ActionAccept),
	}})
	if !nf.CanBeOpenedBy(net.ParseIP("100.64.0.3")) {
		t.Error("an inbound accept must make the source allowed")
	}
	if nf.CanBeOpenedBy(net.ParseIP("100.64.0.4")) {
		t.Error("a source with no inbound rule must not be allowed")
	}
}
