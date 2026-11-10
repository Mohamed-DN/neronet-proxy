package dataplane

import (
	"encoding/hex"
	"net"
	"net/netip"
	"testing"
	"time"

	"github.com/sovereign/proxy/v4/pkg/acl"
)

// The profile gateway (ADR 0029) relays between a standard WireGuard peer and the
// mesh. These tests build the triangle entirely in this process with real
// wireguard-go devices and real UDP on loopback:
//
//	D (profile device, 100.64.0.3) --- G (gateway, 100.64.0.1) --- N (mesh node, 100.64.0.2)
//
// D knows only G and routes the whole overlay to it, as a wg-quick profile does. N
// reaches D through G's peer entry, as the control plane's netmap arranges. G is the
// only place the organisation's policy for D can be enforced, because D runs a
// stock client that enforces nothing.

const (
	gwAddr     = "100.64.0.1"
	meshAddr   = "100.64.0.2"
	deviceAddr = "100.64.0.3"
	otherAddr  = "100.64.0.4"
)

var testPSK = hex.EncodeToString([]byte("profile-device-static-psk-32byte"))

func prefix32(a string) netip.Prefix {
	return netip.PrefixFrom(netip.MustParseAddr(a), 32)
}

// devicePolicy is the compiled policy the control plane would deliver for D: what D
// may send (outbound) and what may reach D (inbound).
func devicePolicy(self string, outbound, inbound []acl.CompiledFilterRule) *acl.CompiledPeerPolicy {
	return &acl.CompiledPeerPolicy{
		NodeID:        "dev-under-test",
		OverlayIPv4:   net.ParseIP(self),
		OutboundRules: outbound,
		InboundRules:  inbound,
		Epoch:         1,
	}
}

func rule(peer string, proto acl.Protocol, port uint16, action acl.Action) acl.CompiledFilterRule {
	ranges := []acl.PortRange{{Start: 0, End: 65535}}
	if port != 0 {
		ranges = []acl.PortRange{{Start: port, End: port}}
	}
	return acl.CompiledFilterRule{AllowedPeerVIP: net.ParseIP(peer), Protocol: proto, PortRanges: ranges, Action: action}
}

type triangle struct {
	g, n, d *testNode
	table   *ForwardTable
	dFilter *acl.NetstackFilter
}

// newTriangle wires the three peers. The gateway's forwarding table holds D with the
// given policy; forwarding is switched on only when on is true.
func newTriangle(t *testing.T, policy *acl.CompiledPeerPolicy, on bool) *triangle {
	t.Helper()
	g := newTestNode(t, gwAddr+"/10", nil)
	n := newTestNode(t, meshAddr+"/10", nil)
	d := newTestNode(t, deviceAddr+"/10", nil)

	gwForDevice := g.peerEntry()
	gwForDevice.AllowedIPs = []netip.Prefix{netip.MustParsePrefix("100.64.0.0/10")}
	gwForDevice.PresharedKey = testPSK
	if err := d.dev.SetPeers([]Peer{gwForDevice}); err != nil {
		t.Fatalf("D peers: %v", err)
	}

	deviceForGw := d.peerEntry()
	deviceForGw.PresharedKey = testPSK
	// Only the device's own /32: this is the source check that stops spoofing.
	deviceForGw.Endpoint = ""
	if err := g.dev.SetPeers([]Peer{n.peerEntry(), deviceForGw}); err != nil {
		t.Fatalf("G peers: %v", err)
	}

	gwForMesh := g.peerEntry()
	gwForMesh.AllowedIPs = []netip.Prefix{prefix32(gwAddr), prefix32(deviceAddr)}
	if err := n.dev.SetPeers([]Peer{gwForMesh}); err != nil {
		t.Fatalf("N peers: %v", err)
	}

	tr := &triangle{g: g, n: n, d: d, dFilter: acl.NewNetstackFilter()}
	tr.dFilter.UpdatePolicy(policy)
	tr.table = NewForwardTable()
	tr.table.AddDevice(netip.MustParseAddr(deviceAddr), tr.dFilter)
	if on {
		g.dev.SetForwarding(tr.table)
	}
	return tr
}

func listenEcho(t *testing.T, d *Device, port uint16) {
	t.Helper()
	r, err := ListenEcho(d, port, nil)
	if err != nil {
		t.Fatalf("echo responder: %v", err)
	}
	t.Cleanup(func() { r.Close() })
}

// echoWithin retries the exchange until the deadline, because the first attempt also
// pays for two handshakes.
func echoWithin(t *testing.T, from *Device, address string, total time.Duration) error {
	t.Helper()
	deadline := time.Now().Add(total)
	var err error
	for time.Now().Before(deadline) {
		if err = echoOnce(t, from, address, 2*time.Second); err == nil {
			return nil
		}
	}
	return err
}

