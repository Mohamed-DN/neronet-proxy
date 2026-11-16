package dns

import (
	"testing"

	"golang.org/x/net/dns/dnsmessage"

	"github.com/sovereign/proxy/v4/pkg/control"
)

func packQuery(t *testing.T, name string, qt dnsmessage.Type) []byte {
	t.Helper()
	n, err := dnsmessage.NewName(name)
	if err != nil {
		t.Fatal(err)
	}
	msg := dnsmessage.Message{
		Header:    dnsmessage.Header{ID: 7, RecursionDesired: true},
		Questions: []dnsmessage.Question{{Name: n, Type: qt, Class: dnsmessage.ClassINET}},
	}
	b, err := msg.Pack()
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func answerFor(t *testing.T, s *Server, name string, qt dnsmessage.Type) (dnsmessage.Message, bool) {
	t.Helper()
	reply, forward := s.Answer(packQuery(t, name, qt))
	var msg dnsmessage.Message
	if err := msg.Unpack(reply); err != nil {
		t.Fatalf("reply for %s does not unpack: %v", name, err)
	}
	return msg, forward
}

func phoneDoc() (control.NetmapSelf, []control.NetmapPeer, *control.DNSConfig) {
	self := control.NetmapSelf{OverlayIPv4: "100.64.0.1", Name: "gw", DNSName: "gw.example.com"}
	peers := []control.NetmapPeer{
		{NodeID: "dev-b", Name: "Phone", DNSName: "phone.example.com", AllowedIPs: []string{"100.64.0.30/32"}},
		{NodeID: "dev-a", Name: "Phone", DNSName: "phone.example.com", AllowedIPs: []string{"100.64.0.20/32", "fd00::20/128"}},
	}
	return self, peers, &control.DNSConfig{SearchDomains: []string{"example.com", "mesh", "neronet"}}
}

func TestAnswerServesMeshNamesAndNeverForwardsThem(t *testing.T) {
	s := NewServer(Config{SingleAnswer: true})
	self, peers, cfg := phoneDoc()
	s.UpdateNetmap(self, peers, cfg)

	msg, forward := answerFor(t, s, "gw.example.com.", dnsmessage.TypeA)
	if forward || len(msg.Answers) != 1 {
		t.Fatalf("a known mesh name: forward=%v answers=%d", forward, len(msg.Answers))
	}
	msg, forward = answerFor(t, s, "gw.", dnsmessage.TypeA)
	if forward || len(msg.Answers) != 1 {
		t.Fatalf("a single-label name: forward=%v answers=%d", forward, len(msg.Answers))
	}
	for _, name := range []string{"nobody.example.com.", "nobody.", "nobody.mesh."} {
		msg, forward = answerFor(t, s, name, dnsmessage.TypeA)
		if forward || msg.RCode != dnsmessage.RCodeNameError {
			t.Errorf("%s: forward=%v rcode=%v, want NXDOMAIN and no forwarding", name, forward, msg.RCode)
		}
	}
	msg, forward = answerFor(t, s, "www.example.org.", dnsmessage.TypeA)
	if !forward {
		t.Fatalf("a name outside the mesh must be offered for forwarding (rcode %v)", msg.RCode)
	}
}

func TestSingleAnswerGivesADuplicateNameToTheLowestNodeID(t *testing.T) {
	s := NewServer(Config{SingleAnswer: true})
	self, peers, cfg := phoneDoc()
	s.UpdateNetmap(self, peers, cfg)

	for _, name := range []string{"phone.example.com.", "phone."} {
		msg, _ := answerFor(t, s, name, dnsmessage.TypeA)
		if len(msg.Answers) != 1 {
			t.Fatalf("%s: %d address(es), want exactly one", name, len(msg.Answers))
		}
		if got := msg.Answers[0].Body.(*dnsmessage.AResource).A; got != [4]byte{100, 64, 0, 20} {
			t.Errorf("%s: answered %v, want the lowest node id (dev-a, 100.64.0.20)", name, got)
		}
	}
	// The address family comes from the same device, never mixed from two.
	msg, _ := answerFor(t, s, "phone.example.com.", dnsmessage.TypeAAAA)
	if len(msg.Answers) != 1 {
		t.Fatalf("AAAA: %d answer(s), want the winner's one", len(msg.Answers))
	}
	// The order of the document does not matter.
	s2 := NewServer(Config{SingleAnswer: true})
	peers[0], peers[1] = peers[1], peers[0]
	s2.UpdateNetmap(self, peers, cfg)
	msg, _ = answerFor(t, s2, "phone.example.com.", dnsmessage.TypeA)
	if got := msg.Answers[0].Body.(*dnsmessage.AResource).A; got != [4]byte{100, 64, 0, 20} {
		t.Errorf("reordered document answered %v", got)
	}
}

func TestWithoutSingleAnswerADuplicateNameStaysMultiAddress(t *testing.T) {
	s := NewServer(Config{})
	self, peers, cfg := phoneDoc()
	s.UpdateNetmap(self, peers, cfg)
	msg, _ := answerFor(t, s, "phone.example.com.", dnsmessage.TypeA)
	if len(msg.Answers) != 2 {
		t.Fatalf("default behaviour changed: %d address(es), want 2", len(msg.Answers))
	}
}
