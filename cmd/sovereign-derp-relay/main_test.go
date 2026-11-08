package main

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"tailscale.com/types/key"

	"github.com/sovereign/proxy/v4/internal/derpwire"
	"github.com/sovereign/proxy/v4/pkg/control"
	legacy "github.com/sovereign/proxy/v4/pkg/derp"
)

type testCA struct {
	cert *x509.Certificate
	key  *ecdsa.PrivateKey
	pem  []byte
}

func newCA(t *testing.T) *testCA {
	t.Helper()
	k, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tpl := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "relay test CA"},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(time.Hour),
		IsCA:                  true,
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageCertSign,
	}
	der, err := x509.CreateCertificate(rand.Reader, tpl, tpl, &k.PublicKey, k)
	if err != nil {
		t.Fatal(err)
	}
	cert, _ := x509.ParseCertificate(der)
	return &testCA{cert: cert, key: k, pem: pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})}
}

// leaf returns PEM certificate and key for 127.0.0.1.
func (ca *testCA) leaf(t *testing.T) (certPEM, keyPEM []byte) {
	t.Helper()
	k, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tpl := &x509.Certificate{
		SerialNumber: big.NewInt(time.Now().UnixNano()),
		Subject:      pkix.Name{CommonName: "relay"},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(time.Hour),
		IPAddresses:  []net.IP{net.ParseIP("127.0.0.1")},
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, tpl, ca.cert, &k.PublicKey, ca.key)
	if err != nil {
		t.Fatal(err)
	}
	kd, err := x509.MarshalECPrivateKey(k)
	if err != nil {
		t.Fatal(err)
	}
	return pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: kd})
}

func (ca *testCA) roots() *x509.CertPool {
	p := x509.NewCertPool()
	p.AddCert(ca.cert)
	return p
}

// controlPlane is a fake admission endpoint. It checks the relay's credential and
// serves whatever keys the test currently allows; down makes it answer 503.
type controlPlane struct {
	mu        sync.Mutex
	keys      []string
	staleness int64
	down      bool
	calls     atomic.Int32
	server    *httptest.Server
}

func newControlPlane(t *testing.T, ca *testCA, credential string) *controlPlane {
	t.Helper()
	cp := &controlPlane{staleness: 60}
	cp.server = httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cp.calls.Add(1)
		if r.Method != http.MethodPost || r.URL.Path != "/v4/control/relay/admission" || r.Header.Get("Authorization") != "Bearer "+credential {
			http.Error(w, "no", http.StatusUnauthorized)
			return
		}
		cp.mu.Lock()
		defer cp.mu.Unlock()
		if cp.down {
			http.Error(w, "down", http.StatusServiceUnavailable)
			return
		}
		_ = json.NewEncoder(w).Encode(control.RelayAdmissionSnapshot{Keys: cp.keys, GeneratedAtUnix: time.Now().Unix(), MaxStalenessSeconds: cp.staleness})
	}))
	certPEM, keyPEM := ca.leaf(t)
	pair, err := tls.X509KeyPair(certPEM, keyPEM)
	if err != nil {
		t.Fatal(err)
	}
	cp.server.TLS = &tls.Config{Certificates: []tls.Certificate{pair}}
	cp.server.StartTLS()
	t.Cleanup(cp.server.Close)
	return cp
}

func (cp *controlPlane) set(keys []string, staleness int64, down bool) {
	cp.mu.Lock()
	cp.keys, cp.staleness, cp.down = keys, staleness, down
	cp.mu.Unlock()
}

