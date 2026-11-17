package dataplane

import (
	"context"
	"encoding/binary"
	"io"
	"net"
	"net/netip"
	"sync/atomic"
	"testing"
	"time"

	"golang.org/x/net/dns/dnsmessage"

	"github.com/sovereign/proxy/v4/pkg/acl"
	"github.com/sovereign/proxy/v4/pkg/control"
	"github.com/sovereign/proxy/v4/pkg/dns"
)

// ADR 0034: the gateway answers mesh names for a stock WireGuard device at ExitDNS:53.
// A real gateway and a real device run in this process; the device's only peer is the
// gateway, which holds the overlay /10 (it contains ExitDNS), so the device has no
// exit. The resolver on the gateway is the real pkg/dns server; the "internet" and
// the exit's resolver are stubs that count what they are asked.

// stubResolver answers every A query with one fixed address, over UDP and TCP on the
// same port, and counts the queries it saw.
type stubResolver struct {
	addr    netip.AddrPort
	answer  [4]byte
	queries atomic.Int64
}

func newStubResolver(t *testing.T, answer [4]byte) *stubResolver {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	pc, err := net.ListenPacket("udp", ln.Addr().String())
	if err != nil {
		ln.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close(); pc.Close() })
	s := &stubResolver{addr: netip.MustParseAddrPort(ln.Addr().String()), answer: answer}
	go func() {
		buf := make([]byte, 4096)
		for {
			n, from, err := pc.ReadFrom(buf)
			if err != nil {
				return
			}
			if reply := s.reply(buf[:n]); reply != nil {
				_, _ = pc.WriteTo(reply, from)
			}
		}
	}()
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				defer c.Close()
				var l [2]byte
				if _, err := io.ReadFull(c, l[:]); err != nil {
					return
				}
				q := make([]byte, binary.BigEndian.Uint16(l[:]))
				if _, err := io.ReadFull(c, q); err != nil {
					return
				}
				if reply := s.reply(q); reply != nil {
					out := binary.BigEndian.AppendUint16(nil, uint16(len(reply)))
					_, _ = c.Write(append(out, reply...))
				}
			}()
		}
	}()
	return s
}

func (s *stubResolver) reply(q []byte) []byte {
	var m dnsmessage.Message
	if m.Unpack(q) != nil || len(m.Questions) == 0 {
		return nil
	}
	s.queries.Add(1)
	m.Response = true
	m.Answers = []dnsmessage.Resource{{
		Header: dnsmessage.ResourceHeader{Name: m.Questions[0].Name, Type: dnsmessage.TypeA, Class: dnsmessage.ClassINET, TTL: 30},
		Body:   &dnsmessage.AResource{A: s.answer},
	}}
	out, _ := m.Pack()
	return out
}

