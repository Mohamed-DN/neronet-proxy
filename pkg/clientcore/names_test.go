package clientcore

import (
	"errors"
	"net"
	"strings"
	"testing"
	"time"

	"golang.org/x/net/dns/dnsmessage"

	"github.com/sovereign/proxy/v4/pkg/control"
)

type recordedRunner struct {
	calls []string
	stdin []string
	fail  map[string]error
}

func (r *recordedRunner) run(stdin, name string, args ...string) error {
	call := name + " " + strings.Join(args, " ")
	r.calls = append(r.calls, call)
	r.stdin = append(r.stdin, stdin)
	for prefix, err := range r.fail {
		if strings.HasPrefix(call, prefix) {
			return err
		}
	}
	return nil
}

func hostWith(r *recordedRunner, tools ...string) *osNames {
	have := map[string]bool{}
	for _, t := range tools {
		have[t] = true
	}
	return &osNames{
		run:               r.run,
		have:              func(n string) bool { return have[n] },
		resolvedRunning:   func() bool { return have["resolvectl"] },
		resolvconfManaged: func() bool { return have["resolvconf"] },
	}
}

func TestNamesWithSystemdResolvedAreSetOnTheLinkOnly(t *testing.T) {
	r := &recordedRunner{}
	h := hostWith(r, "resolvectl", "resolvconf")
	st := h.apply("nero0", "100.100.100.100", []string{"mesh", "neronet"})
	if st.Status != NamesOK || st.Method != "systemd-resolved" {
		t.Fatalf("%+v", st)
	}
	want := []string{
		"resolvectl dns nero0 100.100.100.100",
		"resolvectl domain nero0 mesh ~neronet",
		"resolvectl default-route nero0 no",
	}
	if strings.Join(r.calls, "|") != strings.Join(want, "|") {
		t.Errorf("calls %q", r.calls)
	}
	r.calls = nil
	if err := h.remove("nero0"); err != nil || strings.Join(r.calls, "|") != "resolvectl revert nero0" {
		t.Errorf("remove: %v %q", err, r.calls)
	}
}

func TestNamesWithResolvconfReplaceAStaleEntryAndAddOurs(t *testing.T) {
	r := &recordedRunner{}
	h := hostWith(r, "resolvconf")
	st := h.apply("nero0", "100.100.100.100", []string{"mesh", "neronet"})
	if st.Status != NamesOK || st.Method != "resolvconf" {
		t.Fatalf("%+v", st)
	}
	if len(r.calls) != 2 || r.calls[0] != "resolvconf -d lo.neronet" || r.calls[1] != "resolvconf -a lo.neronet" {
		t.Fatalf("calls %q", r.calls)
	}
	if in := r.stdin[1]; !strings.Contains(in, "nameserver 100.100.100.100\n") || !strings.Contains(in, "search mesh neronet\n") {
		t.Errorf("stdin %q", in)
	}
	r.calls = nil
	if err := h.remove("nero0"); err != nil || strings.Join(r.calls, "|") != "resolvconf -d lo.neronet" {
		t.Errorf("remove: %v %q", err, r.calls)
	}
}

func TestNamesAreNotSetUpWhenResolvconfDoesNotOwnResolvConf(t *testing.T) {
	r := &recordedRunner{}
	h := hostWith(r, "resolvconf")
	h.resolvconfManaged = func() bool { return false }
	st := h.apply("nero0", "100.100.100.100", []string{"mesh"})
	if st.Status != NamesNotSetUp || !strings.Contains(st.Reason, "resolv.conf") {
		t.Fatalf("%+v", st)
	}
	if len(r.calls) != 0 {
		t.Errorf("touched the machine anyway: %q", r.calls)
	}
}

func TestNamesAreNotSetUpWithNothingToSetThemUpWith(t *testing.T) {
	r := &recordedRunner{}
	st := hostWith(r).apply("nero0", "100.100.100.100", []string{"mesh"})
	if st.Status != NamesNotSetUp || st.Reason == "" || len(r.calls) != 0 {
		t.Errorf("%+v %q", st, r.calls)
	}
}

func TestNamesFailureHalfWayIsUndone(t *testing.T) {
	r := &recordedRunner{fail: map[string]error{"resolvectl domain": errors.New("boom")}}
	h := hostWith(r, "resolvectl")
	st := h.apply("nero0", "100.100.100.100", []string{"mesh"})
	if st.Status != NamesNotSetUp || !strings.Contains(st.Reason, "boom") {
		t.Fatalf("%+v", st)
	}
	if r.calls[len(r.calls)-1] != "resolvectl revert nero0" {
		t.Errorf("not undone: %q", r.calls)
	}
}

func testNetmap() (*control.NetmapResponse, []control.NetmapPeer) {
	peers := []control.NetmapPeer{{NodeID: "n1", Name: "server", DNSName: "server.mesh", AllowedIPs: []string{"100.64.0.9/32"}}}
	doc := &control.NetmapResponse{Version: 1, Peers: peers,
		Self: control.NetmapSelf{OverlayIPv4: "100.64.0.4", Name: "laptop", DNSName: "laptop.mesh"},
		DNS:  &control.DNSConfig{MagicDNS: true, SearchDomains: []string{"mesh", "neronet"}}}
	return doc, peers
}

