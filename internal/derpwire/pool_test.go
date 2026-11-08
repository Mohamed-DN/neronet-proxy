package derpwire

import (
	"crypto/tls"
	"crypto/x509"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"tailscale.com/types/key"
)

func eventually(t *testing.T, f func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if f() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("condition did not become true within five seconds")
}

func TestAuthenticatedPoolTwoHomesAndSharedSessions(t *testing.T) {
	a, b := key.NewNode(), key.NewNode()
	allowed := map[[32]byte]bool{a.Public().Raw32(): true, b.Public().Raw32(): true}
	var mu sync.RWMutex
	admit := func(k [32]byte) bool { mu.RLock(); defer mu.RUnlock(); return allowed[k] }
	var relays []Relay
	roots := x509.NewCertPool()
	var servers []*RelayServer
	for _, id := range []string{"primary", "secondary"} {
		r, err := NewRelay(key.NewNode().Raw32(), admit, t.Logf)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = r.Close() })
		s := httptest.NewTLSServer(r)
		t.Cleanup(s.Close)
		roots.AddCert(s.Certificate())
		relays = append(relays, Relay{id, s.URL + "/derp"})
		servers = append(servers, r)
	}
	packets := make(chan string, 32)
	pa, err := NewPool(a.Raw32(), &tls.Config{RootCAs: roots}, nil, t.Logf)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = pa.Close() })
	pb, err := NewPool(b.Raw32(), &tls.Config{RootCAs: roots}, func(relay string, source [32]byte, packet []byte) {
		if source != a.Public().Raw32() {
			t.Error("source identity mismatch")
		}
		packets <- relay + ":" + string(packet)
	}, t.Logf)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = pb.Close() })
	if err := pa.Configure(relays); err != nil {
		t.Fatal(err)
	}
	if err := pb.Configure(relays); err != nil {
		t.Fatal(err)
	}
	eventually(t, func() bool { return len(pa.Homes()) == 2 && len(pb.Homes()) == 2 })
	for _, r := range relays {
		for i := 0; i < 5; i++ {
			if err := pa.Send(r.ID, b.Public().Raw32(), []byte("opaque")); err != nil {
				t.Fatal(err)
			}
		}
	}
	for i := 0; i < 10; i++ {
		select {
		case <-packets:
		case <-time.After(time.Second):
			t.Fatal("ciphertext was not delivered")
		}
	}
	if pa.Connections() != 2 || pb.Connections() != 2 {
		t.Fatal("per-peer sends created duplicate local identity sessions")
	}
	// A lost primary must leave the already-authenticated secondary available.
	_ = servers[0].Close()
	if err := pa.Send("secondary", b.Public().Raw32(), []byte("secondary-live")); err != nil {
		t.Fatal(err)
	}
	select {
	case got := <-packets:
		if got != "secondary:secondary-live" {
			t.Fatal(got)
		}
	case <-time.After(time.Second):
		t.Fatal("secondary did not deliver")
	}
	// Revocation reaches existing sessions, not only the next registration.
	mu.Lock()
	delete(allowed, a.Public().Raw32())
	mu.Unlock()
	servers[1].Invalidate()
	eventually(t, func() bool { return len(pa.Homes()) == 0 })
	// The unrevoked receiver authenticates again after the server rotation.
	eventually(t, func() bool { return len(pb.Homes()) == 1 })
}

func TestUntrustedCAAndUnadmittedPrivateIdentityNeverBecomeHomes(t *testing.T) {
	good := key.NewNode()
	var admitted atomic.Uint32
	r, err := NewRelay(key.NewNode().Raw32(), func(k [32]byte) bool { admitted.Add(1); return k == good.Public().Raw32() }, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = r.Close() })
	s := httptest.NewTLSServer(r)
	t.Cleanup(s.Close)
	trusted := x509.NewCertPool()
	trusted.AddCert(s.Certificate())
	for _, tc := range []struct {
		name    string
		private [32]byte
		roots   *x509.CertPool
	}{
		{"wrong-ca", good.Raw32(), x509.NewCertPool()},
		{"wrong-private-identity", key.NewNode().Raw32(), trusted},
	} {
		t.Run(tc.name, func(t *testing.T) {
			p, err := NewPool(tc.private, &tls.Config{RootCAs: tc.roots}, nil, nil)
			if err != nil {
				t.Fatal(err)
			}
			defer p.Close()
			if err := p.Configure([]Relay{{"relay", s.URL + "/derp"}}); err != nil {
				t.Fatal(err)
			}
			time.Sleep(800 * time.Millisecond)
			if len(p.Homes()) != 0 {
				t.Fatal("untrusted or unadmitted identity advertised a receiver home")
			}
			if err := p.Send("relay", good.Public().Raw32(), []byte("no")); err == nil {
				t.Fatal("send accepted before authenticated admission")
			}
		})
	}
	if admitted.Load() == 0 {
		t.Fatal("test never reached the real admission callback")
	}
}

func TestReplacementConnectionSurvivesOldClientClose(t *testing.T) {
	a, b := key.NewNode(), key.NewNode()
	r, err := NewRelay(key.NewNode().Raw32(), func(k [32]byte) bool { return k == a.Public().Raw32() || k == b.Public().Raw32() }, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = r.Close() })
	s := httptest.NewTLSServer(r)
	t.Cleanup(s.Close)
	roots := x509.NewCertPool()
	roots.AddCert(s.Certificate())
	newPool := func(private [32]byte, handler Handler) *Pool {
		p, err := NewPool(private, &tls.Config{RootCAs: roots}, handler, nil)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = p.Close() })
		if err := p.Configure([]Relay{{"relay", s.URL + "/derp"}}); err != nil {
			t.Fatal(err)
		}
		eventually(t, func() bool { return len(p.Homes()) == 1 })
		return p
	}
	pa := newPool(a.Raw32(), nil)
	old := newPool(b.Raw32(), nil)
	received := make(chan string, 1)
	_ = newPool(b.Raw32(), func(_ string, _ [32]byte, b []byte) { received <- string(b) })
	_ = old.Close()
	if err := pa.Send("relay", b.Public().Raw32(), []byte("replacement")); err != nil {
		t.Fatal(err)
	}
	select {
	case got := <-received:
		if got != "replacement" {
			t.Fatal(got)
		}
	case <-time.After(time.Second):
		t.Fatal("closing old connection removed replacement identity")
	}
}
