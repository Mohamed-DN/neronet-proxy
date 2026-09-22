package main

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/netip"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"testing"
	"time"

	"github.com/sovereign/proxy/v4/pkg/acl"
	"github.com/sovereign/proxy/v4/pkg/bridge"
	"github.com/sovereign/proxy/v4/pkg/control"
	"github.com/sovereign/proxy/v4/pkg/crypto"
	"github.com/sovereign/proxy/v4/pkg/dataplane"
)

// Everything here runs two real WireGuard devices in this process and sends real TCP
// between them. Nothing reads a source file or asserts on a log line: the question
// these tests answer is whether a packet crosses, and the only way to answer it is to
// send one.

type overlayNode struct {
	keys      *crypto.Keypair
	dev       *dataplane.Device
	netfilter *acl.NetstackFilter
	addr      netip.Addr
	port      uint16
}

func newOverlayNode(t *testing.T, address string) *overlayNode {
	t.Helper()

	keys, err := crypto.GenerateKeypair()
	if err != nil {
		t.Fatalf("generating identity: %v", err)
	}

	prefix, err := netip.ParsePrefix(address)
	if err != nil {
		t.Fatalf("parsing %q: %v", address, err)
	}

	netfilter := acl.NewNetstackFilter()

	dev, err := dataplane.New(dataplane.Config{
		Mode:       dataplane.ModeNetstack,
		PrivateKey: keys.PrivateKey,
		Addresses:  []netip.Prefix{prefix},
		// The same filter the node installs, and it is installed before the device
		// can carry anything.
		Filter: dataplane.NewACLFilter(netfilter),
	})
	if err != nil {
		t.Fatalf("bringing up a device on %s: %v", address, err)
	}
	t.Cleanup(func() { dev.Close() })

	port, err := dev.ListenPort()
	if err != nil {
		t.Fatalf("reading the listen port: %v", err)
	}

	return &overlayNode{keys: keys, dev: dev, netfilter: netfilter, addr: prefix.Addr(), port: port}
}

func (n *overlayNode) keyHex() string { return hex.EncodeToString(n.keys.PublicKey[:]) }

// peerEntry describes this node the way a netmap would.
//
// Keepalive is zero here on purpose. A configured keepalive makes a peer send the
// moment it is added, so both ends start a handshake at the same instant, each
// rejects the other's response as unsolicited, and neither can retry until the five
// second rekey timeout. Nothing in this process is behind NAT, so it would cost five
// seconds per test and buy nothing.
func (n *overlayNode) peerEntry(nodeID string) control.NetmapPeer {
	return control.NetmapPeer{
		NodeID:       nodeID,
		PublicKeyHex: n.keyHex(),
		AllowedIPs:   []string{netip.PrefixFrom(n.addr, n.addr.BitLen()).String()},
		Endpoints:    []string{fmt.Sprintf("127.0.0.1:%d", n.port)},
	}
}

func allowAllPolicy(nodeID string, self netip.Addr, peers ...netip.Addr) *acl.CompiledPeerPolicy {
	policy := &acl.CompiledPeerPolicy{
		NodeID:      nodeID,
		OverlayIPv4: net.IP(self.AsSlice()),
		Epoch:       1,
	}
	for _, peer := range peers {
		rule := acl.CompiledFilterRule{
			AllowedPeerVIP: net.IP(peer.AsSlice()),
			Protocol:       acl.ProtocolALL,
			PortRanges:     []acl.PortRange{{Start: 0, End: 65535}},
			Action:         acl.ActionAccept,
		}
		policy.InboundRules = append(policy.InboundRules, rule)
		policy.OutboundRules = append(policy.OutboundRules, rule)
	}
	return policy
}

