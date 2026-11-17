package dataplane

import (
	"net/netip"
	"testing"
	"time"

	"golang.org/x/net/dns/dnsmessage"

	"github.com/sovereign/proxy/v4/pkg/acl"
)

// ADR 0034 phase 3: the gateway answers a device a mesh name only if the device's
// compiled policy would let it open a connection to the name's address. Everything
// here runs a real gateway and a real device; the policy is the device's own
// NetstackFilter, the one the forwarding path uses.

const (
	laptopAddr = "100.64.0.9"  // meshNames: laptop.example.com
	tabletAddr = "100.64.0.11" // meshNames: tablet.example.com (dev-a, the winner)
)

// policyPair is meshDNSPair with the device's filter returned, so a test can change
// the policy the way a new netmap does.
func policyPair(t *testing.T) (g, d *testNode, nf *acl.NetstackFilter) {
	t.Helper()
	g, d = meshDNSPair(t)
	nf = acl.NewNetstackFilter()
	ft := NewForwardTable()
	ft.AddDevice(netip.MustParseAddr(deviceAddr), nf)
	g.dev.SetForwarding(ft)
	return g, d, nf
}

func allowOnly(nf *acl.NetstackFilter, peers ...string) {
	var out []acl.CompiledFilterRule
	for _, p := range peers {
		out = append(out, rule(p, acl.ProtocolTCP, 22, acl.ActionAccept))
	}
	nf.UpdatePolicy(devicePolicy(deviceAddr, out, nil))
}

func resolves(t *testing.T, d *Device, network, name, want string) {
	t.Helper()
	m, err := ask(t, d, network, name, 15*time.Second)
	if err != nil {
		t.Fatalf("%s %s: %v", network, name, err)
	}
	if got := aOf(t, m); len(got) != 1 || got[0].String() != want {
		t.Errorf("%s %s: answered %v (rcode %v), want %s", network, name, got, m.RCode, want)
	}
}

func sameShape(a, b dnsmessage.Message) bool {
	return a.Header == b.Header && len(a.Questions) == len(b.Questions) && len(a.Answers) == len(b.Answers) &&
		len(a.Authorities) == len(b.Authorities) && len(a.Additionals) == len(b.Additionals)
}

func TestMeshDNSAnswersOnlyTheNamesThePolicyLetTheDeviceReach(t *testing.T) {
	g, d, nf := policyPair(t)
	up := newStubResolver(t, [4]byte{192, 0, 2, 77})
	if err := g.dev.SetMeshDNS(meshNames(t, up.addr)); err != nil {
		t.Fatal(err)
	}
	allowOnly(nf, laptopAddr) // tablet is not reachable
	for _, network := range []string{"udp", "tcp"} {
		resolves(t, d.dev, network, "laptop.example.com.", laptopAddr)
		resolves(t, d.dev, network, "laptop.", laptopAddr)
		ghost, err := ask(t, d.dev, network, "ghost.example.com.", 15*time.Second)
		if err != nil {
			t.Fatal(err)
		}
		for _, name := range []string{"tablet.example.com.", "tablet.", "tablet.mesh."} {
			m, err := ask(t, d.dev, network, name, 15*time.Second)
			if err != nil {
				t.Fatalf("%s %s: %v", network, name, err)
			}
			if m.RCode != dnsmessage.RCodeNameError || len(m.Answers) != 0 {
				t.Errorf("%s %s: rcode %v with %d answer(s), want NXDOMAIN", network, name, m.RCode, len(m.Answers))
			}
			if !sameShape(m, ghost) {
				t.Errorf("%s %s: the hidden answer %+v differs in shape from a made-up name's %+v", network, name, m.Header, ghost.Header)
			}
		}
	}
	if up.queries.Load() != 0 {
		t.Fatalf("a hidden or unknown mesh name reached the upstream %d time(s)", up.queries.Load())
	}
}

