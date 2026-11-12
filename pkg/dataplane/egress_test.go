package dataplane

import (
	"context"
	"errors"
	"io"
	"net"
	"net/netip"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

// Exit nodes (ADR 0032). The unit tests check the decision on its own; the triangle
// tests run real wireguard-go devices in this process: a device whose only peer is
// the gateway with AllowedIPs 0.0.0.0/0, as a full-tunnel profile has it, a gateway,
// and a mesh exit. The "internet" is a listener on this host's own LAN address, which
// only a client allowed the exit's LAN may reach: the same address is the proof that
// the private-range block holds when the client is not.

func pkt(proto uint8, dst string, port uint16) Packet {
	return Packet{Version: 4, Protocol: proto, Src: netip.MustParseAddr(deviceAddr), Dst: netip.MustParseAddr(dst), SrcPort: 40000, DstPort: port}
}

func TestEgressDecideRefusesTheExitsPrivateNetworks(t *testing.T) {
	c := &EgressClient{Via: EgressLocal}
	for _, dst := range []string{"10.1.2.3", "172.16.0.9", "192.168.1.1", "100.64.0.2", "127.0.0.1", "169.254.169.254", "224.0.0.251", "0.1.2.3"} {
		if err := c.Decide(pkt(ProtoTCP, dst, 80)); !errors.Is(err, errEgressPrivate) {
			t.Errorf("%s: got %v, want the private-range refusal", dst, err)
		}
	}
	for _, dst := range []string{"198.51.100.7", "8.8.8.8", "1.1.1.1"} {
		if err := c.Decide(pkt(ProtoTCP, dst, 443)); err != nil {
			t.Errorf("%s: refused an internet address: %v", dst, err)
		}
	}
	v6 := Packet{Version: 6, Protocol: ProtoTCP, Src: netip.MustParseAddr("fd7a:115c:a1e0::3"), DstPort: 443}
	for _, dst := range []string{"::1", "fe80::1", "fd00::1", "ff02::1"} {
		v6.Dst = netip.MustParseAddr(dst)
		if err := c.Decide(v6); !errors.Is(err, errEgressPrivate) {
			t.Errorf("%s: got %v, want the private-range refusal", dst, err)
		}
	}
}

func TestEgressDecideAllowLANNeverOpensLoopbackOrMetadata(t *testing.T) {
	c := &EgressClient{Via: EgressLocal, AllowLAN: true}
	if err := c.Decide(pkt(ProtoTCP, "192.168.1.1", 80)); err != nil {
		t.Fatalf("a client allowed the LAN was refused 192.168.1.1: %v", err)
	}
	for _, dst := range []string{"127.0.0.1", "169.254.169.254"} {
		if err := c.Decide(pkt(ProtoTCP, dst, 80)); !errors.Is(err, errEgressPrivate) {
			t.Errorf("%s with the LAN allowed: got %v, want refusal", dst, err)
		}
	}
}

func TestEgressDecideOnlyTCPAndUDPAndNoFragments(t *testing.T) {
	c := &EgressClient{Via: EgressLocal}
	if err := c.Decide(pkt(ProtoICMPv4, "8.8.8.8", 0)); !errors.Is(err, errEgressProto) {
		t.Errorf("ICMP: %v", err)
	}
	frag := pkt(ProtoUDP, "8.8.8.8", 0)
	frag.Fragment = true
	if err := c.Decide(frag); !errors.Is(err, errEgressFragment) {
		t.Errorf("fragment: %v", err)
	}
	if err := (&EgressClient{Via: EgressNone}).Decide(pkt(ProtoTCP, "8.8.8.8", 443)); !errors.Is(err, errEgressNoExit) {
		t.Errorf("unusable exit: %v", err)
	}
}

func TestEgressDecideExitDNSOnPort53Only(t *testing.T) {
	c := &EgressClient{Via: EgressMesh}
	if err := c.Decide(pkt(ProtoUDP, ExitDNS.String(), 53)); err != nil {
		t.Fatalf("DNS to the exit resolver refused: %v", err)
	}
	if err := c.Decide(pkt(ProtoTCP, ExitDNS.String(), 80)); err == nil {
		t.Fatal("port 80 of the exit DNS address was let out")
	}
}

func TestEgressDecideFirstMatchingRuleWins(t *testing.T) {
	c := &EgressClient{Via: EgressLocal, Rules: []InternetRule{
		{Prefix: netip.MustParsePrefix("198.51.100.7/32"), Proto: ProtoTCP, PortLo: 443, PortHi: 443, Accept: true},
		{Prefix: netip.MustParsePrefix("198.51.100.0/24"), PortHi: 65535},
	}}
	if err := c.Decide(pkt(ProtoTCP, "198.51.100.7", 443)); err != nil {
		t.Errorf("the ACCEPT above the DROP did not win: %v", err)
	}
	if err := c.Decide(pkt(ProtoTCP, "198.51.100.7", 80)); !errors.Is(err, errEgressRule) {
		t.Errorf("port 80: %v, want the DROP", err)
	}
	if err := c.Decide(pkt(ProtoUDP, "203.0.113.1", 53)); err != nil {
		t.Errorf("no rule matches, the grant accepts: %v", err)
	}
}

func TestEgressTableKeepsMeshTrafficOffTheExitPath(t *testing.T) {
	tab := NewEgressTable()
	tab.AddMeshRoute(netip.MustParsePrefix("10.20.0.0/16"))
	for dst, want := range map[string]bool{
		"100.64.0.2": false, "fd7a:115c:a1e0::2": false, "10.20.1.1": false,
		"10.21.1.1": true, "8.8.8.8": true, ExitDNS.String(): true,
	} {
		if got := tab.isInternet(netip.MustParseAddr(dst)); got != want {
			t.Errorf("isInternet(%s) = %v, want %v", dst, got, want)
		}
	}
}

func TestEgressConntrackLetsOnlyRepliesBack(t *testing.T) {
	ct := newEgressConntrack()
	now := time.Now()
	out := pkt(ProtoTCP, "198.51.100.7", 443)
	if err := ct.record(out, now); err != nil {
		t.Fatal(err)
	}
	reply := Packet{Protocol: ProtoTCP, Src: out.Dst, Dst: out.Src, SrcPort: out.DstPort, DstPort: out.SrcPort}
	if !ct.isReply(reply, now) {
		t.Fatal("the reply to an open flow was refused")
	}
	other := reply
	other.SrcPort = 444
	if ct.isReply(other, now) {
		t.Fatal("a packet from another port of the same host counted as a reply")
	}
	if ct.isReply(reply, now.Add(egressTCPTTL+time.Second)) {
		t.Fatal("an expired flow still lets packets in")
	}
}

func TestResolverFromReadsTheFirstNameserver(t *testing.T) {
	p := filepath.Join(t.TempDir(), "resolv.conf")
	if err := os.WriteFile(p, []byte("# c\nsearch x\nnameserver 10.89.0.1\nnameserver 1.1.1.1\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	got, ok := resolverFrom(p)
	if !ok || got != netip.MustParseAddrPort("10.89.0.1:53") {
		t.Fatalf("got %v %v", got, ok)
	}
}

// --- Real devices --------------------------------------------------------------

// lanAddr is a non-loopback IPv4 address of this host: the stand-in for the internet.
func lanAddr(t *testing.T) netip.Addr {
	t.Helper()
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		t.Skipf("no interface addresses: %v", err)
	}
	for _, a := range addrs {
		ipn, ok := a.(*net.IPNet)
		if !ok {
			continue
		}
		ip, ok := netip.AddrFromSlice(ipn.IP)
		if !ok {
			continue
		}
		ip = ip.Unmap()
		if ip.Is4() && !ip.IsLoopback() && !ip.IsLinkLocalUnicast() && !overlayPrefixes[0].Contains(ip) {
			return ip
		}
	}
	t.Skip("this host has no non-loopback IPv4 address to stand in for the internet")
	return netip.Addr{}
}

// hostEcho serves the nodes' echo mode on this host's network (one mode byte, then
// every byte back) and records the source address each connection came from.
type hostEcho struct {
	addr  string
	mu    sync.Mutex
	peers []netip.Addr
}

func newHostEcho(t *testing.T, ip netip.Addr) *hostEcho {
	t.Helper()
	ln, err := net.Listen("tcp", netip.AddrPortFrom(ip, 0).String())
	if err != nil {
		t.Fatalf("host listener: %v", err)
	}
	t.Cleanup(func() { ln.Close() })
	h := &hostEcho{addr: ln.Addr().String()}
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			ap, _ := netip.ParseAddrPort(c.RemoteAddr().String())
			h.mu.Lock()
			h.peers = append(h.peers, ap.Addr().Unmap())
			h.mu.Unlock()
			go func() {
				defer c.Close()
				one := make([]byte, 1)
				if _, err := io.ReadFull(c, one); err != nil {
					return
				}
				_, _ = io.Copy(c, c)
			}()
		}
	}()
	return h
}