func netmapFor(version uint64, self netip.Addr, policy *acl.CompiledPeerPolicy, peers ...control.NetmapPeer) *control.NetmapResponse {
	return &control.NetmapResponse{
		Version: version,
		Self: control.NetmapSelf{
			OverlayIPv4: self.String(),
			MTU:         1380,
			ListenPort:  dataplane.DefaultListenPort,
		},
		Peers:               peers,
		ACL:                 policy,
		RevokedKeys:         []string{},
		GeneratedAtUnix:     time.Now().Unix(),
		MaxStalenessSeconds: 86400,
	}
}

func managerFor(t *testing.T, node *overlayNode) *netmapManager {
	t.Helper()
	identity := filepath.Join(t.TempDir(), "node.key")
	return newNetmapManager(nil, node.dev, node.netfilter, identity, node.port, "", node.keys.PublicKey, nil)
}

// echoOnce listens on `listener`'s node and dials it from `from`, returning the error
// the dial or the exchange produced.
func echoOnce(t *testing.T, from *overlayNode, target netip.Addr, port uint16, timeout time.Duration) error {
	t.Helper()

	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	conn, err := from.dev.DialContext(ctx, "tcp", net.JoinHostPort(target.String(), strconv.Itoa(int(port))))
	if err != nil {
		return err
	}
	defer conn.Close()

	_ = conn.SetDeadline(time.Now().Add(timeout))

	const marker = "NETMAP-PROBE"
	if _, err := conn.Write(append([]byte{dataplane.ModeByteEcho}, marker...)); err != nil {
		return err
	}

	buf := make([]byte, len(marker))
	if _, err := io.ReadFull(conn, buf); err != nil {
		return err
	}
	if string(buf) != marker {
		return fmt.Errorf("echoed %q, sent %q", buf, marker)
	}
	return nil
}

// waitForPeers polls the device until it reports the expected number of peers.
func peerCount(t *testing.T, dev *dataplane.Device) int {
	t.Helper()
	peers, err := dev.Peers()
	if err != nil {
		t.Fatalf("reading device peers: %v", err)
	}
	return len(peers)
}

const echoPort = 9411

func TestNetmapAppliesPeersAndLetsPermittedTrafficThrough(t *testing.T) {
	a := newOverlayNode(t, "100.64.0.1/10")
	b := newOverlayNode(t, "100.64.0.2/10")

	managerA := managerFor(t, a)
	managerB := managerFor(t, b)

	if err := managerA.Apply(netmapFor(2, a.addr, allowAllPolicy("a", a.addr, b.addr), b.peerEntry("b")), time.Now()); err != nil {
		t.Fatalf("applying A's netmap: %v", err)
	}
	if err := managerB.Apply(netmapFor(2, b.addr, allowAllPolicy("b", b.addr, a.addr), a.peerEntry("a")), time.Now()); err != nil {
		t.Fatalf("applying B's netmap: %v", err)
	}

	if got := managerA.Version(); got != 2 {
		t.Fatalf("applied version = %d, want 2", got)
	}
	if got := peerCount(t, a.dev); got != 1 {
		t.Fatalf("A holds %d peer(s), want 1", got)
	}

	echo, err := dataplane.ListenEcho(b.dev, echoPort, nil)
	if err != nil {
		t.Fatalf("starting the echo on B: %v", err)
	}
	defer echo.Close()

	if err := echoOnce(t, a, b.addr, echoPort, 15*time.Second); err != nil {
		t.Fatalf("a permitted overlay exchange failed: %v", err)
	}
}