func TestMeshDNSAlwaysAnswersTheDevicesOwnNameAndTheGatewaysWhateverThePolicy(t *testing.T) {
	g, d, nf := policyPair(t)
	if err := g.dev.SetMeshDNS(meshNames(t, netip.AddrPort{})); err != nil {
		t.Fatal(err)
	}
	allowOnly(nf) // a policy that lets the device reach nothing
	for _, network := range []string{"udp", "tcp"} {
		resolves(t, d.dev, network, "phone.example.com.", deviceAddr)
		resolves(t, d.dev, network, "gw.", gwAddr)
		m, err := ask(t, d.dev, network, "laptop.", 15*time.Second)
		if err != nil {
			t.Fatal(err)
		}
		if m.RCode != dnsmessage.RCodeNameError {
			t.Errorf("%s laptop with an empty policy: rcode %v, want NXDOMAIN", network, m.RCode)
		}
	}
}

func TestMeshDNSVisibilityFollowsAPolicyChangeOnTheNextQuery(t *testing.T) {
	g, d, nf := policyPair(t)
	if err := g.dev.SetMeshDNS(meshNames(t, netip.AddrPort{})); err != nil {
		t.Fatal(err)
	}
	allowOnly(nf, laptopAddr)
	m, err := ask(t, d.dev, "udp", "tablet.", 15*time.Second)
	if err != nil || m.RCode != dnsmessage.RCodeNameError {
		t.Fatalf("before the change: %v rcode %v, want NXDOMAIN", err, m.RCode)
	}
	allowOnly(nf, laptopAddr, tabletAddr) // a new netmap allows it
	resolves(t, d.dev, "udp", "tablet.", tabletAddr)
	allowOnly(nf, tabletAddr) // and a later one takes laptop away again
	resolves(t, d.dev, "udp", "tablet.", tabletAddr)
	m, err = ask(t, d.dev, "udp", "laptop.", 15*time.Second)
	if err != nil || m.RCode != dnsmessage.RCodeNameError {
		t.Fatalf("after revoking laptop: %v rcode %v, want NXDOMAIN", err, m.RCode)
	}
}

func TestMeshDNSExitDeviceFollowsTheSameVisibilityRule(t *testing.T) {
	g, d, nf := policyPair(t)
	exitUp := newStubResolver(t, [4]byte{198, 51, 100, 5})
	if err := g.dev.SetMeshDNS(meshNames(t, netip.AddrPort{})); err != nil {
		t.Fatal(err)
	}
	if err := g.dev.SetEgress(egressFor(deviceAddr, &EgressClient{ID: "dev", Via: EgressLocal}), exitUp.addr); err != nil {
		t.Fatal(err)
	}
	allowOnly(nf, laptopAddr)
	for _, network := range []string{"udp", "tcp"} {
		resolves(t, d.dev, network, "laptop.example.com.", laptopAddr)
		resolves(t, d.dev, network, "phone.example.com.", deviceAddr)
		ghost, err := ask(t, d.dev, network, "ghost.example.com.", 15*time.Second)
		if err != nil {
			t.Fatal(err)
		}
		m, err := ask(t, d.dev, network, "tablet.example.com.", 15*time.Second)
		if err != nil {
			t.Fatal(err)
		}
		if m.RCode != dnsmessage.RCodeNameError || !sameShape(m, ghost) {
			t.Errorf("%s tablet: %+v, want the shape of %+v", network, m.Header, ghost.Header)
		}
	}
	if exitUp.queries.Load() != 0 {
		t.Fatalf("a mesh name reached the exit's resolver %d time(s)", exitUp.queries.Load())
	}
}

func TestMeshDNSNonMeshNamesAreStillForwardedWhateverThePolicy(t *testing.T) {
	g, d, nf := policyPair(t)
	up := newStubResolver(t, [4]byte{192, 0, 2, 77})
	if err := g.dev.SetMeshDNS(meshNames(t, up.addr)); err != nil {
		t.Fatal(err)
	}
	allowOnly(nf)
	resolves(t, d.dev, "udp", "www.example.org.", "192.0.2.77")
	resolves(t, d.dev, "tcp", "www.example.org.", "192.0.2.77")
	if up.queries.Load() != 2 {
		t.Fatalf("upstream saw %d queries, want 2", up.queries.Load())
	}
}
