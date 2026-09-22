package dns

import (
	"context"
	"net"
	"testing"
	"time"

	"golang.org/x/net/dns/dnsmessage"

	"github.com/sovereign/proxy/v4/pkg/control"
)

func TestMagicDNSServer(t *testing.T) {
	srv := NewServer(Config{
		ListenAddr:          "127.0.0.1:0",
		DefaultSearchDomain: "corp.neronet",
	})
	if err := srv.Start(); err != nil {
		t.Fatalf("failed to start dns server: %v", err)
	}
	defer srv.Close()

	addr := srv.Addr()
	if addr == nil {
		t.Fatalf("expected non-nil server address")
	}

	// Configure initial Netmap
	self := control.NetmapSelf{
		OverlayIPv4: "100.64.0.10",
		OverlayIPv6: "fd00::10",
		Name:        "alpha",
		DNSName:     "alpha.corp.neronet",
	}
	peers := []control.NetmapPeer{
		{
			NodeID:     "node-beta-id",
			Name:       "beta",
			DNSName:    "beta.corp.neronet",
			AllowedIPs: []string{"100.64.0.20/32", "fd00::20/128"},
		},
	}
	dnsCfg := &control.DNSConfig{
		MagicDNS:      true,
		SearchDomains: []string{"corp.neronet", "mesh", "neronet"},
	}

	srv.UpdateNetmap(self, peers, dnsCfg)

	// Helper to send DNS query over UDP
	sendQuery := func(name string, qType dnsmessage.Type) (dnsmessage.Message, error) {
		conn, err := net.DialUDP("udp", nil, addr)
		if err != nil {
			return dnsmessage.Message{}, err
		}
		defer conn.Close()
		_ = conn.SetDeadline(time.Now().Add(2 * time.Second))

		qName, err := dnsmessage.NewName(name)
		if err != nil {
			return dnsmessage.Message{}, err
		}

		msg := dnsmessage.Message{
			Header: dnsmessage.Header{
				ID:               1234,
				RecursionDesired: true,
			},
			Questions: []dnsmessage.Question{
				{
					Name:  qName,
					Type:  qType,
					Class: dnsmessage.ClassINET,
				},
			},
		}

		packed, err := msg.Pack()
		if err != nil {
			return dnsmessage.Message{}, err
		}

		if _, err := conn.Write(packed); err != nil {
			return dnsmessage.Message{}, err
		}

		respBuf := make([]byte, 2048)
		n, err := conn.Read(respBuf)
		if err != nil {
			return dnsmessage.Message{}, err
		}

		var resp dnsmessage.Message
		if err := resp.Unpack(respBuf[:n]); err != nil {
			return dnsmessage.Message{}, err
		}
		return resp, nil
	}

	t.Run("Query self A record via short name", func(t *testing.T) {
		resp, err := sendQuery("alpha.", dnsmessage.TypeA)
		if err != nil {
			t.Fatalf("sendQuery error: %v", err)
		}
		if resp.Header.RCode != dnsmessage.RCodeSuccess {
			t.Fatalf("expected RCodeSuccess, got %v", resp.Header.RCode)
		}
		if len(resp.Answers) == 0 {
			t.Fatalf("expected at least 1 answer, got 0")
		}
		aResource, ok := resp.Answers[0].Body.(*dnsmessage.AResource)
		if !ok {
			t.Fatalf("expected AResource answer")
		}
		gotIP := net.IP(aResource.A[:]).String()
		if gotIP != "100.64.0.10" {
			t.Errorf("expected 100.64.0.10, got %s", gotIP)
		}
	})

	t.Run("Query peer A record via FQDN", func(t *testing.T) {
		resp, err := sendQuery("beta.corp.neronet.", dnsmessage.TypeA)
		if err != nil {
			t.Fatalf("sendQuery error: %v", err)
		}
		if resp.Header.RCode != dnsmessage.RCodeSuccess {
			t.Fatalf("expected RCodeSuccess, got %v", resp.Header.RCode)
		}
		if len(resp.Answers) == 0 {
			t.Fatalf("expected answer for beta.corp.neronet")
		}
		aResource := resp.Answers[0].Body.(*dnsmessage.AResource)
		gotIP := net.IP(aResource.A[:]).String()
		if gotIP != "100.64.0.20" {
			t.Errorf("expected 100.64.0.20, got %s", gotIP)
		}
	})

	t.Run("Query peer AAAA record via .mesh suffix", func(t *testing.T) {
		resp, err := sendQuery("beta.mesh.", dnsmessage.TypeAAAA)
		if err != nil {
			t.Fatalf("sendQuery error: %v", err)
		}
		if resp.Header.RCode != dnsmessage.RCodeSuccess {
			t.Fatalf("expected RCodeSuccess, got %v", resp.Header.RCode)
		}
		if len(resp.Answers) == 0 {
			t.Fatalf("expected AAAA answer for beta.mesh")
		}
		aaaaResource := resp.Answers[0].Body.(*dnsmessage.AAAAResource)
		gotIP := net.IP(aaaaResource.AAAA[:]).String()
		if gotIP != "fd00::20" {
			t.Errorf("expected fd00::20, got %s", gotIP)
		}
	})

	t.Run("Reverse PTR query for self IPv4", func(t *testing.T) {
		resp, err := sendQuery("10.0.64.100.in-addr.arpa.", dnsmessage.TypePTR)
		if err != nil {
			t.Fatalf("sendQuery error: %v", err)
		}
		if resp.Header.RCode != dnsmessage.RCodeSuccess {
			t.Fatalf("expected RCodeSuccess, got %v", resp.Header.RCode)
		}
		if len(resp.Answers) == 0 {
			t.Fatalf("expected PTR answer")
		}
		ptrResource := resp.Answers[0].Body.(*dnsmessage.PTRResource)
		ptrName := ptrResource.PTR.String()
		if ptrName != "alpha." && ptrName != "alpha.corp.neronet." {
			t.Errorf("unexpected PTR name: %s", ptrName)
		}
	})

	t.Run("Anti-DNS Leak on unknown mesh host", func(t *testing.T) {
		resp, err := sendQuery("ghost-node.corp.neronet.", dnsmessage.TypeA)
		if err != nil {
			t.Fatalf("sendQuery error: %v", err)
		}
		if resp.Header.RCode != dnsmessage.RCodeNameError {
			t.Errorf("expected NXDOMAIN (NameError) for non-existent mesh host, got %v", resp.Header.RCode)
		}
		stats := srv.Stats()
		if stats.LeaksPrevented == 0 {
			t.Errorf("expected LeaksPrevented > 0, got %d", stats.LeaksPrevented)
		}
	})

	t.Run("Anti-DNS Leak on unknown in-mesh reverse IP", func(t *testing.T) {
		resp, err := sendQuery("99.0.64.100.in-addr.arpa.", dnsmessage.TypePTR)
		if err != nil {
			t.Fatalf("sendQuery error: %v", err)
		}
		if resp.Header.RCode != dnsmessage.RCodeNameError {
			t.Errorf("expected NXDOMAIN for unassigned mesh IP reverse, got %v", resp.Header.RCode)
		}
	})

	t.Run("In-process Lookup method", func(t *testing.T) {
		ips, err := srv.Lookup(context.Background(), "alpha")
		if err != nil {
			t.Fatalf("Lookup failed: %v", err)
		}
		if len(ips) < 2 {
			t.Errorf("expected both IPv4 and IPv6 for alpha, got %v", ips)
		}
	})
}