// The attack the card asks for: a node handed a netmap whose peer set contains a key
// it should not have still enforces its own policy.
//
// B's netmap is forged to carry A as a peer -- the key, the allowed IPs and the
// endpoint, everything a tunnel needs -- while B's compiled policy names nobody. The
// tunnel comes up and the traffic still does not pass, because the peer set decides
// what can be carried and the filter decides what may be.
func TestForgedNetmapPeerStillCannotPassDeniedTraffic(t *testing.T) {
	a := newOverlayNode(t, "100.64.0.3/10")
	b := newOverlayNode(t, "100.64.0.4/10")

	managerA := managerFor(t, a)
	managerB := managerFor(t, b)

	// A is told everything is permitted, so it really sends.
	if err := managerA.Apply(netmapFor(5, a.addr, allowAllPolicy("a", a.addr, b.addr), b.peerEntry("b")), time.Now()); err != nil {
		t.Fatalf("applying A's netmap: %v", err)
	}

	// B's document is the forged one: the peer is there, the policy is not.
	denyAll := &acl.CompiledPeerPolicy{NodeID: "b", OverlayIPv4: net.IP(b.addr.AsSlice()), Epoch: 5}
	if err := managerB.Apply(netmapFor(5, b.addr, denyAll, a.peerEntry("a")), time.Now()); err != nil {
		t.Fatalf("applying B's forged netmap: %v", err)
	}

	if got := peerCount(t, b.dev); got != 1 {
		t.Fatalf("B holds %d peer(s), want the forged 1: the test would pass for the wrong reason", got)
	}

	echo, err := dataplane.ListenEcho(b.dev, echoPort, nil)
	if err != nil {
		t.Fatalf("starting the echo on B: %v", err)
	}
	defer echo.Close()

	if err := echoOnce(t, a, b.addr, echoPort, 4*time.Second); err == nil {
		t.Fatal("traffic the policy denies crossed a tunnel built from a forged netmap")
	}

	// A dropped packet is silent by design, so the counter is what shows the filter
	// acted rather than the packet being lost.
	if stats := b.dev.Stats(); stats.InboundDropped == 0 {
		t.Fatalf("B dropped nothing inbound: %+v", stats)
	}
}

// A netmap that carries peers and no policy leaves the node at default deny. pkg/acl
// with no policy loaded drops everything, and this is the state a node is in between
// start-up and its first document.
func TestNetmapWithoutAPolicyMovesNothing(t *testing.T) {
	a := newOverlayNode(t, "100.64.0.5/10")
	b := newOverlayNode(t, "100.64.0.6/10")

	managerA := managerFor(t, a)
	managerB := managerFor(t, b)

	if err := managerA.Apply(netmapFor(1, a.addr, nil, b.peerEntry("b")), time.Now()); err != nil {
		t.Fatalf("applying A's netmap: %v", err)
	}
	if err := managerB.Apply(netmapFor(1, b.addr, nil, a.peerEntry("a")), time.Now()); err != nil {
		t.Fatalf("applying B's netmap: %v", err)
	}

	echo, err := dataplane.ListenEcho(b.dev, echoPort, nil)
	if err != nil {
		t.Fatalf("starting the echo on B: %v", err)
	}
	defer echo.Close()

	if err := echoOnce(t, a, b.addr, echoPort, 4*time.Second); err == nil {
		t.Fatal("a node with no policy carried traffic: default deny is not in force")
	}
}

func TestRevocationRemovesThePeerWithoutANewNetmap(t *testing.T) {
	a := newOverlayNode(t, "100.64.0.7/10")
	b := newOverlayNode(t, "100.64.0.8/10")

	managerA := managerFor(t, a)
	if err := managerA.Apply(netmapFor(3, a.addr, allowAllPolicy("a", a.addr, b.addr), b.peerEntry("b")), time.Now()); err != nil {
		t.Fatalf("applying A's netmap: %v", err)
	}
	if got := peerCount(t, a.dev); got != 1 {
		t.Fatalf("A holds %d peer(s) before the revocation, want 1", got)
	}

	managerA.ApplyRevocations([]string{b.keyHex()})

	if got := peerCount(t, a.dev); got != 0 {
		t.Fatalf("A still holds %d peer(s) after the revocation", got)
	}
	// The version has not moved: a revocation is applied without one.
	if got := managerA.Version(); got != 3 {
		t.Fatalf("version = %d after a revocation, want it unchanged at 3", got)
	}
}