func dnsQuery(t *testing.T, name string) []byte {
	t.Helper()
	n, err := dnsmessage.NewName(name)
	if err != nil {
		t.Fatal(err)
	}
	b, err := (&dnsmessage.Message{
		Header:    dnsmessage.Header{ID: 0x4242, RecursionDesired: true},
		Questions: []dnsmessage.Question{{Name: n, Type: dnsmessage.TypeA, Class: dnsmessage.ClassINET}},
	}).Pack()
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// meshNames is a gateway netmap with two profile devices: phone (the device under
// test) and a laptop.
func meshNames(t *testing.T, upstream netip.AddrPort) *MeshDNS {
	t.Helper()
	srv := dns.NewServer(dns.Config{SingleAnswer: true})
	srv.UpdateNetmap(
		control.NetmapSelf{OverlayIPv4: gwAddr, Name: "gw"},
		[]control.NetmapPeer{
			{NodeID: "dev-phone", Name: "phone", DNSName: "phone.example.com", AllowedIPs: []string{deviceAddr + "/32"}},
			{NodeID: "dev-laptop", Name: "laptop", DNSName: "laptop.example.com", AllowedIPs: []string{"100.64.0.9/32"}},
			// The same name on two devices: one answer, the lowest node id's.
			{NodeID: "dev-b-tablet", Name: "tablet", DNSName: "tablet.example.com", AllowedIPs: []string{"100.64.0.12/32"}},
			{NodeID: "dev-a-tablet", Name: "tablet", DNSName: "tablet.example.com", AllowedIPs: []string{"100.64.0.11/32"}},
		},
		&control.DNSConfig{SearchDomains: []string{"example.com", "mesh", "neronet"}},
	)
	return &MeshDNS{Answer: srv.AnswerFor, Upstream: upstream}
}

// meshDNSPair is gateway G serving device D (no exit) as a profile device.
func meshDNSPair(t *testing.T) (g, d *testNode) {
	t.Helper()
	g = newTestNode(t, gwAddr+"/10", nil)
	d = newTestNode(t, deviceAddr+"/10", nil)
	gw := g.peerEntry()
	gw.AllowedIPs = []netip.Prefix{netip.MustParsePrefix("100.64.0.0/10")}
	gw.PresharedKey = testPSK
	if err := d.dev.SetPeers([]Peer{gw}); err != nil {
		t.Fatal(err)
	}
	if err := g.dev.SetPeers([]Peer{deviceAtGateway(d)}); err != nil {
		t.Fatal(err)
	}
	ft := NewForwardTable()
	ft.AddDevice(netip.MustParseAddr(deviceAddr), acl.NewNetstackFilter()) // default deny: the DNS path must not need a rule
	g.dev.SetForwarding(ft)
	return g, d
}

// ask sends one query from the device over UDP or TCP and returns the answer. It
// retries until the deadline, because the first attempt pays for the handshake.
func ask(t *testing.T, d *Device, network, name string, total time.Duration) (dnsmessage.Message, error) {
	t.Helper()
	deadline := time.Now().Add(total)
	var lastErr error
	for time.Now().Before(deadline) {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		c, err := d.DialContext(ctx, network, netip.AddrPortFrom(ExitDNS, 53).String())
		cancel()
		if err != nil {
			lastErr = err
			continue
		}
		_ = c.SetDeadline(time.Now().Add(time.Second))
		q := dnsQuery(t, name)
		var raw []byte
		if network == "tcp" {
			_, err = c.Write(binary.BigEndian.AppendUint16(nil, uint16(len(q))))
			if err == nil {
				_, err = c.Write(q)
			}
			var l [2]byte
			if err == nil {
				_, err = io.ReadFull(c, l[:])
			}
			if err == nil {
				raw = make([]byte, binary.BigEndian.Uint16(l[:]))
				_, err = io.ReadFull(c, raw)
			}
		} else {
			_, err = c.Write(q)
			if err == nil {
				buf := make([]byte, 4096)
				var n int
				n, err = c.Read(buf)
				raw = buf[:n]
			}
		}
		c.Close()
		if err == nil {
			var m dnsmessage.Message
			if err = m.Unpack(raw); err == nil {
				return m, nil
			}
		}
		lastErr = err
	}
	return dnsmessage.Message{}, lastErr
}

func aOf(t *testing.T, m dnsmessage.Message) []netip.Addr {
	t.Helper()
	var out []netip.Addr
	for _, a := range m.Answers {
		if r, ok := a.Body.(*dnsmessage.AResource); ok {
			out = append(out, netip.AddrFrom4(r.A))
		}
	}
	return out
}

func TestMeshDNSResolvesAProfileDeviceNameThroughTheGatewayNetstack(t *testing.T) {
	g, d := meshDNSPair(t)
	allowAllNames(g)
	up := newStubResolver(t, [4]byte{192, 0, 2, 77})
	if err := g.dev.SetMeshDNS(meshNames(t, up.addr)); err != nil {
		t.Fatal(err)
	}
	for _, network := range []string{"udp", "tcp"} {
		for name, want := range map[string]string{"laptop.example.com.": "100.64.0.9", "laptop.": "100.64.0.9", "phone.example.com.": deviceAddr} {
			m, err := ask(t, d.dev, network, name, 15*time.Second)
			if err != nil {
				t.Fatalf("%s %s: no answer through the gateway resolver: %v", network, name, err)
			}
			if got := aOf(t, m); len(got) != 1 || got[0].String() != want {
				t.Errorf("%s %s: answered %v, want %s", network, name, got, want)
			}
		}
	}
	if up.queries.Load() != 0 {
		t.Fatalf("a mesh name reached the upstream resolver %d time(s)", up.queries.Load())
	}
}

func TestMeshDNSUnknownMeshNameIsNXDOMAINAndNeverForwarded(t *testing.T) {
	g, d := meshDNSPair(t)
	up := newStubResolver(t, [4]byte{192, 0, 2, 77})
	if err := g.dev.SetMeshDNS(meshNames(t, up.addr)); err != nil {
		t.Fatal(err)
	}
	for _, network := range []string{"udp", "tcp"} {
		for _, name := range []string{"ghost.example.com.", "ghost.", "ghost.mesh."} {
			m, err := ask(t, d.dev, network, name, 15*time.Second)
			if err != nil {
				t.Fatalf("%s %s: %v", network, name, err)
			}
			if m.RCode != dnsmessage.RCodeNameError || len(m.Answers) != 0 {
				t.Errorf("%s %s: rcode %v with %d answer(s), want NXDOMAIN", network, name, m.RCode, len(m.Answers))
			}
		}
	}
	if up.queries.Load() != 0 {
		t.Fatalf("an unknown mesh name leaked to the upstream resolver %d time(s)", up.queries.Load())
	}
}

func TestMeshDNSDuplicateNameAnswersOneDeterministicAddress(t *testing.T) {
	g, d := meshDNSPair(t)
	allowAllNames(g)
	if err := g.dev.SetMeshDNS(meshNames(t, netip.AddrPort{})); err != nil {
		t.Fatal(err)
	}
	m, err := ask(t, d.dev, "udp", "tablet.example.com.", 15*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if got := aOf(t, m); len(got) != 1 || got[0].String() != "100.64.0.11" {
		t.Fatalf("a name on two devices answered %v, want the one of the lowest node id (100.64.0.11)", got)
	}
}

func TestMeshDNSNonMeshQueryFromADeviceWithoutExitGoesUpstream(t *testing.T) {
	g, d := meshDNSPair(t)
	up := newStubResolver(t, [4]byte{192, 0, 2, 77})
	if err := g.dev.SetMeshDNS(meshNames(t, up.addr)); err != nil {
		t.Fatal(err)
	}
	for _, network := range []string{"udp", "tcp"} {
		m, err := ask(t, d.dev, network, "www.example.org.", 15*time.Second)
		if err != nil {
			t.Fatalf("%s: %v", network, err)
		}
		if got := aOf(t, m); len(got) != 1 || got[0].String() != "192.0.2.77" {
			t.Errorf("%s: answered %v, want the upstream resolver's 192.0.2.77", network, got)
		}
	}
	if up.queries.Load() != 2 {
		t.Fatalf("upstream saw %d queries, want 2 (one per transport)", up.queries.Load())
	}
}

func TestMeshDNSWithoutAnUpstreamAnswersSERVFAILForOutsideNames(t *testing.T) {
	g, d := meshDNSPair(t)
	if err := g.dev.SetMeshDNS(meshNames(t, netip.AddrPort{})); err != nil {
		t.Fatal(err)
	}
	m, err := ask(t, d.dev, "udp", "www.example.org.", 15*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if m.RCode != dnsmessage.RCodeServerFailure {
		t.Fatalf("rcode %v, want SERVFAIL", m.RCode)
	}
}

func TestMeshDNSDeviceWithAnExitKeepsUsingTheExitsResolver(t *testing.T) {
	g, d := meshDNSPair(t)
	meshUp := newStubResolver(t, [4]byte{192, 0, 2, 77})
	exitUp := newStubResolver(t, [4]byte{198, 51, 100, 5})
	if err := g.dev.SetMeshDNS(meshNames(t, meshUp.addr)); err != nil {
		t.Fatal(err)
	}
	if err := g.dev.SetEgress(egressFor(deviceAddr, &EgressClient{ID: "dev", Via: EgressLocal}), exitUp.addr); err != nil {
		t.Fatal(err)
	}
	for _, network := range []string{"udp", "tcp"} {
		m, err := ask(t, d.dev, network, "www.example.org.", 15*time.Second)
		if err != nil {
			t.Fatalf("%s: %v", network, err)
		}
		if got := aOf(t, m); len(got) != 1 || got[0].String() != "198.51.100.5" {
			t.Errorf("%s: answered %v, want the exit resolver's 198.51.100.5", network, got)
		}
	}
	if meshUp.queries.Load() != 0 {
		t.Fatalf("a device with an exit used the gateway's own upstream %d time(s)", meshUp.queries.Load())
	}
	if exitUp.queries.Load() != 2 {
		t.Fatalf("the exit's resolver saw %d queries, want 2", exitUp.queries.Load())
	}
}

func TestMeshDNSDeviceWithAnExitResolvesMeshNamesLocally(t *testing.T) {
	g, d := meshDNSPair(t)
	allowAllNames(g)
	meshUp := newStubResolver(t, [4]byte{192, 0, 2, 77})
	exitUp := newStubResolver(t, [4]byte{198, 51, 100, 5})
	if err := g.dev.SetMeshDNS(meshNames(t, meshUp.addr)); err != nil {
		t.Fatal(err)
	}
	if err := g.dev.SetEgress(egressFor(deviceAddr, &EgressClient{ID: "dev", Via: EgressLocal}), exitUp.addr); err != nil {
		t.Fatal(err)
	}
	for _, network := range []string{"udp", "tcp"} {
		for name, want := range map[string]string{"laptop.example.com.": "100.64.0.9", "laptop.": "100.64.0.9", "phone.example.com.": deviceAddr} {
			m, err := ask(t, d.dev, network, name, 15*time.Second)
			if err != nil {
				t.Fatalf("%s %s: no answer: %v", network, name, err)
			}
			if got := aOf(t, m); len(got) != 1 || got[0].String() != want {
				t.Errorf("%s %s: answered %v, want %s", network, name, got, want)
			}
		}
		m, err := ask(t, d.dev, network, "ghost.example.com.", 15*time.Second)
		if err != nil {
			t.Fatalf("%s ghost: %v", network, err)
		}
		if m.RCode != dnsmessage.RCodeNameError {
			t.Errorf("%s: an unknown mesh name got rcode %v, want NXDOMAIN", network, m.RCode)
		}
	}
	if exitUp.queries.Load() != 0 {
		t.Fatalf("the exit's resolver saw %d queries for mesh names, want 0", exitUp.queries.Load())
	}
	if meshUp.queries.Load() != 0 {
		t.Fatalf("the gateway's own upstream saw %d queries from an exit device, want 0", meshUp.queries.Load())
	}
	// Anything else still leaves through the exit, over both transports.
	for _, network := range []string{"udp", "tcp"} {
		m, err := ask(t, d.dev, network, "www.example.org.", 15*time.Second)
		if err != nil {
			t.Fatalf("%s: %v", network, err)
		}
		if got := aOf(t, m); len(got) != 1 || got[0].String() != "198.51.100.5" {
			t.Errorf("%s: answered %v, want the exit resolver's 198.51.100.5", network, got)
		}
	}
	if exitUp.queries.Load() != 2 || meshUp.queries.Load() != 0 {
		t.Fatalf("exit saw %d queries (want 2), gateway upstream %d (want 0)", exitUp.queries.Load(), meshUp.queries.Load())
	}
}

func TestMeshDNSExitDeviceWithoutAnExitResolverGetsSERVFAILNotTheGatewaysUpstream(t *testing.T) {
	g, d := meshDNSPair(t)
	meshUp := newStubResolver(t, [4]byte{192, 0, 2, 77})
	if err := g.dev.SetMeshDNS(meshNames(t, meshUp.addr)); err != nil {
		t.Fatal(err)
	}
	if err := g.dev.SetEgress(egressFor(deviceAddr, &EgressClient{ID: "dev", Via: EgressLocal}), netip.AddrPort{}); err != nil {
		t.Fatal(err)
	}
	m, err := ask(t, d.dev, "udp", "www.example.org.", 15*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if m.RCode != dnsmessage.RCodeServerFailure || meshUp.queries.Load() != 0 {
		t.Fatalf("rcode %v, gateway upstream saw %d: a device with an exit must never go around it", m.RCode, meshUp.queries.Load())
	}
}

func TestMeshDNSDeviceBehindAMeshExitResolvesMeshNamesLocallyOverUDP(t *testing.T) {
	m := newMeshExit(t)
	meshUp := newStubResolver(t, [4]byte{192, 0, 2, 77})
	exitUp := newStubResolver(t, [4]byte{198, 51, 100, 5})
	ft := NewForwardTable()
	nf := acl.NewNetstackFilter()
	allowOnly(nf, laptopAddr)
	ft.AddDevice(netip.MustParseAddr(deviceAddr), nf)
	m.g.dev.SetForwarding(ft)
	if err := m.g.dev.SetMeshDNS(meshNames(t, meshUp.addr)); err != nil {
		t.Fatal(err)
	}
	if err := m.x.dev.SetEgress(egressFor(deviceAddr, &EgressClient{ID: "dev", Via: EgressLocal, AllowLAN: true}), exitUp.addr); err != nil {
		t.Fatal(err)
	}
	got, err := ask(t, m.d.dev, "udp", "laptop.example.com.", 15*time.Second)
	if err != nil {
		t.Fatalf("mesh name through a mesh exit: %v", err)
	}
	if a := aOf(t, got); len(a) != 1 || a[0].String() != "100.64.0.9" {
		t.Fatalf("answered %v, want 100.64.0.9", a)
	}
	if exitUp.queries.Load() != 0 {
		t.Fatalf("the mesh exit's resolver saw %d queries for a mesh name, want 0", exitUp.queries.Load())
	}
	other, err := ask(t, m.d.dev, "udp", "www.example.org.", 15*time.Second)
	if err != nil {
		t.Fatalf("outside name through a mesh exit: %v", err)
	}
	if a := aOf(t, other); len(a) != 1 || a[0].String() != "198.51.100.5" {
		t.Fatalf("answered %v, want the exit resolver's 198.51.100.5", a)
	}
	if exitUp.queries.Load() != 1 || meshUp.queries.Load() != 0 {
		t.Fatalf("exit saw %d queries (want 1), gateway upstream %d (want 0)", exitUp.queries.Load(), meshUp.queries.Load())
	}
}

func TestMeshDNSRemovedRestoresTheExitOnlyBehaviour(t *testing.T) {
	g, d := meshDNSPair(t)
	if err := g.dev.SetMeshDNS(meshNames(t, netip.AddrPort{})); err != nil {
		t.Fatal(err)
	}
	if _, err := ask(t, d.dev, "udp", "laptop.example.com.", 15*time.Second); err != nil {
		t.Fatalf("not answering while installed: %v", err)
	}
	if err := g.dev.SetMeshDNS(nil); err != nil {
		t.Fatal(err)
	}
	if _, err := ask(t, d.dev, "udp", "laptop.example.com.", 3*time.Second); err == nil {
		t.Fatal("a device without an exit still got an answer at ExitDNS after the resolver was removed")
	}
}

func TestMeshDNSIsNotServedToAnAddressThatIsNotAProfileDevice(t *testing.T) {
	g := newTestNode(t, gwAddr+"/10", nil)
	d := newTestNode(t, deviceAddr+"/10", nil)
	gw := g.peerEntry()
	gw.AllowedIPs = []netip.Prefix{netip.MustParsePrefix("100.64.0.0/10")}
	gw.PresharedKey = testPSK
	if err := d.dev.SetPeers([]Peer{gw}); err != nil {
		t.Fatal(err)
	}
	// D is an authenticated peer but is not in the forwarding table: not a profile device.
	if err := g.dev.SetPeers([]Peer{deviceAtGateway(d)}); err != nil {
		t.Fatal(err)
	}
	ft := NewForwardTable()
	ft.AddDevice(netip.MustParseAddr("100.64.0.99"), acl.NewNetstackFilter())
	g.dev.SetForwarding(ft)
	if err := g.dev.SetMeshDNS(meshNames(t, netip.AddrPort{})); err != nil {
		t.Fatal(err)
	}
	if _, err := ask(t, d.dev, "udp", "laptop.example.com.", 4*time.Second); err == nil {
		t.Fatal("a peer that is not a profile device was answered")
	}
}

// allowAllNames lets the device reach every host meshNames defines, so a test about
// resolution, not about visibility, is not hidden by the default-deny policy of
// meshDNSPair (phase 3 hides a name the policy would not let the device reach).
func allowAllNames(g *testNode) {
	ft := g.dev.filter.forward.Load()
	allowOnly(ft.devices[netip.MustParseAddr(deviceAddr)], laptopAddr, tabletAddr, "100.64.0.12")
}
