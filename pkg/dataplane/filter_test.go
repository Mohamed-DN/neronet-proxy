package dataplane

import (
	"encoding/binary"
	"errors"
	"net/netip"
	"os"
	"testing"

	"golang.zx2c4.com/wireguard/tun"
)

// buildIPv4 assembles a real IPv4 packet so the parser is exercised on bytes that a
// stack would actually produce, not on a struct the test filled in itself.
func buildIPv4(t *testing.T, proto uint8, src, dst string, srcPort, dstPort uint16, payload []byte, fragOffset uint16) []byte {
	t.Helper()

	transport := payload
	switch proto {
	case ProtoTCP, ProtoUDP:
		hdr := make([]byte, 4)
		binary.BigEndian.PutUint16(hdr[0:2], srcPort)
		binary.BigEndian.PutUint16(hdr[2:4], dstPort)
		transport = append(hdr, payload...)
	}

	total := 20 + len(transport)
	pkt := make([]byte, total)
	pkt[0] = 0x45
	binary.BigEndian.PutUint16(pkt[2:4], uint16(total))
	binary.BigEndian.PutUint16(pkt[6:8], fragOffset&0x1fff)
	pkt[8] = 64
	pkt[9] = proto
	copy(pkt[12:16], netip.MustParseAddr(src).AsSlice())
	copy(pkt[16:20], netip.MustParseAddr(dst).AsSlice())
	copy(pkt[20:], transport)
	return pkt
}

func buildIPv6(t *testing.T, proto uint8, src, dst string, srcPort, dstPort uint16, payload []byte) []byte {
	t.Helper()

	transport := payload
	switch proto {
	case ProtoTCP, ProtoUDP:
		hdr := make([]byte, 4)
		binary.BigEndian.PutUint16(hdr[0:2], srcPort)
		binary.BigEndian.PutUint16(hdr[2:4], dstPort)
		transport = append(hdr, payload...)
	}

	pkt := make([]byte, 40+len(transport))
	pkt[0] = 0x60
	binary.BigEndian.PutUint16(pkt[4:6], uint16(len(transport)))
	pkt[6] = proto
	pkt[7] = 64
	copy(pkt[8:24], netip.MustParseAddr(src).AsSlice())
	copy(pkt[24:40], netip.MustParseAddr(dst).AsSlice())
	copy(pkt[40:], transport)
	return pkt
}

func TestParsePacketIPv4TCP(t *testing.T) {
	raw := buildIPv4(t, ProtoTCP, "100.64.0.1", "100.64.0.2", 40001, 9999, []byte("payload"), 0)

	got, ok := ParsePacket(raw)
	if !ok {
		t.Fatal("ParsePacket rejected a well formed IPv4 TCP packet")
	}
	if got.Version != 4 || got.Protocol != ProtoTCP {
		t.Fatalf("version/protocol = %d/%d, want 4/%d", got.Version, got.Protocol, ProtoTCP)
	}
	if got.Src.String() != "100.64.0.1" || got.Dst.String() != "100.64.0.2" {
		t.Fatalf("addresses = %s -> %s, want 100.64.0.1 -> 100.64.0.2", got.Src, got.Dst)
	}
	if got.SrcPort != 40001 || got.DstPort != 9999 {
		t.Fatalf("ports = %d -> %d, want 40001 -> 9999", got.SrcPort, got.DstPort)
	}
}

func TestParsePacketIPv6UDP(t *testing.T) {
	raw := buildIPv6(t, ProtoUDP, "fd7a:115c:a1e0::1", "fd7a:115c:a1e0::2", 1234, 5678, []byte("x"))

	got, ok := ParsePacket(raw)
	if !ok {
		t.Fatal("ParsePacket rejected a well formed IPv6 UDP packet")
	}
	if got.Version != 6 || got.Protocol != ProtoUDP {
		t.Fatalf("version/protocol = %d/%d, want 6/%d", got.Version, got.Protocol, ProtoUDP)
	}
	if got.SrcPort != 1234 || got.DstPort != 5678 {
		t.Fatalf("ports = %d -> %d, want 1234 -> 5678", got.SrcPort, got.DstPort)
	}
}