// A revoked key must stay revoked when the next document still names it. The control
// plane compiles it out, but a node that trusted the document over the revocation
// would re-admit the peer on the next version bump.
func TestARevokedKeyIsNotReadmittedByALaterNetmap(t *testing.T) {
	a := newOverlayNode(t, "100.64.0.9/10")
	b := newOverlayNode(t, "100.64.0.10/10")

	managerA := managerFor(t, a)
	managerA.ApplyRevocations([]string{b.keyHex()})

	if err := managerA.Apply(netmapFor(4, a.addr, allowAllPolicy("a", a.addr, b.addr), b.peerEntry("b")), time.Now()); err != nil {
		t.Fatalf("applying A's netmap: %v", err)
	}

	if got := peerCount(t, a.dev); got != 0 {
		t.Fatalf("A admitted %d revoked peer(s) from a later netmap", got)
	}
}

func TestStalenessRemovesEveryPeerAndIsAppliedOnce(t *testing.T) {
	a := newOverlayNode(t, "100.64.0.11/10")
	b := newOverlayNode(t, "100.64.0.12/10")

	managerA := managerFor(t, a)

	netmap := netmapFor(6, a.addr, allowAllPolicy("a", a.addr, b.addr), b.peerEntry("b"))
	netmap.MaxStalenessSeconds = 60
	netmapTime := time.Now().Add(-30 * time.Second)
	netmap.GeneratedAtUnix = netmapTime.Unix()

	if err := managerA.Apply(netmap, time.Now()); err != nil {
		t.Fatalf("applying A's netmap: %v", err)
	}

	// Staleness is measured from the last time the control plane answered, not from
	// the document's own age: a fleet where nothing changed for a day is not a fleet
	// that lost its control plane.
	managerA.Confirm(netmapTime)

	// Inside the bound: fail-static, the peer stays.
	if managerA.EnforceStaleness(time.Now()) {
		t.Fatal("a netmap 30 s old was failed closed against a 60 s bound")
	}
	if got := peerCount(t, a.dev); got != 1 {
		t.Fatalf("A holds %d peer(s) inside the staleness bound, want 1", got)
	}

	// Past it: fail-closed.
	if !managerA.EnforceStaleness(time.Now().Add(31 * time.Second)) {
		t.Fatal("a netmap past its bound was not failed closed")
	}
	if got := peerCount(t, a.dev); got != 0 {
		t.Fatalf("A still holds %d peer(s) past the staleness bound", got)
	}
	if managerA.EnforceStaleness(time.Now().Add(120 * time.Second)) {
		t.Fatal("staleness was enforced twice for the same document")
	}

	// A heartbeat that comes back is proof the control plane is reachable again, and
	// it alone must not be mistaken for a fresh peer set: the peers return with the
	// document.
	managerA.Confirm(time.Now().Add(120 * time.Second))
	if got := peerCount(t, a.dev); got != 0 {
		t.Fatalf("peers reappeared on a heartbeat alone: %d", got)
	}
	// The node must still know it is failed closed, because the version it holds is
	// the one the control plane is serving: without this it would wait for a change
	// that is never coming and stay dark for good.
	if !managerA.FailedClosed() {
		t.Fatal("the node forgot it had failed closed, so it would never ask for the document again")
	}

	// A fresh document brings the peers back.
	if err := managerA.Apply(netmapFor(7, a.addr, allowAllPolicy("a", a.addr, b.addr), b.peerEntry("b")), time.Now()); err != nil {
		t.Fatalf("re-applying after the fail-closed: %v", err)
	}
	if got := peerCount(t, a.dev); got != 1 {
		t.Fatalf("A holds %d peer(s) after recovering, want 1", got)
	}
	if managerA.FailedClosed() {
		t.Fatal("the node is still marked failed closed after applying a document")
	}
}

