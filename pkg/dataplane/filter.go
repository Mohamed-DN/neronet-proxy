package dataplane

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"net/netip"
	"os"
	"sync"
	"sync/atomic"
	"time"

	"golang.zx2c4.com/wireguard/tun"

	"github.com/sovereign/proxy/v4/pkg/dataplane/daita"
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
	// Returning a non-nil error drops the packet.
	Outbound(p Packet) error
	// Inbound is called on a decrypted packet from a peer, before the local stack
	// sees it.
	Inbound(p Packet) error
}

// FilterStats counts what was dropped. Every number is a count of real packets;
// none of them is estimated.
type FilterStats struct {
	OutboundDropped  uint64
	InboundDropped   uint64
	MalformedDropped uint64
	DummyDropped     uint64
	// Forwarded counts packets a profile gateway relayed between a profile device and
	// the mesh (ADR 0029); ForwardDropped those it refused to relay.
	Forwarded      uint64
	ForwardDropped uint64
}

// filteredTUN wraps the tun.Device so every packet crossing the tunnel passes the
// filter. Both modes get enforcement from the same code because both go through a
// tun.Device: this is the one point where the plaintext of every direction is
// visible in one place.
type filteredTUN struct {
	tun.Device
	filter      PacketFilter
	daitaShaper *daita.Shaper

	outboundDropped  atomic.Uint64
	inboundDropped   atomic.Uint64
	malformedDropped atomic.Uint64
	dummyDropped     atomic.Uint64

	closeOnce sync.Once
	closeErr  error

	// writeMu orders writes against Close. A write holds it for reading while it
	// hands packets to the backend; Close takes it for writing, so it waits for any
	// write in flight and every later write sees closed. Without it wireguard-go's
	// receive path could write into a backend Close was tearing down, which the
	// race detector reports and which can end in a send on a closed channel.
	writeMu sync.RWMutex
	closed  bool

	// Profile gateway forwarding (forward.go). forward is nil on every node that
	// serves no profile device, and then none of the fields below is used.
	forward        atomic.Pointer[ForwardTable]
	local          []netip.Addr
	fwdQueue       chan *[]byte
	forwarded      atomic.Uint64
	forwardDropped atomic.Uint64

	// The reader switch. Until forwarding is first switched on, Read reads the
	// backend directly, exactly as before. From then on a pump goroutine reads the
	// backend and Read serves whichever of the pump and the forwarding queue has a
	// packet first: a blocking read of the local stack alone would leave forwarded
	// packets waiting for the gateway itself to send something.
	pumping atomic.Bool
	pumpCh  chan pumpBatch
	pumpAck chan struct{}
	done    chan struct{}

	// wake makes the local stack emit one recognisable datagram, which ends a direct
	// read that is blocked when forwarding is switched on. It is dropped in Read and
	// never reaches wireguard-go.
	wake      func()
	wakeDst   netip.AddrPort
	wakeToken [16]byte
	lastWake  atomic.Int64
}

type pumpBatch struct {
	bufs  [][]byte
	sizes []int
	n     int
	err   error
}

// Close is idempotent. The underlying gVisor device closes channels without
// guarding against a second call, and both wireguard-go's shutdown and the owner of
// the device reach it, so an unguarded Close panics at every teardown.
func (f *filteredTUN) Close() error {
	f.closeOnce.Do(func() {
		f.writeMu.Lock()
		f.closed = true
		f.writeMu.Unlock()
		close(f.done)
		f.closeErr = f.Device.Close()
	})
	return f.closeErr
}

func newFilteredTUN(dev tun.Device, filter PacketFilter, shaper ...*daita.Shaper) *filteredTUN {
	var s *daita.Shaper
	if len(shaper) > 0 {
		s = shaper[0]
	}
	return &filteredTUN{
		Device:      dev,
		filter:      filter,
		daitaShaper: s,
		fwdQueue:    make(chan *[]byte, forwardQueueLen),
		pumpCh:      make(chan pumpBatch),
		pumpAck:     make(chan struct{}),
		done:        make(chan struct{}),
	}
}

