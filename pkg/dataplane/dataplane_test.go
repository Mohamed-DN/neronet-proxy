package dataplane

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"io"
	"net"
	"net/netip"
	"strings"
	"testing"
	"time"

	"github.com/sovereign/proxy/v4/pkg/crypto"
)

// testNode is one end of a tunnel built entirely in this process.
type testNode struct {
	keys *crypto.Keypair
	dev  *Device
	addr netip.Addr
	port uint16
}

func newTestNode(t *testing.T, address string, filter PacketFilter) *testNode {
	t.Helper()

	keys, err := crypto.GenerateKeypair()
	if err != nil {
		t.Fatalf("generating identity: %v", err)
	}

	prefix, err := netip.ParsePrefix(address)
	if err != nil {
		t.Fatalf("parsing %q: %v", address, err)
	}

	dev, err := New(Config{
		Mode:       ModeNetstack,
		PrivateKey: keys.PrivateKey,
		Addresses:  []netip.Prefix{prefix},
		Filter:     filter,
	})
	if err != nil {
		t.Fatalf("bringing up device on %s: %v", address, err)
	}
	t.Cleanup(func() { dev.Close() })

	port, err := dev.ListenPort()
	if err != nil {
		t.Fatalf("reading listen port: %v", err)
	}
	if port == 0 {
		t.Fatal("device reported listen port 0 after binding")
	}

	return &testNode{keys: keys, dev: dev, addr: prefix.Addr(), port: port}
}

func (n *testNode) peerEntry() Peer {
	return Peer{
		PublicKey:           hex.EncodeToString(n.keys.PublicKey[:]),
		Endpoint:            fmt.Sprintf("127.0.0.1:%d", n.port),
		AllowedIPs:          []netip.Prefix{netip.PrefixFrom(n.addr, n.addr.BitLen())},
		PersistentKeepalive: 1,
	}
}

// pair builds two nodes that know each other.
func pair(t *testing.T, filterA, filterB PacketFilter) (*testNode, *testNode) {
	t.Helper()

	a := newTestNode(t, "100.64.0.1/10", filterA)
	b := newTestNode(t, "100.64.0.2/10", filterB)

	if err := a.dev.SetPeers([]Peer{b.peerEntry()}); err != nil {
		t.Fatalf("setting peers on A: %v", err)
	}
	if err := b.dev.SetPeers([]Peer{a.peerEntry()}); err != nil {
		t.Fatalf("setting peers on B: %v", err)
	}
	return a, b
}

// TestTunnelCarriesTCP is the criterion this package exists for: a TCP stream
// between two overlay addresses, with no interface, no capability and no route on
// the host.
func TestTunnelCarriesTCP(t *testing.T) {
	a, b := pair(t, nil, nil)

	const marker = "WP201-PLAINTEXT-MARKER"

	responder, err := ListenEcho(b.dev, 9999, nil)
	if err != nil {
		t.Fatalf("starting responder on B: %v", err)
	}
	t.Cleanup(func() { responder.Close() })

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	conn, err := dialWithRetry(ctx, a.dev, "100.64.0.2:9999")
	if err != nil {
		t.Fatalf("dialling B over the overlay: %v", err)
	}
	defer conn.Close()

	if err := conn.SetDeadline(time.Now().Add(10 * time.Second)); err != nil {
		t.Fatalf("setting deadline: %v", err)
	}

	if _, err := conn.Write(append([]byte{ModeByteEcho}, marker...)); err != nil {
		t.Fatalf("writing through the tunnel: %v", err)
	}

	got := make([]byte, len(marker))
	if _, err := io.ReadFull(conn, got); err != nil {
		t.Fatalf("reading through the tunnel: %v", err)
	}
	if string(got) != marker {
		t.Fatalf("echo returned %q, want %q", got, marker)
	}

	peers, err := a.dev.Peers()
	if err != nil {
		t.Fatalf("reading peer state: %v", err)
	}
	if len(peers) != 1 || peers[0].LastHandshake.IsZero() {
		t.Fatalf("A has %d peer(s) and last handshake %v: traffic passed without a handshake", len(peers), peers[0].LastHandshake)
	}
	if peers[0].RxBytes == 0 || peers[0].TxBytes == 0 {
		t.Fatalf("peer counters rx=%d tx=%d: no encrypted bytes were accounted", peers[0].RxBytes, peers[0].TxBytes)
	}
}