func TestPersistedNetmapIsWrittenPrivatelyAndReloadedWhenFresh(t *testing.T) {
	a := newOverlayNode(t, "100.64.0.13/10")
	b := newOverlayNode(t, "100.64.0.14/10")

	dir := t.TempDir()
	identity := filepath.Join(dir, "node.key")
	manager := newNetmapManager(nil, a.dev, a.netfilter, identity, a.port, "", a.keys.PublicKey, nil)

	if err := manager.Apply(netmapFor(9, a.addr, allowAllPolicy("a", a.addr, b.addr), b.peerEntry("b")), time.Now()); err != nil {
		t.Fatalf("applying: %v", err)
	}

	path := filepath.Join(dir, netmapFileName)
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("the netmap was not persisted: %v", err)
	}
	// Windows has no POSIX mode bits, and the node runs on Linux; checking there
	// would assert on the filesystem rather than on the code.
	if runtime.GOOS != "windows" && info.Mode().Perm() != 0o600 {
		t.Fatalf("persisted netmap mode = %o, want 600: it carries every peer key", info.Mode().Perm())
	}

	// A node restarting with the control plane down: a new manager over a new device,
	// reading what the previous run left.
	restarted := newOverlayNode(t, "100.64.0.13/10")
	reloaded := newNetmapManager(nil, restarted.dev, restarted.netfilter, identity, restarted.port, "", restarted.keys.PublicKey, nil)

	loaded, err := reloaded.LoadPersisted(time.Now())
	if err != nil {
		t.Fatalf("loading the persisted netmap: %v", err)
	}
	if !loaded {
		t.Fatal("a fresh persisted netmap was not loaded")
	}
	if got := peerCount(t, restarted.dev); got != 1 {
		t.Fatalf("the restarted node holds %d peer(s), want 1", got)
	}
	if got := reloaded.Version(); got != 9 {
		t.Fatalf("the restarted node is at version %d, want 9", got)
	}
}