func (f *filteredTUN) stats() FilterStats {
	return FilterStats{
		OutboundDropped:  f.outboundDropped.Load(),
		InboundDropped:   f.inboundDropped.Load(),
		MalformedDropped: f.malformedDropped.Load(),
		DummyDropped:     f.dummyDropped.Load(),
		Forwarded:        f.forwarded.Load(),
		ForwardDropped:   f.forwardDropped.Load(),
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
	if f.pumping.Load() {
		return f.readMerged(bufs, sizes, offset)
	}
	n, err := f.Device.Read(bufs, sizes, offset)
	kept := f.keepOutbound(bufs, sizes, offset, n)
	if err == nil && f.forward.Load() != nil && len(bufs) > 0 {
		// Only this goroutine reads, so the switch needs no lock: from the next call on
		// the pump is the only reader of the backend.
		f.pumping.Store(true)
		go f.pump(len(bufs), len(bufs[0]), offset)
	}
	return kept, err
}

// keepOutbound applies the sender-side filter to the n packets the local stack
// produced and compacts the survivors to the front.
func (f *filteredTUN) keepOutbound(bufs [][]byte, sizes []int, offset, n int) int {
	if n == 0 {
		return 0
	}

	kept := 0
	for i := 0; i < n; i++ {
		raw := bufs[i][offset : offset+sizes[i]]
		if f.isWake(raw) {
			continue
		}
		if f.filter != nil && !f.allow(raw, true) {
			continue
		}
		if f.daitaShaper != nil {
			padded := f.daitaShaper.NormalizePacketSize(raw)
			if len(padded) <= len(bufs[i][offset:]) {
				copy(bufs[i][offset:], padded)
				sizes[i] = len(padded)
				raw = bufs[i][offset : offset+sizes[i]]
			}
		}
		if kept != i {
			copy(bufs[kept][offset:], raw)
			sizes[kept] = sizes[i]
		}
		kept++
	}
	return kept
}

// readMerged serves the pump and the forwarding queue, whichever is ready first.
func (f *filteredTUN) readMerged(bufs [][]byte, sizes []int, offset int) (int, error) {
	select {
	case b := <-f.pumpCh:
		n := 0
		for i := 0; i < b.n && i < len(bufs); i++ {
			sizes[i] = copy(bufs[i][offset:], b.bufs[i][offset:offset+b.sizes[i]])
			n++
		}
		err := b.err
		select {
		case f.pumpAck <- struct{}{}:
		case <-f.done:
		}
		return f.keepOutbound(bufs, sizes, offset, n), err
	case bp := <-f.fwdQueue:
		n := 0
		for {
			pkt := *bp
			if len(pkt) <= len(bufs[n])-offset {
				sizes[n] = copy(bufs[n][offset:], pkt)
				n++
			} else {
				f.forwardDropped.Add(1)
			}
			forwardBufPool.Put(bp)
			if n == len(bufs) {
				return n, nil
			}
			select {
			case bp = <-f.fwdQueue:
			default:
				return n, nil
			}
		}
	case <-f.done:
		return 0, os.ErrClosed
	}
}

// pump reads the backend into its own buffers and hands each batch to readMerged,
// waiting until it has been copied out before reading again.
func (f *filteredTUN) pump(batch, bufLen, offset int) {
	bufs := make([][]byte, batch)
	for i := range bufs {
		bufs[i] = make([]byte, bufLen)
	}
	sizes := make([]int, batch)
	for {
		n, err := f.Device.Read(bufs, sizes, offset)
		select {
		case f.pumpCh <- pumpBatch{bufs: bufs, sizes: sizes, n: n, err: err}:
		case <-f.done:
			return
		}
		select {
		case <-f.pumpAck:
		case <-f.done:
			return
		}
		if err != nil && !errors.Is(err, tun.ErrTooManySegments) {
			return
		}
	}
}

// relay forwards one decrypted packet that belongs to a profile device flow and is
// not addressed to this node.
func (f *filteredTUN) relay(raw []byte, pkt Packet, t *ForwardTable) {
	if err := t.decide(pkt); err != nil {
		f.forwardDropped.Add(1)
		return
	}
	bp := forwardBufPool.Get().(*[]byte)
	buf := append((*bp)[:0], raw...)
	*bp = buf
	if err := decrementTTL(buf); err != nil {
		forwardBufPool.Put(bp)
		f.forwardDropped.Add(1)
		return
	}
	select {
	case f.fwdQueue <- bp:
		f.forwarded.Add(1)
		f.wakeIfDirect()
	default:
		forwardBufPool.Put(bp)
		f.forwardDropped.Add(1)
	}
}

func (f *filteredTUN) isLocal(a netip.Addr) bool {
	a = a.Unmap()
	for _, l := range f.local {
		if l == a {
			return true
		}
	}
	return false
}

// wakeIfDirect ends a direct read that may be blocked, at most every 20ms.
func (f *filteredTUN) wakeIfDirect() {
	if f.pumping.Load() || f.wake == nil {
		return
	}
	now := time.Now().UnixNano()
	last := f.lastWake.Load()
	if now-last < int64(20*time.Millisecond) || !f.lastWake.CompareAndSwap(last, now) {
		return
	}
	// Not inline: the netstack hands a sent packet to the reader over an unbuffered
	// channel, and this may run on wireguard-go's receive path.
	go f.wake()
}

// isWake recognises the datagram wake sends: UDP to wakeDst carrying wakeToken.
func (f *filteredTUN) isWake(raw []byte) bool {
	if f.wake == nil || !f.wakeDst.IsValid() || len(raw) < 1 {
		return false
	}
	var payload []byte
	switch raw[0] >> 4 {
	case 4:
		if len(raw) < ipv4MinHeaderLen || raw[9] != ProtoUDP {
			return false
		}
		ihl := int(raw[0]&0x0f) * 4
		if len(raw) < ihl+8 {
			return false
		}
		dst, _ := netip.AddrFromSlice(raw[16:20])
		if dst != f.wakeDst.Addr() || binary.BigEndian.Uint16(raw[ihl+2:ihl+4]) != f.wakeDst.Port() {
			return false
		}
		payload = raw[ihl+8:]
	case 6:
		if len(raw) < ipv6HeaderLen+8 || raw[6] != ProtoUDP {
			return false
		}
		dst, _ := netip.AddrFromSlice(raw[24:40])
		if dst != f.wakeDst.Addr() || binary.BigEndian.Uint16(raw[42:44]) != f.wakeDst.Port() {
			return false
		}
		payload = raw[48:]
	default:
		return false
	}
	return bytes.Equal(payload, f.wakeToken[:])
}

// Write delivers decrypted packets to the local stack. Rejected packets are left
// out of the slice handed downwards; the caller's slice is not modified, because it
// owns the buffers behind it.
func (f *filteredTUN) Write(bufs [][]byte, offset int) (int, error) {
	f.writeMu.RLock()
	defer f.writeMu.RUnlock()
	if f.closed {
		return 0, os.ErrClosed
	}

	if len(bufs) == 0 {
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
		raw := b[offset:]
		if daita.IsDummyPacket(raw) {
			f.dummyDropped.Add(1)
			startFiltering(i)
			continue
		}
		if t := f.forward.Load(); t != nil {
			if pkt, ok := ParsePacket(raw); ok && t.involves(pkt) && !f.isLocal(pkt.Dst) {
				f.relay(raw, pkt, t)
				startFiltering(i)
				continue
			}
		}
		if f.filter != nil && !f.allow(raw, false) {
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
	if !outbound && daita.IsDummyPacket(raw) {
		f.dummyDropped.Add(1)
		return false
	}

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