// TestTunnelPayloadIsNotOnTheWire watches the UDP the two devices exchange and
// checks the marker never appears in it. Without this the test above would pass
// just as well over a plain socket.
func TestTunnelPayloadIsNotOnTheWire(t *testing.T) {
	const marker = "WP201-PLAINTEXT-MARKER"

	// A relay in the middle: both devices point at it, it forwards and keeps a copy
	// of every datagram. This is the in-process equivalent of the tcpdump sidecar
	// used for the container measurement.
	relay, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatalf("starting relay: %v", err)
	}
	defer relay.Close()

	a := newTestNode(t, "100.64.0.1/10", nil)
	b := newTestNode(t, "100.64.0.2/10", nil)

	relayPort := uint16(relay.LocalAddr().(*net.UDPAddr).Port)

	viaRelay := func(n *testNode) Peer {
		p := n.peerEntry()
		p.Endpoint = fmt.Sprintf("127.0.0.1:%d", relayPort)
		return p
	}
	if err := a.dev.SetPeers([]Peer{viaRelay(b)}); err != nil {
		t.Fatalf("setting peers on A: %v", err)
	}
	if err := b.dev.SetPeers([]Peer{viaRelay(a)}); err != nil {
		t.Fatalf("setting peers on B: %v", err)
	}

	captured := make(chan []byte, 512)
	done := make(chan struct{})
	go func() {
		defer close(done)
		buf := make([]byte, 65535)
		for {
			n, from, err := relay.ReadFromUDP(buf)
			if err != nil {
				return
			}
			datagram := append([]byte(nil), buf[:n]...)
			select {
			case captured <- datagram:
			default:
			}

			to := &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: int(b.port)}
			if from.Port == int(b.port) {
				to = &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: int(a.port)}
			}
			if _, err := relay.WriteToUDP(datagram, to); err != nil {
				return
			}
		}
	}()

	responder, err := ListenEcho(b.dev, 9999, nil)
	if err != nil {
		t.Fatalf("starting responder on B: %v", err)
	}
	defer responder.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	conn, err := dialWithRetry(ctx, a.dev, "100.64.0.2:9999")
	if err != nil {
		t.Fatalf("dialling B over the overlay: %v", err)
	}
	defer conn.Close()

	_ = conn.SetDeadline(time.Now().Add(10 * time.Second))
	if _, err := conn.Write(append([]byte{ModeByteEcho}, marker...)); err != nil {
		t.Fatalf("writing through the tunnel: %v", err)
	}
	got := make([]byte, len(marker))
	if _, err := io.ReadFull(conn, got); err != nil {
		t.Fatalf("reading through the tunnel: %v", err)
	}

	relay.Close()
	<-done
	close(captured)

	datagrams := 0
	for d := range captured {
		datagrams++
		if bytes.Contains(d, []byte(marker)) {
			t.Fatalf("the plaintext marker appeared in datagram %d on the wire", datagrams)
		}
		// Every WireGuard message begins with a one byte type, 1 to 4, followed by
		// three reserved zero bytes. Anything else is not the transport D2 selected.
		if len(d) < 4 || d[0] < 1 || d[0] > 4 || d[1] != 0 || d[2] != 0 || d[3] != 0 {
			t.Fatalf("datagram %d is not a WireGuard message: % x", datagrams, d[:min(8, len(d))])
		}
	}
	if datagrams == 0 {
		t.Fatal("no datagrams crossed the relay: the tunnel did not use it")
	}
}