func TestPersistedNetmapPastItsBoundLeavesTheNodeAtDefaultDeny(t *testing.T) {
	a := newOverlayNode(t, "100.64.0.15/10")
	b := newOverlayNode(t, "100.64.0.16/10")

	dir := t.TempDir()
	identity := filepath.Join(dir, "node.key")

	netmap := netmapFor(11, a.addr, allowAllPolicy("a", a.addr, b.addr), b.peerEntry("b"))
	netmap.MaxStalenessSeconds = 60
	netmap.GeneratedAtUnix = time.Now().Add(-10 * time.Minute).Unix()

	raw, err := json.Marshal(persistedNetmap{FetchedAtUnix: netmap.GeneratedAtUnix, Netmap: netmap})
	if err != nil {
		t.Fatalf("building the stored document: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, netmapFileName), raw, 0o600); err != nil {
		t.Fatalf("writing the stored document: %v", err)
	}

	manager := newNetmapManager(nil, a.dev, a.netfilter, identity, a.port, "", a.keys.PublicKey, nil)
	loaded, err := manager.LoadPersisted(time.Now())
	if err != nil {
		t.Fatalf("loading: %v", err)
	}
	if loaded {
		t.Fatal("a stored netmap ten minutes past a sixty second bound was loaded")
	}
	if got := peerCount(t, a.dev); got != 0 {
		t.Fatalf("the node holds %d peer(s) after refusing a stale document", got)
	}
}

func TestNoStoredNetmapLeavesTheNodeAtDefaultDeny(t *testing.T) {
	a := newOverlayNode(t, "100.64.0.17/10")
	manager := managerFor(t, a)

	loaded, err := manager.LoadPersisted(time.Now())
	if err != nil {
		t.Fatalf("loading with no file present: %v", err)
	}
	if loaded {
		t.Fatal("a node with no stored netmap reported one")
	}
	if got := manager.Version(); got != 0 {
		t.Fatalf("version = %d with no document applied, want 0", got)
	}
	if got := peerCount(t, a.dev); got != 0 {
		t.Fatalf("the node holds %d peer(s) with no document", got)
	}
}

// A document is applied whole or not at all: one unusable entry must leave the
// previous peer set in place rather than tear the overlay down halfway through.
func TestAMalformedNetmapLeavesThePreviousPeerSetInPlace(t *testing.T) {
	a := newOverlayNode(t, "100.64.0.18/10")
	b := newOverlayNode(t, "100.64.0.19/10")

	manager := managerFor(t, a)
	if err := manager.Apply(netmapFor(12, a.addr, allowAllPolicy("a", a.addr, b.addr), b.peerEntry("b")), time.Now()); err != nil {
		t.Fatalf("applying the first netmap: %v", err)
	}

	broken := b.peerEntry("b")
	broken.AllowedIPs = []string{"100.64.0.20"} // a bare address, not a prefix
	if err := manager.Apply(netmapFor(13, a.addr, allowAllPolicy("a", a.addr, b.addr), broken), time.Now()); err == nil {
		t.Fatal("a netmap with an unusable allowed IP was accepted")
	}

	if got := peerCount(t, a.dev); got != 1 {
		t.Fatalf("the peer set was disturbed by a rejected document: %d peer(s)", got)
	}
	if got := manager.Version(); got != 12 {
		t.Fatalf("version moved to %d on a rejected document, want 12", got)
	}
}

// A node with nothing to run on must stay up at default deny rather than exit.
//
// It exited: dataplane.New returns ErrNoAddresses and main treated it as fatal, so a
// node restarted with no control plane and no stored document crash-looped instead of
// coming up carrying nothing.
func TestNoAddressAnywhereLeavesTheNodeUpAndCarryingNothing(t *testing.T) {
	netfilter := acl.NewNetstackFilter()
	keys, err := crypto.GenerateKeypair()
	if err != nil {
		t.Fatalf("generating identity: %v", err)
	}

	bridgeSandbox := bridge.NewSandboxPolicyEngine(bridge.SandboxPolicyConfig{})
	netstackBridge := bridge.NewNetstackBridge(bridgeSandbox, bridge.NewDoHResolver(nil), bridge.NewGuardian(0))

	stop, err := startDataplane(context.Background(), dataplaneOptions{
		Mode:         string(dataplane.ModeNetstack),
		Keypair:      keys,
		IdentityPath: filepath.Join(t.TempDir(), "node.key"),
		Netfilter:    netfilter,
		Bridge:       netstackBridge,
	})
	if err != nil {
		t.Fatalf("a node with no address must come up at default deny, not fail: %v", err)
	}
	defer stop()

	// Nothing was attached to the bridge, so an overlay destination is still refused
	// as a bogon, which is what it was before this package existed.
	client, server := net.Pipe()
	defer client.Close()
	defer server.Close()

	if dialErr := netstackBridge.DialAndPipe(context.Background(), server, "100.64.0.2:9999", 0); dialErr == nil {
		t.Fatal("an overlay destination was accepted with no data plane attached")
	}
}

func TestDiscoverEndpointsLeavesOutAddressesAPeerCouldNotUse(t *testing.T) {
	endpoints := discoverEndpoints(51820, "")

	for _, e := range endpoints {
		addr, err := netip.ParseAddr(e.IPAddress)
		if err != nil {
			t.Fatalf("endpoint %q is not an address", e.IPAddress)
		}
		if addr.IsLoopback() {
			t.Fatalf("loopback %s was reported as an endpoint", addr)
		}
		if addr.IsLinkLocalUnicast() {
			t.Fatalf("link-local %s was reported as an endpoint", addr)
		}
		if isOverlayAddr(addr) {
			t.Fatalf("overlay address %s was reported as an endpoint: that is inside the tunnel", addr)
		}
		if e.Port != 51820 {
			t.Fatalf("endpoint %s carries port %d, want the WireGuard listen port", e.IPAddress, e.Port)
		}
		if e.Protocol != "udp" {
			t.Fatalf("endpoint %s carries protocol %q, want udp", e.IPAddress, e.Protocol)
		}
	}

	// A node with no data plane has no port to report, and must report nothing rather
	// than an address with a zero port.
	if got := discoverEndpoints(0, ""); got != nil {
		t.Fatalf("endpoints reported without a listen port: %v", got)
	}
}
