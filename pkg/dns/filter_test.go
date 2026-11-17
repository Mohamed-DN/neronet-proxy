package dns

import (
	"fmt"
	"net/netip"
	"strings"
	"testing"

	"golang.org/x/net/dns/dnsmessage"

	"github.com/sovereign/proxy/v4/pkg/control"
)

func filterDoc() (control.NetmapSelf, []control.NetmapPeer, *control.DNSConfig) {
	self := control.NetmapSelf{OverlayIPv4: "100.64.0.1", Name: "gw", DNSName: "gw.example.com"}
	peers := []control.NetmapPeer{
		{NodeID: "x", Name: "X", DNSName: "x.example.com", AllowedIPs: []string{"100.64.0.10/32", "fd00::10/128"}},
		{NodeID: "y", Name: "Y", DNSName: "y.example.com", AllowedIPs: []string{"100.64.0.11/32", "fd00::11/128"}},
	}
	return self, peers, &control.DNSConfig{SearchDomains: []string{"example.com"}}
}

func filterAnswer(t *testing.T, s *Server, name string, qt dnsmessage.Type, visible func(netip.Addr) bool) dnsmessage.Message {
	t.Helper()
	reply, forward := s.AnswerFor(packQuery(t, name, qt), visible)
	if reply == nil {
		t.Fatalf("%s: no reply", name)
	}
	var msg dnsmessage.Message
	if err := msg.Unpack(reply); err != nil {
		t.Fatal(err)
	}
	if forward && strings.Contains(name, "example.com") {
		t.Fatalf("%s: a mesh name must never be forwarded", name)
	}
	return msg
}

func TestAnswerForHidesATargetTheFilterRejectsAsAnUnknownName(t *testing.T) {
	s := NewServer(Config{SingleAnswer: true})
	self, peers, cfg := filterDoc()
	s.UpdateNetmap(self, peers, cfg)
	onlyX := func(a netip.Addr) bool {
		return a == netip.MustParseAddr("100.64.0.10") || a == netip.MustParseAddr("fd00::10")
	}

	for _, qt := range []dnsmessage.Type{dnsmessage.TypeA, dnsmessage.TypeAAAA} {
		for _, form := range []string{"%s.example.com.", "%s."} {
			x := filterAnswer(t, s, fmt.Sprintf(form, "x"), qt, onlyX)
			if x.RCode != dnsmessage.RCodeSuccess || len(x.Answers) != 1 {
				t.Errorf("x %v: rcode %v answers %d, want one", qt, x.RCode, len(x.Answers))
			}
			y := filterAnswer(t, s, fmt.Sprintf(form, "y"), qt, onlyX)
			ghost := filterAnswer(t, s, fmt.Sprintf(form, "ghost"), qt, onlyX)
			if y.RCode != dnsmessage.RCodeNameError || len(y.Answers) != 0 {
				t.Errorf("y %v: rcode %v answers %d, want NXDOMAIN", qt, y.RCode, len(y.Answers))
			}
			if y.Header != ghost.Header || len(y.Authorities) != len(ghost.Authorities) || len(y.Additionals) != len(ghost.Additionals) {
				t.Errorf("y %v: hidden answer %+v differs from the unknown name's %+v", qt, y.Header, ghost.Header)
			}
		}
	}
}

func TestAnswerForNilFilterAndSelfAreNeverHidden(t *testing.T) {
	s := NewServer(Config{SingleAnswer: true})
	self, peers, cfg := filterDoc()
	s.UpdateNetmap(self, peers, cfg)
	if m := filterAnswer(t, s, "y.example.com.", dnsmessage.TypeA, nil); len(m.Answers) != 1 {
		t.Errorf("a nil filter must answer as Answer does, got %d answer(s)", len(m.Answers))
	}
	nobody := func(netip.Addr) bool { return false }
	if m := filterAnswer(t, s, "gw.example.com.", dnsmessage.TypeA, nobody); len(m.Answers) != 1 {
		t.Errorf("the server's own name must resolve whatever the filter says, got %d", len(m.Answers))
	}
}

func TestAnswerForHidesTheReverseLookupOfAHiddenTarget(t *testing.T) {
	s := NewServer(Config{SingleAnswer: true})
	self, peers, cfg := filterDoc()
	s.UpdateNetmap(self, peers, cfg)
	onlyX := func(a netip.Addr) bool { return a == netip.MustParseAddr("100.64.0.10") }
	if m := filterAnswer(t, s, "10.0.64.100.in-addr.arpa.", dnsmessage.TypePTR, onlyX); len(m.Answers) != 1 {
		t.Errorf("PTR of a visible target: %d answers, want 1", len(m.Answers))
	}
	if m := filterAnswer(t, s, "11.0.64.100.in-addr.arpa.", dnsmessage.TypePTR, onlyX); m.RCode != dnsmessage.RCodeNameError || len(m.Answers) != 0 {
		t.Errorf("PTR of a hidden target: rcode %v answers %d, want NXDOMAIN", m.RCode, len(m.Answers))
	}
}
