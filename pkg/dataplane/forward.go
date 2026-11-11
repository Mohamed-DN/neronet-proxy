package dataplane

import (
	"encoding/binary"
	"errors"
	"fmt"
	"net/netip"
	"sync"

	"github.com/sovereign/proxy/v4/pkg/acl"
)

// Forwarding on a profile gateway (ADR 0029).
//
// A profile device runs a standard WireGuard client: its only peer is the gateway and
// it routes the whole overlay there. A packet from the device to a mesh node arrives
// at the gateway decrypted, addressed to somebody else, and has to leave again
// through WireGuard towards that node; the reply takes the same way back.
//
// Where the relay happens: in this package's tun wrapper, not in an IP stack. A
// packet wireguard-go decrypts and hands to Write is, if it belongs to a profile
// device flow and is not addressed to this node, put on a queue that Read hands back
// to wireguard-go, which encrypts it for whichever peer holds the destination. This
// is the same in both modes. The alternatives were worse for this node:
//
//   - gVisor forwarding needs the netstack's *stack.Stack, which wireguard-go's
//     tun/netstack keeps unexported, so it would mean forking that package;
//   - kernel forwarding (TUN mode plus ip_forward) needs CAP_NET_ADMIN and a sysctl
//     the rootless stack nodes do not have, and would put the forwarded path outside
//     the one place where the compiled policy is enforced.
//
// Enforcement: both ends' policies are applied here, because a stock client
// enforces nothing. A packet from device D is checked against D's outbound rules
// (which records conntrack for the reply); a packet to D against D's inbound rules,
// where conntrack lets replies to D's own connections back in. The mesh node at the
// other end still applies its own inbound check on top.
//
// Source: the device can only send from its own address because wireguard-go drops
// any decrypted packet whose source is not in the sending peer's allowed IPs, and the
// gateway holds exactly the device's /32 (and /128) for its key. Forwarding sees only
// packets that already passed that check, so the source address it keys on is
// authenticated.

// errNotProfileTraffic is returned for a packet with no profile device at either end.
var errNotProfileTraffic = errors.New("dataplane: neither end is a profile device")

// errTTLExpired is returned for a forwarded packet whose hop limit ran out.
var errTTLExpired = errors.New("dataplane: forwarded packet's TTL expired")

// ForwardTable is the gateway's set of profile devices, each with the filter that
// holds its compiled policy and its connection state.
//
// A table is immutable once handed to SetForwarding; a new netmap builds a new table.
// The filters inside it are not rebuilt: the caller keeps one per device and updates
// its policy, so the conntrack of established flows survives a netmap change.
type ForwardTable struct {
	devices map[netip.Addr]*acl.NetstackFilter
}

// NewForwardTable returns an empty table.
func NewForwardTable() *ForwardTable {
	return &ForwardTable{devices: map[netip.Addr]*acl.NetstackFilter{}}
}

// AddDevice registers one address of a profile device and the filter enforcing its
// policy. A device with an IPv4 and an IPv6 address is added twice with the same
// filter.
func (t *ForwardTable) AddDevice(addr netip.Addr, nf *acl.NetstackFilter) {
	if nf == nil {
		panic("dataplane: ForwardTable.AddDevice with a nil filter")
	}
	t.devices[addr.Unmap()] = nf
}

// Len reports how many device addresses the table holds.
func (t *ForwardTable) Len() int {
	if t == nil {
		return 0
	}
	return len(t.devices)
}

// involves reports whether a profile device is at either end of p. Anything else is
// not the gateway's to relay and keeps the path it had before forwarding existed.
func (t *ForwardTable) involves(p Packet) bool {
	if _, ok := t.devices[p.Src.Unmap()]; ok {
		return true
	}
	_, ok := t.devices[p.Dst.Unmap()]
	return ok
}

// Decide applies the policy of every profile device at an end of p.
func (t *ForwardTable) Decide(p Packet) error {
	srcFilter, fromDevice := t.devices[p.Src.Unmap()]
	dstFilter, toDevice := t.devices[p.Dst.Unmap()]
	if !fromDevice && !toDevice {
		return errNotProfileTraffic
	}
	proto := toACLProtocol(p.Protocol)
	if fromDevice {
		if err := srcFilter.EvaluateOutbound4Tuple(toNetIP(p.Src), p.SrcPort, toNetIP(p.Dst), p.DstPort, proto); err != nil {
			return fmt.Errorf("from profile device %s: %w", p.Src, err)
		}
	}
	if toDevice {
		if err := dstFilter.EvaluateInbound(toNetIP(p.Src), p.SrcPort, p.DstPort, proto); err != nil {
			return fmt.Errorf("to profile device %s: %w", p.Dst, err)
		}
	}
	return nil
}

// decrementTTL lowers the IPv4 TTL or IPv6 hop limit of a packet being forwarded, as
// a router must, so a routing loop between the gateway and a peer ends instead of
// circling. The IPv4 header checksum is updated incrementally (RFC 1624, eqn. 3).
func decrementTTL(b []byte) error {
	switch b[0] >> 4 {
	case 4:
		if len(b) < ipv4MinHeaderLen {
			return errors.New("dataplane: short IPv4 header")
		}
		if b[8] <= 1 {
			return errTTLExpired
		}
		old := binary.BigEndian.Uint16(b[8:10])
		b[8]--
		updated := binary.BigEndian.Uint16(b[8:10])
		sum := uint32(^binary.BigEndian.Uint16(b[10:12])) + uint32(^old) + uint32(updated)
		for sum>>16 != 0 {
			sum = (sum & 0xffff) + (sum >> 16)
		}
		binary.BigEndian.PutUint16(b[10:12], ^uint16(sum))
		return nil
	case 6:
		if len(b) < ipv6HeaderLen {
			return errors.New("dataplane: short IPv6 header")
		}
		if b[7] <= 1 {
			return errTTLExpired
		}
		b[7]--
		return nil
	default:
		return errors.New("dataplane: not an IP packet")
	}
}

// forwardQueueLen bounds what the gateway holds between a decrypted packet and its
// re-encryption. A full queue drops, as a router's output queue does; it does not
// block wireguard-go's receive path.
const forwardQueueLen = 1024

var forwardBufPool = sync.Pool{New: func() any { b := make([]byte, 0, 2048); return &b }}

// SetForwarding installs the gateway's forwarding table. Nil or an empty table turns
// forwarding off: packets addressed elsewhere then take the path they took before
// (into the local stack, which drops them in netstack mode).
func (d *Device) SetForwarding(t *ForwardTable) {
	d.mu.Lock()
	closed := d.closed
	d.mu.Unlock()
	if closed {
		return
	}
	if t.Len() == 0 {
		d.filter.forward.Store(nil)
		return
	}
	d.filter.forward.Store(t)
	// wireguard-go may be blocked in a read of the local stack, which only returns
	// when the stack sends something. Make it send something, so the reader switches
	// to the path that also serves the forwarding queue.
	d.filter.wakeIfDirect()
}