// dialWithRetry keeps trying until the handshake has completed. The first dial
// after a device comes up races the handshake, and a test that failed on that race
// would be a flaky test rather than a broken tunnel.
func dialWithRetry(ctx context.Context, d *Device, address string) (net.Conn, error) {
	var lastErr error
	for {
		if ctx.Err() != nil {
			return nil, fmt.Errorf("dialling %s: %w (last attempt: %v)", address, ctx.Err(), lastErr)
		}
		attempt, cancel := context.WithTimeout(ctx, 2*time.Second)
		conn, err := d.DialContext(attempt, "tcp", address)
		cancel()
		if err == nil {
			return conn, nil
		}
		lastErr = err
		select {
		case <-ctx.Done():
		case <-time.After(200 * time.Millisecond):
		}
	}
}

func TestTunnelICMPPing(t *testing.T) {
	a, _ := pair(t, nil, nil)

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	var (
		rtt     time.Duration
		err     error
		lastErr error
	)
	for ctx.Err() == nil {
		pingCtx, pingCancel := context.WithTimeout(ctx, 2*time.Second)
		rtt, err = a.dev.Ping(pingCtx, netip.MustParseAddr("100.64.0.2"))
		pingCancel()
		if err == nil {
			break
		}
		lastErr = err
		time.Sleep(200 * time.Millisecond)
	}
	if err != nil {
		t.Fatalf("no ICMP echo reply came back through the tunnel: %v", lastErr)
	}
	if rtt <= 0 {
		t.Fatalf("ping reported %v: a round trip cannot take no time", rtt)
	}
}

func TestSetPeersReplacesTheWholeSet(t *testing.T) {
	a := newTestNode(t, "100.64.0.1/10", nil)
	b := newTestNode(t, "100.64.0.2/10", nil)
	c := newTestNode(t, "100.64.0.3/10", nil)

	if err := a.dev.SetPeers([]Peer{b.peerEntry(), c.peerEntry()}); err != nil {
		t.Fatalf("setting two peers: %v", err)
	}
	peers, err := a.dev.Peers()
	if err != nil {
		t.Fatalf("reading peers: %v", err)
	}
	if len(peers) != 2 {
		t.Fatalf("device holds %d peers, want 2", len(peers))
	}

	// A document that no longer lists B must remove B. A merge would leave a
	// withdrawn node reachable, which is the failure the revocation path already
	// has elsewhere in this code base.
	if err := a.dev.SetPeers([]Peer{c.peerEntry()}); err != nil {
		t.Fatalf("replacing the peer set: %v", err)
	}
	peers, err = a.dev.Peers()
	if err != nil {
		t.Fatalf("reading peers: %v", err)
	}
	if len(peers) != 1 {
		t.Fatalf("device holds %d peers after replacement, want 1", len(peers))
	}
	if !strings.EqualFold(peers[0].PublicKey, hex.EncodeToString(c.keys.PublicKey[:])) {
		t.Fatalf("surviving peer is %s, want C", peers[0].PublicKey)
	}
}

func TestSetPeersRejectsBadDocumentWithoutApplyingIt(t *testing.T) {
	a := newTestNode(t, "100.64.0.1/10", nil)
	b := newTestNode(t, "100.64.0.2/10", nil)

	if err := a.dev.SetPeers([]Peer{b.peerEntry()}); err != nil {
		t.Fatalf("setting the initial peer: %v", err)
	}

	good := b.peerEntry()
	bad := b.peerEntry()
	bad.PublicKey = "not-a-key"

	if err := a.dev.SetPeers([]Peer{good, bad}); err == nil {
		t.Fatal("SetPeers accepted a document with an unusable public key")
	}

	peers, err := a.dev.Peers()
	if err != nil {
		t.Fatalf("reading peers: %v", err)
	}
	if len(peers) != 1 {
		t.Fatalf("device holds %d peers after a rejected document, want the previous 1", len(peers))
	}
}

func TestSetPeersRejectsDuplicateKeys(t *testing.T) {
	a := newTestNode(t, "100.64.0.1/10", nil)
	b := newTestNode(t, "100.64.0.2/10", nil)

	dup := b.peerEntry()
	dup.AllowedIPs = []netip.Prefix{netip.MustParsePrefix("100.64.0.9/32")}

	// Two entries for one key are not a peer set: wireguard-go would apply the last
	// one and the node would silently disagree with the document it was given.
	if err := a.dev.SetPeers([]Peer{b.peerEntry(), dup}); err == nil {
		t.Fatal("SetPeers accepted the same public key twice")
	}
}

