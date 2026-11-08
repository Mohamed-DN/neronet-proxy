package dataplane

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"fmt"
	"net"
	"net/http/httptest"
	"net/netip"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/sovereign/proxy/v4/internal/derpwire"
	"github.com/sovereign/proxy/v4/pkg/crypto"
	"github.com/sovereign/proxy/v4/pkg/transport"
)

func TestSingleWireGuardDeviceFallsBackAndRecoversDirectTCP(t *testing.T) {
	aKeys, _ := crypto.GenerateKeypair()
	bKeys, _ := crypto.GenerateKeypair()
	serverKeys, _ := crypto.GenerateKeypair()
	admit := func(k [32]byte) bool { return k == aKeys.PublicKey || k == bKeys.PublicKey }
	roots := x509.NewCertPool()
	var relays []transport.Relay
	var servers []*derpwire.RelayServer
	for _, id := range []string{"primary", "secondary"} {
		r, err := derpwire.NewRelay(serverKeys.PrivateKey, admit, nil)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = r.Close() })
		s := httptest.NewTLSServer(r)
		t.Cleanup(s.Close)
		roots.AddCert(s.Certificate())
		relays = append(relays, transport.Relay{Region: id, URL: s.URL + "/derp"})
		servers = append(servers, r)
	}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	newNode := func(keys *crypto.Keypair, ip string) (*Device, *transport.Mux) {
		mux := transport.NewMux(transport.Config{PrivateKey: keys.PrivateKey, Relays: relays, TLSConfig: &tls.Config{RootCAs: roots}}, []string{transport.UDP, transport.DERP})
		dev, err := New(Config{Mode: ModeNetstack, PrivateKey: keys.PrivateKey, Addresses: []netip.Prefix{netip.MustParsePrefix(ip)}, TransportMux: mux})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = dev.Close() })
		go dev.WatchAuthenticatedPaths(ctx, 25*time.Millisecond)
		return dev, mux
	}
	a, am := newNode(aKeys, "100.64.0.1/10")
	b, bm := newNode(bKeys, "100.64.0.2/10")
	aPort, _ := a.ListenPort()
	bPort, _ := b.ListenPort()
	proxy, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = proxy.Close() })
	var blocked atomic.Bool
	go func() {
		buf := make([]byte, 65535)
		for {
			n, from, err := proxy.ReadFromUDP(buf)
			if err != nil {
				return
			}
			if blocked.Load() {
				continue
			}
			port := bPort
			if from.Port == int(bPort) {
				port = aPort
			}
			_, _ = proxy.WriteToUDP(buf[:n], &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: int(port)})
		}
	}()
	entry := func(keys *crypto.Keypair, ip string) Peer {
		key := hex.EncodeToString(keys.PublicKey[:])
		paths := []transport.PathSpec{{Transport: transport.UDP, Address: proxy.LocalAddr().String()}}
		for _, r := range relays {
			paths = append(paths, transport.PathSpec{Transport: transport.DERP, Address: r.Region + "/" + key})
		}
		return Peer{PublicKey: key, AllowedIPs: []netip.Prefix{netip.MustParsePrefix(ip)}, Paths: paths}
	}
	pa, pb := entry(aKeys, "100.64.0.1/32"), entry(bKeys, "100.64.0.2/32")
	if err := a.SetPeers([]Peer{pb}); err != nil {
		t.Fatal(err)
	}
	if err := b.SetPeers([]Peer{pa}); err != nil {
		t.Fatal(err)
	}
	echo, err := ListenEcho(b, 9999, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		done := make(chan struct{})
		go func() { _ = echo.Close(); close(done) }()
		select {
		case <-done:
		case <-time.After(time.Second):
		}
	})
	check := func(want string, deadline time.Duration) {
		t.Helper()
		until := time.Now().Add(deadline)
		var lastErr error
		for time.Now().Before(until) {
			lastErr = echoOnce(t, a, "100.64.0.2:9999", 2*time.Second)
			peers, _ := a.Peers()
			if lastErr == nil && len(peers) == 1 && strings.HasPrefix(peers[0].Endpoint, want) {
				return
			}
			time.Sleep(100 * time.Millisecond)
		}
		peers, _ := a.Peers()
		t.Fatalf("TCP/path %s did not converge: %v peers=%+v stats=%+v", want, lastErr, peers, am.Stats())
	}
	check("udp://", 20*time.Second)
	blocked.Store(true)
	check("derp://", 25*time.Second)
	if s := am.Stats()[transport.DERP]; s.TxPackets == 0 || s.RxPackets == 0 {
		t.Fatal("TCP passed without relay ciphertext")
	}
	_ = servers[0].Close()
	check("derp://secondary/", 25*time.Second)
	blocked.Store(false)
	check("udp://", 25*time.Second)
	// Withdraw DERP from the actual per-peer paths while UDP is blackholed. The
	// established session must not continue through its previously roamed endpoint.
	blocked.Store(true)
	pa.Paths = pa.Paths[:1]
	pb.Paths = pb.Paths[:1]
	if err := a.SetPeers([]Peer{pb}); err != nil {
		t.Fatal(err)
	}
	if err := b.SetPeers([]Peer{pa}); err != nil {
		t.Fatal(err)
	}
	before := am.Stats()[transport.DERP]
	if err := echoOnce(t, a, "100.64.0.2:9999", 3*time.Second); err == nil {
		t.Fatal("forbidden DERP carried TCP")
	}
	if after := am.Stats()[transport.DERP]; after != before {
		t.Fatal(fmt.Sprintf("forbidden DERP changed counters: before%+v after%+v", before, after))
	}
	_ = bm
}