func ask(t *testing.T, addr net.Addr, name string) dnsmessage.Message {
	t.Helper()
	n, _ := dnsmessage.NewName(name)
	q, _ := (&dnsmessage.Message{
		Header:    dnsmessage.Header{ID: 7, RecursionDesired: true},
		Questions: []dnsmessage.Question{{Name: n, Type: dnsmessage.TypeA, Class: dnsmessage.ClassINET}},
	}).Pack()
	c, err := net.Dial("udp", addr.String())
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	_ = c.SetDeadline(time.Now().Add(2 * time.Second))
	if _, err := c.Write(q); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 1500)
	k, err := c.Read(buf)
	if err != nil {
		t.Fatalf("%s: no answer: %v", name, err)
	}
	var m dnsmessage.Message
	if err := m.Unpack(buf[:k]); err != nil {
		t.Fatal(err)
	}
	return m
}

func serviceOnLoopback(t *testing.T, r *recordedRunner, tools ...string) (*NameService, net.Addr) {
	t.Helper()
	ns := NewNameService(hostWith(r, tools...))
	ns.listen = func(string) (net.PacketConn, error) { return net.ListenPacket("udp4", "127.0.0.1:0") }
	return ns, nil
}

func TestNameServiceAnswersMeshNamesRefusesUnknownOnesAndNeverForwards(t *testing.T) {
	r := &recordedRunner{}
	ns, _ := serviceOnLoopback(t, r, "resolvectl")
	doc, peers := testNetmap()
	ns.Sink()(doc, peers)
	if err := ns.Start("nero0"); err != nil {
		t.Fatal(err)
	}
	defer ns.Stop()
	addr := ns.addr()

	m := ask(t, addr, "server.mesh.")
	if m.RCode != dnsmessage.RCodeSuccess || len(m.Answers) != 1 {
		t.Fatalf("server.mesh: %+v", m)
	}
	if got := net.IP(m.Answers[0].Body.(*dnsmessage.AResource).A[:]).String(); got != "100.64.0.9" {
		t.Errorf("server.mesh is %s", got)
	}
	if m := ask(t, addr, "ghost.mesh."); m.RCode != dnsmessage.RCodeNameError {
		t.Errorf("an unknown mesh name got rcode %v, want NXDOMAIN", m.RCode)
	}
	if m := ask(t, addr, "ghost."); m.RCode != dnsmessage.RCodeNameError {
		t.Errorf("an unknown single-label name got rcode %v, want NXDOMAIN", m.RCode)
	}
	if m := ask(t, addr, "example.org."); m.RCode != dnsmessage.RCodeRefused {
		t.Errorf("a name outside the mesh got rcode %v: it must be refused, not answered", m.RCode)
	}
	// The netmap went stale: nothing resolves from a document that no longer holds.
	ns.Sink()(nil, nil)
	if m := ask(t, addr, "server.mesh."); m.RCode != dnsmessage.RCodeNameError {
		t.Errorf("a stale netmap still answers: rcode %v", m.RCode)
	}
}

func TestNameServiceStartGivesTheLinkItsAddressAndStopTakesEverythingAway(t *testing.T) {
	r := &recordedRunner{}
	ns, _ := serviceOnLoopback(t, r, "resolvectl")
	if err := ns.Start("nero0"); err != nil {
		t.Fatal(err)
	}
	if r.calls[0] != "ip addr add 100.100.100.100/32 dev nero0" {
		t.Fatalf("first call %q", r.calls[0])
	}
	if st := ns.State(); st.Status != NamesOK {
		t.Errorf("%+v", st)
	}
	r.calls = nil
	ns.Stop()
	ns.Stop()
	if len(r.calls) != 1 || r.calls[0] != "resolvectl revert nero0" {
		t.Errorf("stop: %q", r.calls)
	}
	if st := ns.State(); st.Status != NamesOff {
		t.Errorf("after stop: %+v", st)
	}
}

func TestNameServiceThatCannotListenSaysSoAndSetsNothingUp(t *testing.T) {
	r := &recordedRunner{}
	ns := NewNameService(hostWith(r, "resolvectl"))
	ns.listen = func(string) (net.PacketConn, error) { return nil, errors.New("permission denied") }
	if err := ns.Start("nero0"); err != nil {
		t.Fatalf("a name service that cannot start must not fail the tunnel: %v", err)
	}
	st := ns.State()
	if st.Status != NamesNotSetUp || !strings.Contains(st.Reason, "permission denied") {
		t.Errorf("%+v", st)
	}
	for _, c := range r.calls {
		if strings.HasPrefix(c, "resolvectl") {
			t.Errorf("pointed the system at a resolver that is not there: %q", r.calls)
		}
	}
}

// A service that was killed leaves its resolvconf entry behind, pointing at an address that went away with
// the interface. The next start takes it away before anything else.
func TestStaleNamesLeftByAKilledServiceAreRemovedAtStart(t *testing.T) {
	r := &recordedRunner{}
	ns := NewNameService(hostWith(r, "resolvconf"))
	ns.ClearStale("nero0")
	if len(r.calls) != 1 || r.calls[0] != "resolvconf -d lo.neronet" {
		t.Errorf("calls %q", r.calls)
	}
}
