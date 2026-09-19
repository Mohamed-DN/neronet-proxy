package dataplane

import (
	"encoding/binary"
	"fmt"
	"net/netip"
	"sync"
	"sync/atomic"

	"golang.zx2c4.com/wireguard/tun"
)

// IP protocol numbers this package understands. Anything else is carried with
// zero ports and left to the filter to decide on.
const (
	ProtoICMPv4 uint8 = 1
	ProtoTCP    uint8 = 6
	ProtoUDP    uint8 = 17
	ProtoICMPv6 uint8 = 58
)

// Packet is the part of an IP packet an access decision is made on.
type Packet struct {
	Version  uint8
	Protocol uint8
	Src      netip.Addr
	Dst      netip.Addr
	SrcPort  uint16
	DstPort  uint16
	// Fragment is true for a non-first IP fragment, where the transport header is
	// absent and the ports are therefore unknown.
	Fragment bool
}

func (p Packet) String() string {
	return fmt.Sprintf("%s:%d -> %s:%d proto %d", p.Src, p.SrcPort, p.Dst, p.DstPort, p.Protocol)
}

// PacketFilter decides what crosses the tunnel.
//
// It sits on both sides on purpose: the architecture puts the authoritative check on
// the receiving node, on packets that have already been decrypted, and repeats it on
// the sender so a node with a stale or tampered policy still cannot emit traffic it
// is not entitled to.
//
// A non-nil error drops the packet. The error is counted and, for the inbound
// direction, never sent back to the peer: a filter that answered would tell an
// unauthorised caller which peers and ports exist.
type PacketFilter interface {
	// Outbound is called on a packet leaving this node, before encryption.
	Outbound(p Packet) error
	// Inbound is called on a decrypted packet from a peer, before the local stack
	// sees it.
	Inbound(p Packet) error
}

// FilterStats counts what was dropped. Every number is a count of real packets;
// none of them is estimated.
type FilterStats struct {
	OutboundDropped uint64
	InboundDropped  uint64
	// MalformedDropped counts packets too short or too strange to parse. They are
	// dropped only when a filter is installed: with no filter the device is a plain
	// pipe and parsing is not its business.
	MalformedDropped uint64
}

// filteredTUN wraps the tun.Device so every packet crossing the tunnel passes the
// filter. Both modes get enforcement from the same code because both go through a
// tun.Device: this is the one point where the plaintext of every direction is
// visible in one place.
type filteredTUN struct {
	tun.Device
	filter PacketFilter

	outboundDropped  atomic.Uint64
	inboundDropped   atomic.Uint64
	malformedDropped atomic.Uint64

	closeOnce sync.Once
	closeErr  error
}

// Close is idempotent. The underlying gVisor device closes channels without
// guarding against a second call, and both wireguard-go's shutdown and the owner of
// the device reach it, so an unguarded Close panics at every teardown.
func (f *filteredTUN) Close() error {
	f.closeOnce.Do(func() { f.closeErr = f.Device.Close() })
	return f.closeErr
}

func newFilteredTUN(dev tun.Device, filter PacketFilter) *filteredTUN {
	return &filteredTUN{Device: dev, filter: filter}
}

func (f *filteredTUN) stats() FilterStats {
	return FilterStats{
		OutboundDropped:  f.outboundDropped.Load(),
		InboundDropped:   f.inboundDropped.Load(),
		MalformedDropped: f.malformedDropped.Load(),
	}
}

// Read hands wireguard-go the packets the local stack wants to send. Packets the
// filter rejects are removed before wireguard-go can see them, so a denied flow is
// never encrypted and never reaches the wire.
//
// Rejected packets are compacted out by copying the surviving ones down rather than
// by swapping slice entries: wireguard-go pairs each buffer with a queue element by
// index, and reordering the buffers would make an element point into another
// element's memory.
func (f *filteredTUN) Read(bufs [][]byte, sizes []int, offset int) (int, error) {
	n, err := f.Device.Read(bufs, sizes, offset)
	if f.filter == nil || n == 0 {
		return n, err
	}

	kept := 0
	for i := 0; i < n; i++ {
		raw := bufs[i][offset : offset+sizes[i]]
		if !f.allow(raw, true) {
			continue
		}
		if kept != i {
			copy(bufs[kept][offset:], raw)
			sizes[kept] = sizes[i]
		}
		kept++
	}
	return kept, err
}

