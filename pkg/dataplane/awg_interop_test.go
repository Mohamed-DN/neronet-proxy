//go:build awg

package dataplane

import (
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"net/netip"
	"os"
	"testing"
	"time"

	awgconn "github.com/amnezia-vpn/amneziawg-go/conn"
	awgdevice "github.com/amnezia-vpn/amneziawg-go/device"
	"github.com/amnezia-vpn/amneziawg-go/tun/tuntest"

	"github.com/sovereign/proxy/v4/pkg/acl"
	"github.com/sovereign/proxy/v4/pkg/crypto"
)

// ADR 0036: AmneziaWG on the profile gateway. These tests run a real AmneziaWG
// implementation (amneziawg-go, the engine the official apps use) as the profile device and
// make it talk to the gateway through the gateway's own forward and policy path:
//
//	C (AmneziaWG client, 100.64.0.9) --AWG--> G (gateway, 100.64.0.1) --WG--> N (mesh node, 100.64.0.2)
//
// They carry the awg build tag because they need the amneziawg-go dependency; CI runs them
// explicitly (see scripts/dev/test-go.sh).

const awgClientAddr = "100.64.0.9"

// testAWGParams are test values. Nothing here is a default of the product: the gateway has
// none, and refuses to start an AmneziaWG device without a set from the control plane.
func testAWGParams() AWGParams {
	return AWGParams{
		Jc: 5, Jmin: 40, Jmax: 120,
		S1: 37, S2: 71, S3: 23, S4: 11,
		H1: "1177943521-1177943999",
		H2: "2218841063-2218841590",
		H3: "3302115709-3302116222",
		H4: "412345678-412346133",
	}
}

type awgTestClient struct {
	dev  *awgdevice.Device
	tun  *tuntest.ChannelTUN
	pub  string
	addr netip.Addr
}

// newAWGTestClient builds an in-process AmneziaWG device whose only peer is the gateway
// and which routes the whole overlay to it, as an AmneziaWG profile does.
func newAWGTestClient(t *testing.T, p AWGParams, gwPub [32]byte, gwPort uint16, psk string) *awgTestClient {
	t.Helper()
	keys, err := crypto.GenerateKeypair()
	if err != nil {
		t.Fatal(err)
	}
	ch := tuntest.NewChannelTUN()
	dev := awgdevice.NewDevice(ch.TUN(), awgconn.NewDefaultBind(), awgTestLogger())
	t.Cleanup(dev.Close)
	uapi := fmt.Sprintf("private_key=%s\n", hex.EncodeToString(keys.PrivateKey[:])) + p.uapi() +
		fmt.Sprintf("public_key=%s\npreshared_key=%s\nendpoint=127.0.0.1:%d\nreplace_allowed_ips=true\nallowed_ip=100.64.0.0/10\n",
			hex.EncodeToString(gwPub[:]), psk, gwPort)
	if err := dev.IpcSet(uapi); err != nil {
		t.Fatalf("configuring the AmneziaWG client: %v", err)
	}
	if err := dev.Up(); err != nil {
		t.Fatalf("bringing the AmneziaWG client up: %v", err)
	}
	return &awgTestClient{dev: dev, tun: ch, pub: hex.EncodeToString(keys.PublicKey[:]), addr: netip.MustParseAddr(awgClientAddr)}
}

// pingWithin sends ICMP echo requests to dst until an echo reply from dst comes back or
// the time is up. The first request also pays for the handshake.
func (c *awgTestClient) pingWithin(dst netip.Addr, total time.Duration) bool {
	deadline := time.Now().Add(total)
	var seq uint16
	for time.Now().Before(deadline) {
		seq++
		select {
		case c.tun.Outbound <- echoRequest(c.addr, dst, seq):
		case <-time.After(time.Second):
		}
		wait := time.After(1500 * time.Millisecond)
	read:
		for {
			select {
			case pkt := <-c.tun.Inbound:
				if isEchoReplyFrom(pkt, dst) {
					return true
				}
			case <-wait:
				break read
			}
		}
	}
	return false
}

func isEchoReplyFrom(pkt []byte, src netip.Addr) bool {
	if len(pkt) < 28 || pkt[0]>>4 != 4 || pkt[9] != ProtoICMPv4 {
		return false
	}
	ihl := int(pkt[0]&0x0f) * 4
	if len(pkt) < ihl+8 {
		return false
	}
	from, _ := netip.AddrFromSlice(pkt[12:16])
	return from == src && pkt[ihl] == 0
}