func TestGatewayForwardsDeviceTCPToMeshAndBack(t *testing.T) {
	policy := devicePolicy(deviceAddr,
		[]acl.CompiledFilterRule{rule(meshAddr, acl.ProtocolTCP, 9999, acl.ActionAccept)},
		nil) // nothing may open a connection to D; replies come back through conntrack
	tr := newTriangle(t, policy, true)
	listenEcho(t, tr.n.dev, 9999)

	if err := echoWithin(t, tr.d.dev, meshAddr+":9999", 12*time.Second); err != nil {
		t.Fatalf("device -> mesh through the gateway: %v", err)
	}
	st := tr.g.dev.Stats()
	if st.Forwarded < 2 {
		t.Fatalf("gateway forwarded %d packets; a TCP exchange needs both directions", st.Forwarded)
	}
	if st.ForwardDropped != 0 {
		t.Fatalf("gateway dropped %d forwarded packets of a permitted exchange", st.ForwardDropped)
	}
}

func TestGatewayWithoutForwardingCarriesNothingBetweenDeviceAndMesh(t *testing.T) {
	policy := devicePolicy(deviceAddr,
		[]acl.CompiledFilterRule{rule(meshAddr, acl.ProtocolALL, 0, acl.ActionAccept)},
		[]acl.CompiledFilterRule{rule(meshAddr, acl.ProtocolALL, 0, acl.ActionAccept)})
	tr := newTriangle(t, policy, false)
	listenEcho(t, tr.n.dev, 9999)

	if err := echoWithin(t, tr.d.dev, meshAddr+":9999", 5*time.Second); err == nil {
		t.Fatal("device reached the mesh through a gateway with forwarding off")
	}
	if st := tr.g.dev.Stats(); st.Forwarded != 0 {
		t.Fatalf("forwarded %d packets with forwarding off", st.Forwarded)
	}
}

func TestGatewayEnforcesDeviceOutboundPolicyOnForwardedPath(t *testing.T) {
	policy := devicePolicy(deviceAddr,
		[]acl.CompiledFilterRule{
			rule(meshAddr, acl.ProtocolTCP, 9999, acl.ActionDrop),
			rule(meshAddr, acl.ProtocolALL, 0, acl.ActionAccept),
		},
		[]acl.CompiledFilterRule{rule(meshAddr, acl.ProtocolALL, 0, acl.ActionAccept)})
	tr := newTriangle(t, policy, true)
	listenEcho(t, tr.n.dev, 9999)
	listenEcho(t, tr.n.dev, 8888)

	if err := echoWithin(t, tr.d.dev, meshAddr+":8888", 12*time.Second); err != nil {
		t.Fatalf("the port the policy leaves open is unreachable: %v", err)
	}
	if err := echoWithin(t, tr.d.dev, meshAddr+":9999", 4*time.Second); err == nil {
		t.Fatal("the gateway forwarded a flow the device's policy drops")
	}
	if st := tr.g.dev.Stats(); st.ForwardDropped == 0 {
		t.Fatal("no forwarded packet was dropped: the policy was not on the forwarded path")
	}
}

func TestGatewayEnforcesDeviceInboundPolicyOnForwardedPath(t *testing.T) {
	// D may open connections to N; N may open nothing towards D.
	policy := devicePolicy(deviceAddr,
		[]acl.CompiledFilterRule{rule(meshAddr, acl.ProtocolTCP, 9999, acl.ActionAccept)},
		[]acl.CompiledFilterRule{rule(meshAddr, acl.ProtocolALL, 0, acl.ActionDrop)})
	tr := newTriangle(t, policy, true)
	listenEcho(t, tr.n.dev, 9999)
	listenEcho(t, tr.d.dev, 7777)

	if err := echoWithin(t, tr.d.dev, meshAddr+":9999", 12*time.Second); err != nil {
		t.Fatalf("device -> mesh: %v", err)
	}
	before := tr.g.dev.Stats().ForwardDropped
	if err := echoWithin(t, tr.n.dev, deviceAddr+":7777", 4*time.Second); err == nil {
		t.Fatal("the mesh opened a connection to a device whose policy drops it")
	}
	if after := tr.g.dev.Stats().ForwardDropped; after == before {
		t.Fatal("the unsolicited mesh -> device flow was not dropped at the gateway")
	}
}