func write(t *testing.T, dir, name string, data []byte) string {
	t.Helper()
	p := filepath.Join(dir, name)
	if err := os.WriteFile(p, data, 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

func credential() string {
	b := make([]byte, 32)
	_, _ = rand.Read(b)
	return "nrr1_" + hex.EncodeToString(b)
}

// startRelay runs the real entrypoint and returns its DERP URL.
func startRelay(t *testing.T, ca *testCA, cp *controlPlane, cred string) (string, relayConfig) {
	t.Helper()
	dir := t.TempDir()
	certPEM, keyPEM := ca.leaf(t)
	cfg := relayConfig{
		ListenAddr:     "127.0.0.1:0",
		CertFile:       write(t, dir, "tls.crt", certPEM),
		KeyFile:        write(t, dir, "tls.key", keyPEM),
		IdentityFile:   filepath.Join(dir, "identity"),
		AdmissionURL:   cp.server.URL + "/v4/control/relay/admission",
		CredentialFile: write(t, dir, "credential", []byte(cred+"\n")),
		CAFile:         write(t, dir, "ca.crt", ca.pem),
		Refresh:        200 * time.Millisecond,
		Logf:           t.Logf,
	}
	ctx, cancel := context.WithCancel(context.Background())
	addr := make(chan net.Addr, 1)
	done := make(chan error, 1)
	go func() { done <- run(ctx, cfg, func(a net.Addr) { addr <- a }) }()
	t.Cleanup(func() {
		cancel()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Error("relay did not stop")
		}
	})
	select {
	case a := <-addr:
		return "https://" + a.String() + "/derp", cfg
	case err := <-done:
		t.Fatalf("relay did not start: %v", err)
	case <-time.After(5 * time.Second):
		t.Fatal("relay did not start")
	}
	return "", cfg
}

func eventually(t *testing.T, what string, within time.Duration, f func() bool) {
	t.Helper()
	deadline := time.Now().Add(within)
	for time.Now().Before(deadline) {
		if f() {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("%s did not happen within %s", what, within)
}

func never(t *testing.T, what string, during time.Duration, f func() bool) {
	t.Helper()
	deadline := time.Now().Add(during)
	for time.Now().Before(deadline) {
		if f() {
			t.Fatalf("%s happened", what)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func healthy(t *testing.T, ca *testCA, derpURL string) int {
	t.Helper()
	c := &http.Client{Transport: &http.Transport{TLSClientConfig: &tls.Config{RootCAs: ca.roots()}}, Timeout: 2 * time.Second}
	resp, err := c.Get(strings.TrimSuffix(derpURL, "/derp") + "/healthz")
	if err != nil {
		return 0
	}
	resp.Body.Close()
	return resp.StatusCode
}

func pool(t *testing.T, ca *testCA, k key.NodePrivate, relayURL string, received chan<- string) *derpwire.Pool {
	t.Helper()
	p, err := derpwire.NewPool(k.Raw32(), &tls.Config{RootCAs: ca.roots()}, func(relay string, source [32]byte, packet []byte) {
		if received != nil {
			received <- string(packet)
		}
	}, t.Logf)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = p.Close() })
	if err := p.Configure([]derpwire.Relay{{ID: "relay-a", URL: relayURL}}); err != nil {
		t.Fatal(err)
	}
	return p
}

func pubHex(k key.NodePrivate) string {
	raw := k.Public().Raw32()
	return hex.EncodeToString(raw[:])
}

// The entrypoint refuses everyone until the control plane has answered, admits exactly
// the snapshot's keys, closes a revoked node's live session, and -- with the control
// plane gone -- stops admitting and closes every session once the snapshot's own
// lifetime is over, not at the next successful refresh.
func TestRelayEntrypointEnforcesTheAdmissionSnapshot(t *testing.T) {
	ca := newCA(t)
	cred := credential()
	cp := newControlPlane(t, ca, cred)
	cp.set(nil, 60, true) // control plane unreachable at start
	relayURL, _ := startRelay(t, ca, cp, cred)

	a, b := key.NewNode(), key.NewNode()
	got := make(chan string, 16)
	pa := pool(t, ca, a, relayURL, nil)
	pb := pool(t, ca, b, relayURL, got)

	never(t, "a client admitted before any snapshot", 800*time.Millisecond, func() bool {
		return len(pa.Homes()) > 0 || len(pb.Homes()) > 0
	})
	if code := healthy(t, ca, relayURL); code != http.StatusServiceUnavailable {
		t.Fatalf("healthz %d without a snapshot", code)
	}

	cp.set([]string{pubHex(a), pubHex(b)}, 60, false)
	eventually(t, "both nodes admitted", 5*time.Second, func() bool { return len(pa.Homes()) == 1 && len(pb.Homes()) == 1 })
	if code := healthy(t, ca, relayURL); code != http.StatusOK {
		t.Fatalf("healthz %d with a valid snapshot", code)
	}
	if err := pa.Send("relay-a", b.Public().Raw32(), []byte("ciphertext")); err != nil {
		t.Fatal(err)
	}
	select {
	case p := <-got:
		if p != "ciphertext" {
			t.Fatal(p)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("packet not relayed between admitted nodes")
	}

	// Revoking a closes its live session; b reconnects after the rotation.
	cp.set([]string{pubHex(b)}, 60, false)
	eventually(t, "the revoked session closed", 5*time.Second, func() bool { return len(pa.Homes()) == 0 })
	eventually(t, "the remaining node re-admitted", 5*time.Second, func() bool { return len(pb.Homes()) == 1 })
	never(t, "the revoked node re-admitted", time.Second, func() bool { return len(pa.Homes()) > 0 })

	// Control plane down with a 2 s snapshot: refreshes fail, the snapshot is not
	// prolonged, and when it expires b's live session is closed.
	cp.set([]string{pubHex(b)}, 2, false)
	time.Sleep(400 * time.Millisecond) // one refresh picks up the short lifetime
	cp.set([]string{pubHex(b)}, 2, true)
	eventually(t, "sessions closed at snapshot expiry", 5*time.Second, func() bool { return len(pb.Homes()) == 0 })
	never(t, "a client admitted on an expired snapshot", time.Second, func() bool { return len(pb.Homes()) > 0 })
	if code := healthy(t, ca, relayURL); code != http.StatusServiceUnavailable {
		t.Fatalf("healthz %d on an expired snapshot", code)
	}

	// Restored: admission resumes.
	cp.set([]string{pubHex(b)}, 60, false)
	eventually(t, "re-admitted after the control plane returned", 5*time.Second, func() bool { return len(pb.Homes()) == 1 })
}

func TestRelayIdentityPersistsAcrossRestarts(t *testing.T) {
	p := filepath.Join(t.TempDir(), "identity")
	first, err := loadOrCreateIdentity(p)
	if err != nil {
		t.Fatal(err)
	}
	second, err := loadOrCreateIdentity(p)
	if err != nil {
		t.Fatal(err)
	}
	if first != second || first == ([32]byte{}) {
		t.Fatal("identity changed across restarts")
	}
	info, err := os.Stat(p)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm()&0o077 != 0 && os.PathSeparator == '/' {
		t.Fatalf("identity file mode %v is readable by others", info.Mode().Perm())
	}
	if err := os.WriteFile(p, []byte(strings.Repeat("0", 64)), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := loadOrCreateIdentity(p); err == nil {
		t.Fatal("the zero key was accepted as an identity")
	}
}

func TestRelayRefusesToStartWithoutItsCredentialsOrTLS(t *testing.T) {
	ca := newCA(t)
	cred := credential()
	cp := newControlPlane(t, ca, cred)
	dir := t.TempDir()
	certPEM, keyPEM := ca.leaf(t)
	base := relayConfig{
		ListenAddr:     "127.0.0.1:0",
		CertFile:       write(t, dir, "tls.crt", certPEM),
		KeyFile:        write(t, dir, "tls.key", keyPEM),
		IdentityFile:   filepath.Join(dir, "identity"),
		AdmissionURL:   cp.server.URL + "/v4/control/relay/admission",
		CredentialFile: write(t, dir, "credential", []byte(cred)),
		CAFile:         write(t, dir, "ca.crt", ca.pem),
	}
	cases := map[string]func(c *relayConfig){
		"node credential":    func(c *relayConfig) { c.CredentialFile = write(t, dir, "nnt", []byte("nnt1_"+strings.Repeat("a", 64))) },
		"no credential file": func(c *relayConfig) { c.CredentialFile = "" },
		"http admission":     func(c *relayConfig) { c.AdmissionURL = strings.Replace(c.AdmissionURL, "https://", "http://", 1) },
		"no certificate":     func(c *relayConfig) { c.CertFile = "" },
		"empty CA bundle":    func(c *relayConfig) { c.CAFile = write(t, dir, "empty.crt", []byte("x")) },
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			c := base
			mutate(&c)
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			if err := run(ctx, c, func(net.Addr) { t.Error("relay started") }); err == nil {
				t.Fatal("relay started")
			}
		})
	}
}

// The relay the entrypoint used to run (pkg/derp, WebSocket at /ws/v4/relay, no TLS,
// no admission) is not a derp-v2 relay: an upstream client never becomes a home there,
// whoever it is. Kept as a test so the legacy server cannot quietly come back.
func TestLegacyRelayIsNotADERPv2Relay(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := ln.Addr().String()
	ln.Close()
	server := legacy.NewServer(legacy.ServerConfig{ListenAddr: addr, STUNAddr: "127.0.0.1:0", Region: "legacy"})
	if err := server.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = server.Close() })
	p, err := derpwire.NewPool(key.NewNode().Raw32(), &tls.Config{}, nil, t.Logf)
	if err != nil {
		t.Fatal(err)
	}
	defer p.Close()
	if err := p.Configure([]derpwire.Relay{{ID: "legacy", URL: "https://" + addr + "/ws/v4/relay"}}); err != nil {
		t.Fatal(err)
	}
	never(t, "an upstream client homed on the legacy relay", 1500*time.Millisecond, func() bool { return len(p.Homes()) > 0 })
}