type awgFixture struct {
	g, n   *testNode
	client *awgTestClient
	filter *acl.NetstackFilter
	table  *ForwardTable
}

// newAWGFixture brings up the gateway with an AmneziaWG device under gatewayParams, the
// client under clientParams, and the client's policy. optedIn says whether the client is
// registered as an AmneziaWG device; when false it is a plain profile peer.
func newAWGFixture(t *testing.T, gatewayParams, clientParams AWGParams, policy *acl.CompiledPeerPolicy, optedIn bool) *awgFixture {
	t.Helper()
	g := newTestNode(t, gwAddr+"/10", nil)
	n := newTestNode(t, meshAddr+"/10", nil)

	if err := g.dev.StartAWG(AWGConfig{Params: gatewayParams}); err != nil {
		t.Fatalf("starting the gateway's AmneziaWG device: %v", err)
	}
	port, err := g.dev.AWGPort()
	if err != nil {
		t.Fatalf("AmneziaWG port: %v", err)
	}
	client := newAWGTestClient(t, clientParams, g.keys.PublicKey, port, testPSK)

	device := Peer{
		PublicKey:    client.pub,
		AllowedIPs:   []netip.Prefix{prefix32(awgClientAddr)},
		PresharedKey: testPSK,
		Profile:      true,
		AWG:          optedIn,
	}
	if err := g.dev.SetPeers([]Peer{n.peerEntry(), device}); err != nil {
		t.Fatalf("gateway peers: %v", err)
	}
	gwForMesh := g.peerEntry()
	gwForMesh.AllowedIPs = []netip.Prefix{prefix32(gwAddr), prefix32(awgClientAddr)}
	if err := n.dev.SetPeers([]Peer{gwForMesh}); err != nil {
		t.Fatalf("mesh peers: %v", err)
	}

	fx := &awgFixture{g: g, n: n, client: client, filter: acl.NewNetstackFilter(), table: NewForwardTable()}
	fx.filter.UpdatePolicy(policy)
	fx.table.AddDevice(netip.MustParseAddr(awgClientAddr), fx.filter)
	g.dev.SetForwarding(fx.table)
	return fx
}

func allowAllPolicy() *acl.CompiledPeerPolicy {
	r := []acl.CompiledFilterRule{rule(meshAddr, acl.ProtocolALL, 0, acl.ActionAccept)}
	return devicePolicy(awgClientAddr, r, r)
}

func TestAWGClientReachesMeshThroughGateway(t *testing.T) {
	fx := newAWGFixture(t, testAWGParams(), testAWGParams(), allowAllPolicy(), true)

	if !fx.client.pingWithin(netip.MustParseAddr(meshAddr), 15*time.Second) {
		t.Fatal("an AmneziaWG client with the right parameters got no answer from a mesh node through the gateway")
	}
	st := fx.g.dev.Stats()
	if st.Forwarded < 2 {
		t.Fatalf("gateway forwarded %d packets; a request and its reply are two", st.Forwarded)
	}
}

func TestAWGClientReachesTheGatewayItself(t *testing.T) {
	fx := newAWGFixture(t, testAWGParams(), testAWGParams(), allowAllPolicy(), true)

	if !fx.client.pingWithin(netip.MustParseAddr(gwAddr), 15*time.Second) {
		t.Fatal("an AmneziaWG client could not reach the gateway's own overlay address")
	}
}

// One wrong parameter is a different protocol: the gateway must not answer the handshake.
// S3 and H3 are absent on purpose: they shape the cookie reply, which a responder sends only
// under load, so a handshake does not exercise them and a mismatch is not observable here.
func TestAWGClientWithOneMismatchedParameterCannotHandshake(t *testing.T) {
	mismatches := map[string]func(*AWGParams){
		"S1": func(p *AWGParams) { p.S1++ },
		"S2": func(p *AWGParams) { p.S2++ },
		"S4": func(p *AWGParams) { p.S4++ },
		"H1": func(p *AWGParams) { p.H1 = "1177944001-1177944500" },
		"H2": func(p *AWGParams) { p.H2 = "2218841600-2218842000" },
		"H4": func(p *AWGParams) { p.H4 = "412346200-412346600" },
	}
	for name, mutate := range mismatches {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			wrong := testAWGParams()
			mutate(&wrong)
			fx := newAWGFixture(t, testAWGParams(), wrong, allowAllPolicy(), true)
			if fx.client.pingWithin(netip.MustParseAddr(meshAddr), 4*time.Second) {
				t.Fatalf("a client with a different %s got an answer", name)
			}
			peers, err := fx.g.dev.Peers()
			if err != nil {
				t.Fatal(err)
			}
			for _, p := range peers {
				if p.PublicKey == fx.client.pub && !p.LastHandshake.IsZero() {
					t.Fatalf("the gateway completed a handshake with a client whose %s differs", name)
				}
			}
		})
	}
}