func (h *hostEcho) sources() []netip.Addr {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]netip.Addr(nil), h.peers...)
}

// fullTunnelDevice points D's only peer, the gateway, at everything.
func fullTunnelDevice(t *testing.T, d, g *testNode) {
	t.Helper()
	gw := g.peerEntry()
	gw.AllowedIPs = []netip.Prefix{netip.MustParsePrefix("0.0.0.0/0"), netip.MustParsePrefix("::/0")}
	gw.PresharedKey = testPSK
	if err := d.dev.SetPeers([]Peer{gw}); err != nil {
		t.Fatalf("D peers: %v", err)
	}
}

func deviceAtGateway(d *testNode) Peer {
	p := d.peerEntry()
	p.PresharedKey = testPSK
	p.Endpoint = ""
	return p
}

func egressFor(addr string, c *EgressClient) *EgressTable {
	tab := NewEgressTable()
	tab.AddClient(netip.MustParseAddr(addr), c)
	return tab
}

func TestGatewayExitDialsTheInternetForAFullTunnelDevice(t *testing.T) {
	lan := lanAddr(t)
	g := newTestNode(t, gwAddr+"/10", nil)
	d := newTestNode(t, deviceAddr+"/10", nil)
	fullTunnelDevice(t, d, g)
	if err := g.dev.SetPeers([]Peer{deviceAtGateway(d)}); err != nil {
		t.Fatal(err)
	}
	echo := newHostEcho(t, lan)

	// Not allowed the gateway's LAN: the same address is refused.
	if err := g.dev.SetEgress(egressFor(deviceAddr, &EgressClient{ID: "dev", Via: EgressLocal}), netip.AddrPort{}); err != nil {
		t.Fatal(err)
	}
	if err := echoWithin(t, d.dev, echo.addr, 5*time.Second); err == nil {
		t.Fatal("the device reached the gateway's LAN through the exit without being allowed it")
	}
	if st := g.dev.Stats(); st.EgressDropped == 0 {
		t.Fatalf("the gateway counted no egress drop: %+v", st)
	}
	if n := len(echo.sources()); n != 0 {
		t.Fatalf("the LAN listener saw %d connection(s) it must not have", n)
	}

	// Allowed: real TCP leaves from the gateway's host, with the host's address.
	if err := g.dev.SetEgress(egressFor(deviceAddr, &EgressClient{ID: "dev", Via: EgressLocal, AllowLAN: true}), netip.AddrPort{}); err != nil {
		t.Fatal(err)
	}
	if err := echoWithin(t, d.dev, echo.addr, 10*time.Second); err != nil {
		t.Fatalf("device -> internet through the gateway exit: %v", err)
	}
	for _, src := range echo.sources() {
		if overlayPrefixes[0].Contains(src) {
			t.Fatalf("the internet saw the device's overlay address %s, not the exit's", src)
		}
	}
	if st := g.dev.Stats(); st.Egressed == 0 {
		t.Fatalf("the gateway counted nothing egressed: %+v", st)
	}
}