// A second profile device that puts the first one's address on its packets is
// stopped by wireguard-go's source check: G holds 100.64.0.4/32 for that key, so a
// decrypted packet from 100.64.0.3 is discarded before forwarding sees it.
func TestGatewayRefusesADeviceSpoofingAnotherDevicesAddress(t *testing.T) {
	policy := devicePolicy(deviceAddr,
		[]acl.CompiledFilterRule{rule(meshAddr, acl.ProtocolALL, 0, acl.ActionAccept)},
		[]acl.CompiledFilterRule{rule(meshAddr, acl.ProtocolALL, 0, acl.ActionAccept)})
	tr := newTriangle(t, policy, true)
	listenEcho(t, tr.n.dev, 9999)

	// The spoofer's own stack carries D's address.
	spoofer := newTestNode(t, deviceAddr+"/10", nil)
	gw := tr.g.peerEntry()
	gw.AllowedIPs = []netip.Prefix{netip.MustParsePrefix("100.64.0.0/10")}
	if err := spoofer.dev.SetPeers([]Peer{gw}); err != nil {
		t.Fatal(err)
	}
	spooferAtGw := spoofer.peerEntry()
	spooferAtGw.AllowedIPs = []netip.Prefix{prefix32(otherAddr)}
	deviceAtGw := tr.d.peerEntry()
	deviceAtGw.PresharedKey = testPSK
	if err := tr.g.dev.SetPeers([]Peer{tr.n.peerEntry(), deviceAtGw, spooferAtGw}); err != nil {
		t.Fatal(err)
	}
	tr.table.AddDevice(netip.MustParseAddr(otherAddr), acl.NewNetstackFilter())
	tr.g.dev.SetForwarding(tr.table)

	if err := echoWithin(t, spoofer.dev, meshAddr+":9999", 5*time.Second); err == nil {
		t.Fatal("a device sourcing another device's address reached the mesh")
	}
	requireHandshake(t, tr.g.dev, spoofer)
	if st := tr.g.dev.Stats(); st.Forwarded != 0 {
		t.Fatalf("the gateway forwarded %d spoofed packets", st.Forwarded)
	}
	// The legitimate device still works afterwards.
	if err := echoWithin(t, tr.d.dev, meshAddr+":9999", 12*time.Second); err != nil {
		t.Fatalf("legitimate device after the spoof attempt: %v", err)
	}
}

// A mesh node that sources a device's address is stopped the same way: G holds only
// the node's own /32 for its key.
func TestGatewayRefusesAMeshNodeSpoofingADevice(t *testing.T) {
	policy := devicePolicy(deviceAddr,
		[]acl.CompiledFilterRule{rule(meshAddr, acl.ProtocolALL, 0, acl.ActionAccept)},
		[]acl.CompiledFilterRule{rule(meshAddr, acl.ProtocolALL, 0, acl.ActionAccept)})
	tr := newTriangle(t, policy, true)
	listenEcho(t, tr.d.dev, 7777)

	// A second mesh node whose stack carries D's address, dialling D's own address
	// would be local; it dials N instead, through G, with D's source address.
	rogue := newTestNode(t, deviceAddr+"/10", nil)
	gw := tr.g.peerEntry()
	gw.AllowedIPs = []netip.Prefix{prefix32(meshAddr), prefix32(gwAddr)}
	if err := rogue.dev.SetPeers([]Peer{gw}); err != nil {
		t.Fatal(err)
	}
	rogueAtGw := rogue.peerEntry()
	rogueAtGw.AllowedIPs = []netip.Prefix{prefix32("100.64.0.5")}
	deviceAtGw := tr.d.peerEntry()
	deviceAtGw.PresharedKey = testPSK
	if err := tr.g.dev.SetPeers([]Peer{tr.n.peerEntry(), deviceAtGw, rogueAtGw}); err != nil {
		t.Fatal(err)
	}
	listenEcho(t, tr.n.dev, 9999)

	if err := echoWithin(t, rogue.dev, meshAddr+":9999", 5*time.Second); err == nil {
		t.Fatal("a mesh node sourcing a device's address was relayed")
	}
	requireHandshake(t, tr.g.dev, rogue)
	if st := tr.g.dev.Stats(); st.Forwarded != 0 {
		t.Fatalf("the gateway forwarded %d spoofed packets", st.Forwarded)
	}
}

// Traffic between two mesh nodes is not the gateway's to relay: only flows with a
// profile device at one end are forwarded.
func TestForwardTableRefusesMeshTransit(t *testing.T) {
	table := NewForwardTable()
	table.AddDevice(netip.MustParseAddr(deviceAddr), acl.NewNetstackFilter())
	p := Packet{Version: 4, Protocol: ProtoTCP, Src: netip.MustParseAddr(meshAddr), Dst: netip.MustParseAddr("100.64.0.9"), DstPort: 80}
	if table.involves(p) {
		t.Fatal("a mesh -> mesh packet was claimed by the forwarding table")
	}
}