func TestParsePacketRejectsUnparseable(t *testing.T) {
	full := buildIPv4(t, ProtoTCP, "100.64.0.1", "100.64.0.2", 1, 2, []byte("abcd"), 0)

	cases := map[string][]byte{
		"empty":                 {},
		"unknown version":       {0x00},
		"ipv4 header truncated": full[:12],
		"ipv6 header truncated": buildIPv6(t, ProtoTCP, "fd7a::1", "fd7a::2", 1, 2, nil)[:30],
	}

	// A total length that claims more bytes than arrived: the transport header the
	// filter would read is not there, so no decision can be made about it.
	lying := append([]byte(nil), full...)
	binary.BigEndian.PutUint16(lying[2:4], uint16(len(full)+40))
	cases["total length beyond buffer"] = lying

	for name, raw := range cases {
		if _, ok := ParsePacket(raw); ok {
			t.Errorf("%s: ParsePacket accepted a packet it cannot make a decision about", name)
		}
	}
}

func TestParsePacketFragmentHasNoPorts(t *testing.T) {
	raw := buildIPv4(t, ProtoTCP, "100.64.0.1", "100.64.0.2", 40001, 9999, []byte("tail"), 185)

	got, ok := ParsePacket(raw)
	if !ok {
		t.Fatal("ParsePacket rejected a valid non-first fragment")
	}
	if !got.Fragment {
		t.Fatal("non-first fragment was not flagged as a fragment")
	}
	if got.SrcPort != 0 || got.DstPort != 0 {
		t.Fatalf("ports = %d -> %d, want 0 -> 0: a non-first fragment carries no transport header", got.SrcPort, got.DstPort)
	}
}

// fakeTUN records what wireguard-go would have been handed and what reached the
// stack, so the filter can be checked on behaviour rather than on counters alone.
type fakeTUN struct {
	toRead  [][]byte
	written [][]byte
	events  chan tun.Event
}

func newFakeTUN(packets ...[]byte) *fakeTUN {
	return &fakeTUN{toRead: packets, events: make(chan tun.Event, 1)}
}

func (f *fakeTUN) File() *os.File { return nil }

func (f *fakeTUN) Read(bufs [][]byte, sizes []int, offset int) (int, error) {
	n := 0
	for n < len(bufs) && n < len(f.toRead) {
		copy(bufs[n][offset:], f.toRead[n])
		sizes[n] = len(f.toRead[n])
		n++
	}
	f.toRead = f.toRead[n:]
	return n, nil
}

func (f *fakeTUN) Write(bufs [][]byte, offset int) (int, error) {
	for _, b := range bufs {
		f.written = append(f.written, append([]byte(nil), b[offset:]...))
	}
	return len(bufs), nil
}

func (f *fakeTUN) MTU() (int, error)        { return 1420, nil }
func (f *fakeTUN) Name() (string, error)    { return "fake", nil }
func (f *fakeTUN) Events() <-chan tun.Event { return f.events }
func (f *fakeTUN) Close() error             { close(f.events); return nil }
func (f *fakeTUN) BatchSize() int           { return 8 }

// portFilter allows exactly one destination port in each direction.
type portFilter struct {
	outPort uint16
	inPort  uint16
}

var errNotAllowed = errors.New("not allowed")

func (p portFilter) Outbound(pkt Packet) error {
	if pkt.DstPort == p.outPort {
		return nil
	}
	return errNotAllowed
}

func (p portFilter) Inbound(pkt Packet) error {
	if pkt.DstPort == p.inPort {
		return nil
	}
	return errNotAllowed
}

