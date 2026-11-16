package main

import (
	"net/netip"
	"testing"
	"time"

	"golang.org/x/net/dns/dnsmessage"

	"github.com/sovereign/proxy/v4/pkg/control"
	"github.com/sovereign/proxy/v4/pkg/dataplane"
)

// ADR 0034: the gateway turns the names in the netmap into the resolver the data plane
// serves at 100.100.100.100:53.

type meshDNSRecorder struct{ installed []*dataplane.MeshDNS }

func (r *meshDNSRecorder) set(m *dataplane.MeshDNS) error {
	r.installed = append(r.installed, m)
	return nil
}
func (r *meshDNSRecorder) last() *dataplane.MeshDNS {
	if len(r.installed) == 0 {
		return nil
	}
	return r.installed[len(r.installed)-1]
}

var testUpstream = netip.MustParseAddrPort("192.0.2.53:53")

func meshNameManager(t *testing.T, enabled bool) (*netmapManager, *meshDNSRecorder) {
	t.Helper()
	m, _ := gatewayManager(t)
	rec := &meshDNSRecorder{}
	m.setMeshDNS = rec.set
	m.SetMeshDNS(enabled, testUpstream)
	return m, rec
}

func namedDoc() *control.NetmapResponse {
	peers := profileDoc()
	peers[0].Name, peers[0].DNSName = "server", "server.example.com"
	peers[1].Name, peers[1].DNSName = "phone", "phone.example.com"
	return &control.NetmapResponse{
		Version: 1, Peers: peers,
		Self: control.NetmapSelf{OverlayIPv4: "100.64.40.1", Name: "gw", DNSName: "gw.example.com"},
		DNS:  &control.DNSConfig{MagicDNS: true, SearchDomains: []string{"example.com", "mesh", "neronet"}},
	}
}

func resolve(t *testing.T, m *dataplane.MeshDNS, name string) (dnsmessage.Message, bool) {
	t.Helper()
	n, err := dnsmessage.NewName(name)
	if err != nil {
		t.Fatal(err)
	}
	q, _ := (&dnsmessage.Message{
		Header:    dnsmessage.Header{ID: 1, RecursionDesired: true},
		Questions: []dnsmessage.Question{{Name: n, Type: dnsmessage.TypeA, Class: dnsmessage.ClassINET}},
	}).Pack()
	reply, forward := m.Answer(q)
	var out dnsmessage.Message
	if err := out.Unpack(reply); err != nil {
		t.Fatalf("%s: reply does not unpack: %v", name, err)
	}
	return out, forward
}

func TestGatewayInstallsMeshNamesFromTheDocument(t *testing.T) {
	m, rec := meshNameManager(t, true)
	if err := m.Apply(namedDoc(), time.Now()); err != nil {
		t.Fatal(err)
	}
	r := rec.last()
	if r == nil {
		t.Fatal("a gateway with a profile device installed no mesh resolver")
	}
	if r.Upstream != testUpstream {
		t.Fatalf("upstream %v, want %v", r.Upstream, testUpstream)
	}
	for name, want := range map[string]string{"phone.example.com.": "100.64.40.9", "server.example.com.": "100.64.40.2", "gw.example.com.": "100.64.40.1"} {
		msg, forward := resolve(t, r, name)
		if forward || len(msg.Answers) != 1 || netip.AddrFrom4(msg.Answers[0].Body.(*dnsmessage.AResource).A).String() != want {
			t.Errorf("%s: forward=%v answers=%v, want %s", name, forward, msg.Answers, want)
		}
	}
	if msg, forward := resolve(t, r, "ghost.example.com."); forward || msg.RCode != dnsmessage.RCodeNameError {
		t.Errorf("unknown mesh name: forward=%v rcode=%v", forward, msg.RCode)
	}
	if _, forward := resolve(t, r, "www.example.org."); !forward {
		t.Error("a name outside the mesh was not offered for forwarding")
	}
}

func TestMeshNamesOffInstallsNothing(t *testing.T) {
	m, rec := meshNameManager(t, false)
	if err := m.Apply(namedDoc(), time.Now()); err != nil {
		t.Fatal(err)
	}
	if rec.last() != nil {
		t.Fatal("SOVEREIGN_MESH_DNS=off still installed the resolver")
	}
}

func TestMeshNamesEnvSwitch(t *testing.T) {
	cases := map[string]bool{"": true, "on": true, "1": true, "off": false, "OFF": false, " false ": false, "0": false, "no": false}
	for v, want := range cases {
		t.Setenv("SOVEREIGN_MESH_DNS", v)
		if got := meshDNSEnabled(); got != want {
			t.Errorf("SOVEREIGN_MESH_DNS=%q: enabled=%v, want %v", v, got, want)
		}
	}
}

func TestNodeWithoutProfileDevicesServesNoMeshNames(t *testing.T) {
	m, rec := meshNameManager(t, true)
	doc := namedDoc()
	doc.Peers = doc.Peers[:1]
	if err := m.Apply(doc, time.Now()); err != nil {
		t.Fatal(err)
	}
	if rec.last() != nil {
		t.Fatal("a node that serves no profile device answers mesh names")
	}
}

func TestRevokedDeviceNameStopsResolving(t *testing.T) {
	m, rec := meshNameManager(t, true)
	doc := namedDoc()
	doc.Peers = append(doc.Peers, control.NetmapPeer{NodeID: "dev-other", PublicKeyHex: "11" + profileKeyHex[2:], Name: "other",
		DNSName: "other.example.com", AllowedIPs: []string{"100.64.40.10/32"}, Profile: true, PresharedKeyHex: staticPSKHex})
	if err := m.Apply(doc, time.Now()); err != nil {
		t.Fatal(err)
	}
	if msg, _ := resolve(t, rec.last(), "phone.example.com."); len(msg.Answers) != 1 {
		t.Fatal("the device's name did not resolve before the revocation")
	}
	m.ApplyRevocations([]string{profileKeyHex}, 2)
	if msg, forward := resolve(t, rec.last(), "phone.example.com."); forward || msg.RCode != dnsmessage.RCodeNameError {
		t.Fatalf("a revoked device's name still resolves: forward=%v rcode=%v answers=%d", forward, msg.RCode, len(msg.Answers))
	}
}

func TestGatewayAnswersADuplicateNameWithTheLowestNodeID(t *testing.T) {
	m, rec := meshNameManager(t, true)
	doc := namedDoc()
	twin := doc.Peers[1]
	twin.NodeID, twin.PublicKeyHex, twin.AllowedIPs = "dev-aaa", "22"+profileKeyHex[2:], []string{"100.64.40.8/32"}
	doc.Peers = append(doc.Peers, twin)
	if err := m.Apply(doc, time.Now()); err != nil {
		t.Fatal(err)
	}
	msg, _ := resolve(t, rec.last(), "phone.example.com.")
	if len(msg.Answers) != 1 || netip.AddrFrom4(msg.Answers[0].Body.(*dnsmessage.AResource).A).String() != "100.64.40.8" {
		t.Fatalf("duplicate name answered %v, want the single address of dev-aaa (100.64.40.8)", msg.Answers)
	}
}
