package main

import (
	"net"
	"net/netip"
	"path/filepath"
	"testing"
	"time"

	"github.com/sovereign/proxy/v4/pkg/acl"
	"github.com/sovereign/proxy/v4/pkg/control"
	"github.com/sovereign/proxy/v4/pkg/dataplane"
)

// ADR 0029 A5: the gateway enforces each profile device's compiled policy on the
// forwarded path. The control plane sends that policy in the device's netmap entry;
// the node must turn it into the data plane's forwarding table on every document.

func devicePolicyFor(self, peer string, port uint16, action acl.Action) *acl.CompiledPeerPolicy {
	r := acl.CompiledFilterRule{AllowedPeerVIP: net.ParseIP(peer), Protocol: acl.ProtocolTCP,
		PortRanges: []acl.PortRange{{Start: port, End: port}}, Action: action}
	return &acl.CompiledPeerPolicy{NodeID: "dev-phone", OverlayIPv4: net.ParseIP(self),
		OutboundRules: []acl.CompiledFilterRule{r}, InboundRules: []acl.CompiledFilterRule{r}}
}

type forwardingRecorder struct{ tables []*dataplane.ForwardTable }

func (r *forwardingRecorder) set(t *dataplane.ForwardTable) { r.tables = append(r.tables, t) }
func (r *forwardingRecorder) last() *dataplane.ForwardTable {
	if len(r.tables) == 0 {
		return nil
	}
	return r.tables[len(r.tables)-1]
}

func gatewayManager(t *testing.T) (*netmapManager, *forwardingRecorder) {
	t.Helper()
	m := newNetmapManager(nil, nil, acl.NewNetstackFilter(), filepath.Join(t.TempDir(), "identity"), 51820, "", [32]byte{}, nil)
	m.setPeers = func([]dataplane.Peer) error { return nil }
	rec := &forwardingRecorder{}
	m.setForwarding = rec.set
	return m, rec
}

func tcpTo(src, dst string, port uint16) dataplane.Packet {
	return dataplane.Packet{Version: 4, Protocol: dataplane.ProtoTCP, Src: netip.MustParseAddr(src),
		Dst: netip.MustParseAddr(dst), SrcPort: 40000, DstPort: port}
}

func TestGatewayInstallsEachDevicesPolicyForForwarding(t *testing.T) {
	m, rec := gatewayManager(t)
	doc := profileDoc()
	doc[1].ACL = devicePolicyFor("100.64.40.9", "100.64.40.2", 9999, acl.ActionAccept)
	if err := m.Apply(&control.NetmapResponse{Version: 1, Peers: doc}, time.Now()); err != nil {
		t.Fatal(err)
	}
	table := rec.last()
	if table.Len() != 1 {
		t.Fatalf("forwarding table holds %d addresses, want the device's one", table.Len())
	}
	if err := table.Decide(tcpTo("100.64.40.9", "100.64.40.2", 9999)); err != nil {
		t.Fatalf("the device's ACCEPT was not installed: %v", err)
	}
	if err := table.Decide(tcpTo("100.64.40.9", "100.64.40.2", 22)); err == nil {
		t.Fatal("a port the device's policy does not name was forwarded")
	}
}

func TestGatewayDeviceWithoutPolicyIsAtDefaultDeny(t *testing.T) {
	m, rec := gatewayManager(t)
	if err := m.Apply(&control.NetmapResponse{Version: 1, Peers: profileDoc()}, time.Now()); err != nil {
		t.Fatal(err)
	}
	if err := rec.last().Decide(tcpTo("100.64.40.9", "100.64.40.2", 9999)); err == nil {
		t.Fatal("a profile device the document gave no policy was forwarded")
	}
}

func TestGatewayKeepsDeviceConntrackAcrossDocuments(t *testing.T) {
	m, rec := gatewayManager(t)
	doc := profileDoc()
	doc[1].ACL = devicePolicyFor("100.64.40.9", "100.64.40.2", 9999, acl.ActionAccept)
	doc[1].ACL.InboundRules = nil // replies come back through conntrack only
	if err := m.Apply(&control.NetmapResponse{Version: 1, Peers: doc}, time.Now()); err != nil {
		t.Fatal(err)
	}
	if err := rec.last().Decide(tcpTo("100.64.40.9", "100.64.40.2", 9999)); err != nil {
		t.Fatal(err)
	}
	if err := m.Apply(&control.NetmapResponse{Version: 2, Peers: doc}, time.Now()); err != nil {
		t.Fatal(err)
	}
	reply := dataplane.Packet{Version: 4, Protocol: dataplane.ProtoTCP, Src: netip.MustParseAddr("100.64.40.2"),
		Dst: netip.MustParseAddr("100.64.40.9"), SrcPort: 9999, DstPort: 40000}
	if err := rec.last().Decide(reply); err != nil {
		t.Fatalf("a new netmap dropped the reply of an established flow: %v", err)
	}
}

func TestGatewayForgetsARevokedOrRemovedDevice(t *testing.T) {
	m, rec := gatewayManager(t)
	doc := profileDoc()
	doc[1].ACL = devicePolicyFor("100.64.40.9", "100.64.40.2", 9999, acl.ActionAccept)
	if err := m.Apply(&control.NetmapResponse{Version: 1, Peers: doc, RevokedKeys: []string{profileKeyHex}}, time.Now()); err != nil {
		t.Fatal(err)
	}
	if rec.last().Len() != 0 {
		t.Fatal("a revoked device stayed in the forwarding table")
	}
	if err := m.Apply(&control.NetmapResponse{Version: 2, Peers: doc}, time.Now()); err != nil {
		t.Fatal(err)
	}
	if rec.last().Len() != 1 {
		t.Fatal("the device lifted from the revocation list was not forwarded again")
	}
	m.ApplyRevocations([]string{profileKeyHex}, 3)
	if rec.last().Len() != 0 {
		t.Fatal("a revocation from the heartbeat left the device in the forwarding table")
	}
}

func TestMeshNodeWithoutProfileDevicesDoesNotForward(t *testing.T) {
	m, rec := gatewayManager(t)
	doc := profileDoc()[:1]
	if err := m.Apply(&control.NetmapResponse{Version: 1, Peers: doc}, time.Now()); err != nil {
		t.Fatal(err)
	}
	if rec.last().Len() != 0 {
		t.Fatal("a node with no profile device switched forwarding on")
	}
}
