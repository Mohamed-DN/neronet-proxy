package dataplane

import (
	"errors"
	"net"
	"net/netip"

	"github.com/sovereign/proxy/v4/pkg/acl"
)

// ACLFilter enforces the compiled policy the control plane already delivers on the
// packets crossing the tunnel.
//
// The node has loaded that policy since before this package existed and never
// applied it to anything: pkg/acl was evaluated by nobody on the traffic path. This
// is the adapter that puts it there, at the only point where every packet of both
// directions is in plaintext.
type ACLFilter struct {
	nf *acl.NetstackFilter
}

// NewACLFilter wraps the filter the node keeps in sync with the control plane.
// Passing nil is a programming error rather than a permissive default: a filter
// that allows everything must be requested by leaving Config.Filter nil.
func NewACLFilter(nf *acl.NetstackFilter) *ACLFilter {
	if nf == nil {
		panic("dataplane: NewACLFilter called with a nil ACL filter")
	}
	return &ACLFilter{nf: nf}
}

// Outbound applies the sender-side check.
//
// The node may answer a flow its inbound rules let in although no outbound rule names
// the other end: a one-way allow-list rule (the phone may open this node's port)
// compiles to an inbound entry here and nothing in the outbound rules, and without
// this the node's answers would meet default deny. Only default deny gives way; an
// explicit DROP still drops the answer. This is the rule the profile gateway applies
// to a device's answers (forward.go).
func (f *ACLFilter) Outbound(p Packet) error {
	src, dst, proto := toNetIP(p.Src), toNetIP(p.Dst), toACLProtocol(p.Protocol)
	err := f.nf.EvaluateOutbound4Tuple(src, p.SrcPort, dst, p.DstPort, proto)
	if errors.Is(err, acl.ErrOutboundDefaultDeny) && f.nf.IsAnswer(src, p.SrcPort, dst, p.DstPort, proto) {
		return nil
	}
	return err
}

// Inbound applies the receiver-side check, which is the authoritative one. A packet a
// rule (not conntrack) accepts makes its exact reverse an answer Outbound lets out for
// as long as the flow keeps arriving; deleting the rule or writing a DROP for it drops
// the flow's next packet here.
func (f *ACLFilter) Inbound(p Packet) error {
	return f.nf.EvaluateInboundAnswerable(
		toNetIP(p.Src), p.SrcPort,
		toNetIP(p.Dst), p.DstPort,
		toACLProtocol(p.Protocol),
	)
}

func toNetIP(a netip.Addr) net.IP {
	if !a.IsValid() {
		return nil
	}
	return net.IP(a.AsSlice())
}

// toACLProtocol maps an IP protocol number onto the vocabulary pkg/acl compiles
// rules in. An unrecognised protocol maps to ALL, which matches only a rule that
// was written to cover every protocol; it never invents a TCP or UDP match.
func toACLProtocol(proto uint8) acl.Protocol {
	switch proto {
	case ProtoTCP:
		return acl.ProtocolTCP
	case ProtoUDP:
		return acl.ProtocolUDP
	case ProtoICMPv4, ProtoICMPv6:
		return acl.ProtocolICMP
	default:
		return acl.ProtocolALL
	}
}