func TestExitDNSIsAnsweredByTheExitsResolver(t *testing.T) {
	g := newTestNode(t, gwAddr+"/10", nil)
	d := newTestNode(t, deviceAddr+"/10", nil)
	fullTunnelDevice(t, d, g)
	if err := g.dev.SetPeers([]Peer{deviceAtGateway(d)}); err != nil {
		t.Fatal(err)
	}
	// The "resolver" answers every datagram with its own bytes reversed.
	pc, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { pc.Close() })
	go func() {
		buf := make([]byte, 512)
		for {
			n, from, err := pc.ReadFrom(buf)
			if err != nil {
				return
			}
			out := make([]byte, n)
			for i := range out {
				out[i] = buf[n-1-i]
			}
			_, _ = pc.WriteTo(out, from)
		}
	}()
	upstream := netip.MustParseAddrPort(pc.LocalAddr().String())
	if err := g.dev.SetEgress(egressFor(deviceAddr, &EgressClient{ID: "dev", Via: EgressLocal}), upstream); err != nil {
		t.Fatal(err)
	}

	deadline := time.Now().Add(10 * time.Second)
	for {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		c, err := d.dev.DialContext(ctx, "udp", netip.AddrPortFrom(ExitDNS, 53).String())
		cancel()
		if err == nil {
			_ = c.SetDeadline(time.Now().Add(time.Second))
			_, _ = c.Write([]byte("query"))
			buf := make([]byte, 16)
			n, rerr := c.Read(buf)
			c.Close()
			if rerr == nil && string(buf[:n]) == "yreuq" {
				return
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("no answer from the exit resolver through ExitDNS (last error %v)", err)
		}
	}
}

// meshExit wires D -> G -> X: the gateway relays D's internet traffic to the mesh exit
// X, which holds the default route in G's peer set.
type meshExit struct {
	g, d, x *testNode
}