func TestForwardTableDecidesWithBothEndsPolicies(t *testing.T) {
	a := acl.NewNetstackFilter()
	a.UpdatePolicy(devicePolicy(deviceAddr, []acl.CompiledFilterRule{rule(otherAddr, acl.ProtocolTCP, 80, acl.ActionAccept)}, nil))
	b := acl.NewNetstackFilter()
	b.UpdatePolicy(devicePolicy(otherAddr, nil, []acl.CompiledFilterRule{rule(deviceAddr, acl.ProtocolTCP, 81, acl.ActionAccept)}))
	table := NewForwardTable()
	table.AddDevice(netip.MustParseAddr(deviceAddr), a)
	table.AddDevice(netip.MustParseAddr(otherAddr), b)

	p := Packet{Version: 4, Protocol: ProtoTCP, Src: netip.MustParseAddr(deviceAddr), Dst: netip.MustParseAddr(otherAddr), SrcPort: 40000, DstPort: 80}
	if err := table.Decide(p); err == nil {
		t.Fatal("device -> device passed although the receiving device's inbound policy does not allow port 80")
	}
	// A device with no policy loaded is at default deny, in both roles.
	c := acl.NewNetstackFilter()
	table.AddDevice(netip.MustParseAddr("100.64.0.7"), c)
	q := Packet{Version: 4, Protocol: ProtoTCP, Src: netip.MustParseAddr("100.64.0.7"), Dst: netip.MustParseAddr(meshAddr), SrcPort: 1, DstPort: 80}
	if err := table.Decide(q); err == nil {
		t.Fatal("a device with no policy was forwarded")
	}
}

// requireHandshake proves the spoofer's packets did reach the gateway, encrypted and
// authenticated: what stopped them was the source check after decryption, not a
// tunnel that never came up.
func requireHandshake(t *testing.T, gw *Device, from *testNode) {
	t.Helper()
	peers, err := gw.Peers()
	if err != nil {
		t.Fatal(err)
	}
	key := hex.EncodeToString(from.keys.PublicKey[:])
	for _, p := range peers {
		if p.PublicKey == key {
			if p.LastHandshake.IsZero() || p.RxBytes == 0 {
				t.Fatalf("the spoofer never completed a handshake with the gateway (rx %d bytes): the test proves nothing", p.RxBytes)
			}
			return
		}
	}
	t.Fatal("the spoofer is not a peer of the gateway")
}

func TestDecrementTTLKeepsTheIPv4ChecksumValid(t *testing.T) {
	pkt := buildIPv4(t, ProtoTCP, deviceAddr, meshAddr, 40000, 9999, []byte("x"), 0)
	pkt[8] = 64
	pkt[10], pkt[11] = 0, 0
	sum := onesComplementChecksum(pkt[:20])
	pkt[10], pkt[11] = byte(sum>>8), byte(sum)
	if err := decrementTTL(pkt); err != nil {
		t.Fatal(err)
	}
	if pkt[8] != 63 {
		t.Fatalf("TTL = %d, want 63", pkt[8])
	}
	if got := onesComplementChecksum(pkt[:20]); got != 0 {
		t.Fatalf("header checksum does not verify after the decrement (residue %#04x)", got)
	}
	pkt[8] = 1
	if err := decrementTTL(pkt); err == nil {
		t.Fatal("a packet with TTL 1 was forwarded")
	}
	v6 := buildIPv6(t, ProtoUDP, "fd00::3", "fd00::2", 1, 2, []byte("x"))
	v6[7] = 2
	if err := decrementTTL(v6); err != nil || v6[7] != 1 {
		t.Fatalf("IPv6 hop limit = %d (err %v), want 1", v6[7], err)
	}
	if err := decrementTTL(v6); err == nil {
		t.Fatal("an IPv6 packet with hop limit 1 was forwarded")
	}
}

func TestWakeDestinationIsInsideTheOverlayRoute(t *testing.T) {
	got, ok := wakeDestination(ModeTUN, []netip.Prefix{netip.MustParsePrefix("100.64.0.7/10")})
	if !ok || got.String() != "100.127.255.254:9" {
		t.Fatalf("wake destination = %v %v, want 100.127.255.254:9", got, ok)
	}
	if _, ok := wakeDestination(ModeTUN, []netip.Prefix{netip.MustParsePrefix("100.64.0.7/32")}); ok {
		t.Fatal("TUN mode with a /32 has no route into the tunnel for a wake datagram")
	}
}