func TestSetPeersRejectsPeerWithoutAllowedIPs(t *testing.T) {
	a := newTestNode(t, "100.64.0.1/10", nil)
	b := newTestNode(t, "100.64.0.2/10", nil)

	p := b.peerEntry()
	p.AllowedIPs = nil

	if err := a.dev.SetPeers([]Peer{p}); err == nil {
		t.Fatal("SetPeers accepted a peer that no packet could ever be routed to")
	}
}

// TestFilterBlocksTunnelledTraffic runs the real ACL vocabulary over the real
// tunnel: the same stream that works with no filter must not arrive when the
// receiving node's policy does not allow the port.
func TestFilterBlocksTunnelledTraffic(t *testing.T) {
	a, b := pair(t, nil, denyPort{port: 9999})

	responder, err := ListenEcho(b.dev, 9999, nil)
	if err != nil {
		t.Fatalf("starting responder on B: %v", err)
	}
	defer responder.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()

	conn, err := a.dev.DialContext(ctx, "tcp", "100.64.0.2:9999")
	if err == nil {
		conn.Close()
		t.Fatal("the connection was established although the receiving node drops every packet for that port")
	}

	if stats := b.dev.Stats(); stats.InboundDropped == 0 {
		t.Fatalf("B dropped %d inbound packets: the filter was not on the path", stats.InboundDropped)
	}
}

type denyPort struct{ port uint16 }

func (d denyPort) Outbound(Packet) error { return nil }

func (d denyPort) Inbound(p Packet) error {
	if p.DstPort == d.port {
		return fmt.Errorf("port %d is not allowed", d.port)
	}
	return nil
}

func TestDeviceRejectsModeOffAndMissingAddresses(t *testing.T) {
	if _, err := New(Config{Mode: ModeOff}); err != ErrModeOff {
		t.Fatalf("New with mode off returned %v, want ErrModeOff", err)
	}
	if _, err := New(Config{Mode: ModeNetstack}); err != ErrNoAddresses {
		t.Fatalf("New with no addresses returned %v, want ErrNoAddresses", err)
	}
}

func TestClosedDeviceRefusesWork(t *testing.T) {
	a := newTestNode(t, "100.64.0.1/10", nil)
	if err := a.dev.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if err := a.dev.Close(); err != nil {
		t.Fatalf("second Close: %v", err)
	}
	if err := a.dev.SetPeers(nil); err != ErrClosed {
		t.Fatalf("SetPeers after Close returned %v, want ErrClosed", err)
	}
	if _, err := a.dev.DialContext(context.Background(), "tcp", "100.64.0.2:1"); err != ErrClosed {
		t.Fatalf("DialContext after Close returned %v, want ErrClosed", err)
	}
}

func TestParseMode(t *testing.T) {
	for in, want := range map[string]Mode{
		"":         ModeOff,
		"off":      ModeOff,
		"netstack": ModeNetstack,
		"NetStack": ModeNetstack,
		" tun ":    ModeTUN,
	} {
		got, err := ParseMode(in)
		if err != nil {
			t.Errorf("ParseMode(%q): %v", in, err)
			continue
		}
		if got != want {
			t.Errorf("ParseMode(%q) = %q, want %q", in, got, want)
		}
	}
	if _, err := ParseMode("kernel"); err == nil {
		t.Error("ParseMode accepted an unknown mode")
	}
}

func TestICMPChecksumIsCorrect(t *testing.T) {
	msg := buildICMPEcho(icmpEchoRequest, 0x1234, 0x0001, []byte("abcdefgh"))
	if onesComplementChecksum(msg) != 0 {
		t.Fatalf("checksum over a message including its own checksum is %#x, want 0", onesComplementChecksum(msg))
	}
	if msg[0] != icmpEchoRequest {
		t.Fatalf("message type is %d, want %d", msg[0], icmpEchoRequest)
	}
	if binary.BigEndian.Uint16(msg[4:6]) != 0x1234 {
		t.Fatal("identifier was not written into the echo header")
	}
}