func newMeshExit(t *testing.T) *meshExit {
	t.Helper()
	g := newTestNode(t, gwAddr+"/10", nil)
	x := newTestNode(t, meshAddr+"/10", nil)
	d := newTestNode(t, deviceAddr+"/10", nil)
	fullTunnelDevice(t, d, g)

	exitAtGw := x.peerEntry()
	exitAtGw.AllowedIPs = append(exitAtGw.AllowedIPs, netip.MustParsePrefix("0.0.0.0/0"), netip.MustParsePrefix("::/0"))
	if err := g.dev.SetPeers([]Peer{exitAtGw, deviceAtGateway(d)}); err != nil {
		t.Fatal(err)
	}
	gwAtExit := g.peerEntry()
	gwAtExit.AllowedIPs = []netip.Prefix{prefix32(gwAddr), prefix32(deviceAddr)}
	if err := x.dev.SetPeers([]Peer{gwAtExit}); err != nil {
		t.Fatal(err)
	}
	if err := g.dev.SetEgress(egressFor(deviceAddr, &EgressClient{ID: "dev", Via: EgressMesh, AllowLAN: true}), netip.AddrPort{}); err != nil {
		t.Fatal(err)
	}
	if err := x.dev.SetEgress(egressFor(deviceAddr, &EgressClient{ID: "dev", Via: EgressLocal, AllowLAN: true}), netip.AddrPort{}); err != nil {
		t.Fatal(err)
	}
	return &meshExit{g: g, d: d, x: x}
}

func TestMeshExitCarriesTheDevicesInternetTrafficAndDropsWhenItIsGone(t *testing.T) {
	lan := lanAddr(t)
	m := newMeshExit(t)
	echo := newHostEcho(t, lan)

	if err := echoWithin(t, m.d.dev, echo.addr, 15*time.Second); err != nil {
		t.Fatalf("device -> internet through the mesh exit: %v", err)
	}
	if st := m.g.dev.Stats(); st.Egressed == 0 || st.Forwarded == 0 {
		t.Fatalf("the gateway relayed nothing to the exit or back: %+v", st)
	}
	if st := m.x.dev.Stats(); st.Egressed == 0 {
		t.Fatalf("the exit dialled nothing: %+v", st)
	}

	// The exit leaves the peer set, as it does when it is stopped: the gateway now has
	// no usable exit for the device and must not send its traffic anywhere else.
	exitAtGw := m.x.peerEntry()
	if err := m.g.dev.SetPeers([]Peer{exitAtGw, deviceAtGateway(m.d)}); err != nil {
		t.Fatal(err)
	}
	if err := m.g.dev.SetEgress(egressFor(deviceAddr, &EgressClient{ID: "dev", Via: EgressNone}), netip.AddrPort{}); err != nil {
		t.Fatal(err)
	}
	before := len(echo.sources())
	dropped := m.g.dev.Stats().EgressDropped
	if err := echoWithin(t, m.d.dev, echo.addr, 4*time.Second); err == nil {
		t.Fatal("the device reached the internet with its exit gone")
	}
	if got := len(echo.sources()); got != before {
		t.Fatalf("the internet saw %d new connection(s) with the exit gone", got-before)
	}
	if m.g.dev.Stats().EgressDropped == dropped {
		t.Fatal("the gateway counted no drop for the device's traffic with the exit gone")
	}
}

func TestMeshExitRefusesTheExitsLANUnlessAllowed(t *testing.T) {
	lan := lanAddr(t)
	m := newMeshExit(t)
	echo := newHostEcho(t, lan)
	// The gateway lets it through (its own copy of the client allows the LAN); the exit
	// does not. The exit's check is the one that protects the exit's network.
	if err := m.x.dev.SetEgress(egressFor(deviceAddr, &EgressClient{ID: "dev", Via: EgressLocal}), netip.AddrPort{}); err != nil {
		t.Fatal(err)
	}
	if err := echoWithin(t, m.d.dev, echo.addr, 5*time.Second); err == nil {
		t.Fatal("the device reached the exit's LAN without being allowed it")
	}
	if st := m.x.dev.Stats(); st.EgressDropped == 0 {
		t.Fatalf("the exit counted no drop: %+v", st)
	}
}

func TestMeshNodeCannotInjectTrafficToADeviceThatIsNoReply(t *testing.T) {
	m := newMeshExit(t)
	tab := m.g.dev.filter.egress.Load()
	unsolicited := Packet{Protocol: ProtoTCP, Src: netip.MustParseAddr("198.51.100.9"), Dst: netip.MustParseAddr(deviceAddr), SrcPort: 443, DstPort: 40000}
	if tab.ct.isReply(unsolicited, time.Now()) {
		t.Fatal("an unsolicited packet from the internet counted as a reply")
	}
}
