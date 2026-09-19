package dataplane

import (
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
func (f *ACLFilter) Outbound(p Packet) error {
	return f.nf.EvaluateOutbound4Tuple(
		toNetIP(p.Src), p.SrcPort,
		toNetIP(p.Dst), p.DstPort,
		toACLProtocol(p.Protocol),
	)
}

// Inbound applies the receiver-side check, which is the authoritative one.
func (f *ACLFilter) Inbound(p Packet) error {
	return f.nf.EvaluateInbound(
		toNetIP(p.Src), p.SrcPort,
		p.DstPort,
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