func TestFilteredTUNDropsOutboundPackets(t *testing.T) {
	allowed := buildIPv4(t, ProtoTCP, "100.64.0.1", "100.64.0.2", 1111, 9999, []byte("allowed"), 0)
	denied := buildIPv4(t, ProtoTCP, "100.64.0.1", "100.64.0.2", 1111, 22, []byte("denied"), 0)
	second := buildIPv4(t, ProtoTCP, "100.64.0.1", "100.64.0.3", 1111, 9999, []byte("second"), 0)

	fake := newFakeTUN(denied, allowed, second)
	f := newFilteredTUN(fake, portFilter{outPort: 9999, inPort: 9999})

	const offset = 16
	bufs := make([][]byte, 8)
	for i := range bufs {
		bufs[i] = make([]byte, 2048)
	}
	sizes := make([]int, 8)

	n, err := f.Read(bufs, sizes, offset)
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if n != 2 {
		t.Fatalf("Read returned %d packets, want 2: the port 22 packet must not reach wireguard", n)
	}

	for i, want := range [][]byte{allowed, second} {
		got := bufs[i][offset : offset+sizes[i]]
		if string(got) != string(want) {
			t.Fatalf("packet %d is not the expected surviving packet", i)
		}
	}

	if stats := f.stats(); stats.OutboundDropped != 1 {
		t.Fatalf("OutboundDropped = %d, want 1", stats.OutboundDropped)
	}
}

func TestFilteredTUNDropsInboundPackets(t *testing.T) {
	allowed := buildIPv4(t, ProtoTCP, "100.64.0.2", "100.64.0.1", 40000, 9999, []byte("allowed"), 0)
	denied := buildIPv4(t, ProtoTCP, "100.64.0.2", "100.64.0.1", 40000, 22, []byte("denied"), 0)

	fake := newFakeTUN()
	f := newFilteredTUN(fake, portFilter{outPort: 9999, inPort: 9999})

	const offset = 4
	withOffset := func(p []byte) []byte { return append(make([]byte, offset), p...) }

	if _, err := f.Write([][]byte{withOffset(denied), withOffset(allowed)}, offset); err != nil {
		t.Fatalf("Write: %v", err)
	}

	if len(fake.written) != 1 {
		t.Fatalf("%d packets reached the stack, want 1", len(fake.written))
	}
	if string(fake.written[0]) != string(allowed) {
		t.Fatal("the packet that reached the stack is not the allowed one")
	}
	if stats := f.stats(); stats.InboundDropped != 1 {
		t.Fatalf("InboundDropped = %d, want 1", stats.InboundDropped)
	}
}

func TestFilteredTUNWithoutFilterPassesEverything(t *testing.T) {
	denied := buildIPv4(t, ProtoTCP, "100.64.0.2", "100.64.0.1", 40000, 22, []byte("denied"), 0)
	malformed := []byte{0x00, 0x01}

	fake := newFakeTUN()
	f := newFilteredTUN(fake, nil)

	if _, err := f.Write([][]byte{denied, malformed}, 0); err != nil {
		t.Fatalf("Write: %v", err)
	}
	if len(fake.written) != 2 {
		t.Fatalf("%d packets reached the stack, want 2: with no filter the device is a plain pipe", len(fake.written))
	}
	if stats := f.stats(); stats != (FilterStats{}) {
		t.Fatalf("stats = %+v, want all zero", stats)
	}
}

func TestFilteredTUNDropsMalformedWhenFiltering(t *testing.T) {
	fake := newFakeTUN()
	f := newFilteredTUN(fake, portFilter{outPort: 9999, inPort: 9999})

	if _, err := f.Write([][]byte{{0x00, 0x01, 0x02}}, 0); err != nil {
		t.Fatalf("Write: %v", err)
	}
	if len(fake.written) != 0 {
		t.Fatal("a packet whose header cannot be read reached the stack")
	}
	if stats := f.stats(); stats.MalformedDropped != 1 {
		t.Fatalf("MalformedDropped = %d, want 1", stats.MalformedDropped)
	}
}