// Write delivers decrypted packets to the local stack. Rejected packets are left
// out of the slice handed downwards; the caller's slice is not modified, because it
// owns the buffers behind it.
func (f *filteredTUN) Write(bufs [][]byte, offset int) (int, error) {
	if f.filter == nil || len(bufs) == 0 {
		return f.Device.Write(bufs, offset)
	}

	allowed := bufs
	filtering := false
	// The first rejected packet is where the caller's slice stops being usable as
	// is, so the copy is made then and not before.
	startFiltering := func(i int) {
		if !filtering {
			filtering = true
			allowed = make([][]byte, 0, len(bufs))
			allowed = append(allowed, bufs[:i]...)
		}
	}

	for i, b := range bufs {
		if offset > len(b) {
			f.malformedDropped.Add(1)
			startFiltering(i)
			continue
		}
		if !f.allow(b[offset:], false) {
			startFiltering(i)
			continue
		}
		if filtering {
			allowed = append(allowed, b)
		}
	}

	if len(allowed) == 0 {
		return 0, nil
	}
	return f.Device.Write(allowed, offset)
}

func (f *filteredTUN) allow(raw []byte, outbound bool) bool {
	pkt, ok := ParsePacket(raw)
	if !ok {
		f.malformedDropped.Add(1)
		return false
	}

	var err error
	if outbound {
		err = f.filter.Outbound(pkt)
	} else {
		err = f.filter.Inbound(pkt)
	}
	if err == nil {
		return true
	}

	if outbound {
		f.outboundDropped.Add(1)
	} else {
		f.inboundDropped.Add(1)
	}
	return false
}

const (
	ipv4MinHeaderLen = 20
	ipv6HeaderLen    = 40
)

// ParsePacket reads the addressing fields out of an IP packet.
//
// It reports false for anything it cannot make an access decision about, which the
// caller must treat as a drop: a packet whose header cannot be read is a packet
// whose destination cannot be checked.
func ParsePacket(b []byte) (Packet, bool) {
	if len(b) < 1 {
		return Packet{}, false
	}
	switch b[0] >> 4 {
	case 4:
		return parseIPv4(b)
	case 6:
		return parseIPv6(b)
	default:
		return Packet{}, false
	}
}

func parseIPv4(b []byte) (Packet, bool) {
	if len(b) < ipv4MinHeaderLen {
		return Packet{}, false
	}
	ihl := int(b[0]&0x0f) * 4
	if ihl < ipv4MinHeaderLen || len(b) < ihl {
		return Packet{}, false
	}

	totalLen := int(binary.BigEndian.Uint16(b[2:4]))
	if totalLen < ihl || totalLen > len(b) {
		// A declared length that does not fit the buffer means the packet was
		// truncated or forged. Either way the transport header cannot be trusted.
		return Packet{}, false
	}

	src, okSrc := netip.AddrFromSlice(b[12:16])
	dst, okDst := netip.AddrFromSlice(b[16:20])
	if !okSrc || !okDst {
		return Packet{}, false
	}

	fragOffset := binary.BigEndian.Uint16(b[6:8]) & 0x1fff
	pkt := Packet{
		Version:  4,
		Protocol: b[9],
		Src:      src,
		Dst:      dst,
		Fragment: fragOffset != 0,
	}
	if !pkt.Fragment {
		pkt.SrcPort, pkt.DstPort = transportPorts(pkt.Protocol, b[ihl:totalLen])
	}
	return pkt, true
}

func parseIPv6(b []byte) (Packet, bool) {
	if len(b) < ipv6HeaderLen {
		return Packet{}, false
	}
	payloadLen := int(binary.BigEndian.Uint16(b[4:6]))
	if ipv6HeaderLen+payloadLen > len(b) {
		return Packet{}, false
	}

	src, okSrc := netip.AddrFromSlice(b[8:24])
	dst, okDst := netip.AddrFromSlice(b[24:40])
	if !okSrc || !okDst {
		return Packet{}, false
	}

	pkt := Packet{
		Version:  6,
		Protocol: b[6],
		Src:      src,
		Dst:      dst,
	}
	// Extension headers are not walked. A packet carrying them arrives with no
	// ports, which a default-deny filter rejects: silently guessing zero ports for
	// a header chain nobody parsed would be an invented value.
	pkt.SrcPort, pkt.DstPort = transportPorts(pkt.Protocol, b[ipv6HeaderLen:ipv6HeaderLen+payloadLen])
	return pkt, true
}

func transportPorts(proto uint8, payload []byte) (src, dst uint16) {
	switch proto {
	case ProtoTCP, ProtoUDP:
		if len(payload) < 4 {
			return 0, 0
		}
		return binary.BigEndian.Uint16(payload[0:2]), binary.BigEndian.Uint16(payload[2:4])
	default:
		return 0, 0
	}
}