// A device the organisation did not put on AmneziaWG is a plain WireGuard peer: the AWG
// listener must not know its key, even with every parameter right.
func TestAWGPeerNotOptedInCannotConnectOverAWG(t *testing.T) {
	fx := newAWGFixture(t, testAWGParams(), testAWGParams(), allowAllPolicy(), false)

	if fx.client.pingWithin(netip.MustParseAddr(meshAddr), 4*time.Second) {
		t.Fatal("a profile device that is not opted into AmneziaWG connected over the AmneziaWG listener")
	}
}

// The compiled policy is the same on both devices: an explicit DROP cuts AmneziaWG traffic
// exactly as it cuts plain WireGuard (TestGatewayEnforcesDeviceOutboundPolicyOnForwardedPath).
func TestAWGDropRuleCutsTheForwardedPath(t *testing.T) {
	policy := devicePolicy(awgClientAddr,
		[]acl.CompiledFilterRule{rule(meshAddr, acl.ProtocolALL, 0, acl.ActionDrop)},
		[]acl.CompiledFilterRule{rule(meshAddr, acl.ProtocolALL, 0, acl.ActionAccept)})
	fx := newAWGFixture(t, testAWGParams(), testAWGParams(), policy, true)

	if fx.client.pingWithin(netip.MustParseAddr(meshAddr), 5*time.Second) {
		t.Fatal("the gateway forwarded AmneziaWG traffic the device's policy drops")
	}
	if st := fx.g.dev.Stats(); st.ForwardDropped == 0 || st.Forwarded != 0 {
		t.Fatalf("forwarded %d, dropped %d: the policy was not on the AmneziaWG path", st.Forwarded, st.ForwardDropped)
	}
}

func awgTestLogger() *awgdevice.Logger {
	if os.Getenv("NERONET_DATAPLANE_TEST_VERBOSE") != "" {
		return awgdevice.NewLogger(awgdevice.LogLevelVerbose, "awg-client ")
	}
	return awgdevice.NewLogger(awgdevice.LogLevelSilent, "")
}

// echoRequest builds an IPv4 ICMP echo request with correct checksums. tuntest.Ping's own
// ICMP checksum is not one a real stack accepts, and the mesh node's stack is a real one.
func echoRequest(src, dst netip.Addr, seq uint16) []byte {
	const ipLen, icmpLen = 20, 8 + 4
	pkt := make([]byte, ipLen+icmpLen)
	pkt[0] = 0x45
	binary.BigEndian.PutUint16(pkt[2:], uint16(len(pkt)))
	pkt[8] = 64
	pkt[9] = ProtoICMPv4
	copy(pkt[12:], src.AsSlice())
	copy(pkt[16:], dst.AsSlice())
	binary.BigEndian.PutUint16(pkt[10:], internetChecksum(pkt[:ipLen]))
	icmp := pkt[ipLen:]
	icmp[0] = 8
	binary.BigEndian.PutUint16(icmp[4:], 0x4e45)
	binary.BigEndian.PutUint16(icmp[6:], seq)
	copy(icmp[8:], "awg!")
	binary.BigEndian.PutUint16(icmp[2:], internetChecksum(icmp))
	return pkt
}

func internetChecksum(b []byte) uint16 {
	var sum uint32
	for i := 0; i+1 < len(b); i += 2 {
		sum += uint32(binary.BigEndian.Uint16(b[i:]))
	}
	if len(b)%2 == 1 {
		sum += uint32(b[len(b)-1]) << 8
	}
	for sum>>16 != 0 {
		sum = sum&0xffff + sum>>16
	}
	return ^uint16(sum)
}
