// Command sovereign-derp-relay is a NeroNet DERP relay speaking the pinned upstream
// wire protocol (capability derp-v2, ADR 0022).
//
// A relay forwards WireGuard ciphertext between nodes that cannot reach each other
// directly. It holds no mesh key and links to no other relay. Who may connect is the
// control plane's decision, fetched as an admission snapshot with an absolute expiry:
// before the first snapshot every client is refused, and when the control plane stays
// unreachable past the snapshot's lifetime the relay closes every session and refuses
// new ones. Which peers a node may reach through it is decided by the netmap alone.
package main

import (
	"context"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/sovereign/proxy/v4/internal/derpwire"
	"github.com/sovereign/proxy/v4/pkg/config"
)

type relayConfig struct {
	ListenAddr     string
	CertFile       string
	KeyFile        string
	IdentityFile   string
	AdmissionURL   string
	CredentialFile string
	CAFile         string
	Refresh        time.Duration
	Logf           func(string, ...any)
}

var credentialPattern = regexp.MustCompile(`^nrr1_[0-9a-f]{64}$`)

func main() {
	_ = config.LoadDotEnv()
	cfg := relayConfig{Logf: log.Printf}
	flag.StringVar(&cfg.ListenAddr, "listen-addr", envOr("SOVEREIGN_RELAY_LISTEN_ADDR", "0.0.0.0:8443"), "HTTPS listen address")
	flag.StringVar(&cfg.CertFile, "tls-cert", os.Getenv("SOVEREIGN_RELAY_TLS_CERT"), "TLS certificate (PEM) presented to nodes")
	flag.StringVar(&cfg.KeyFile, "tls-key", os.Getenv("SOVEREIGN_RELAY_TLS_KEY"), "TLS private key (PEM)")
	flag.StringVar(&cfg.IdentityFile, "identity-file", os.Getenv("SOVEREIGN_RELAY_IDENTITY_FILE"), "persistent relay identity; created on first start")
	flag.StringVar(&cfg.AdmissionURL, "admission-url", os.Getenv("SOVEREIGN_RELAY_ADMISSION_URL"), "control plane admission snapshot URL (https)")
	flag.StringVar(&cfg.CredentialFile, "credential-file", os.Getenv("SOVEREIGN_RELAY_CREDENTIAL_FILE"), "file holding this relay's service credential (nrr1_...)")
	flag.StringVar(&cfg.CAFile, "ca-file", os.Getenv("SOVEREIGN_RELAY_CA_FILE"), "CA bundle for the control plane; system roots when empty")
	flag.DurationVar(&cfg.Refresh, "refresh", 15*time.Second, "admission snapshot refresh interval")
	flag.Parse()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := run(ctx, cfg, nil); err != nil {
		log.Fatalf("[SOVEREIGN-DERP-RELAY] %v", err)
	}
	log.Println("[SOVEREIGN-DERP-RELAY] stopped")
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

// loadOrCreateIdentity returns the relay's long-lived private key. Nodes see the relay
// by URL and TLS certificate, but the DERP handshake binds sessions to this key: a new
// key on every restart would be a different relay to every connected client.
func loadOrCreateIdentity(path string) ([32]byte, error) {
	var k [32]byte
	if path == "" {
		return k, errors.New("an identity file is required")
	}
	raw, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		if _, err := rand.Read(k[:]); err != nil {
			return k, err
		}
		f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
		if err != nil {
			return [32]byte{}, fmt.Errorf("creating identity: %w", err)
		}
		_, werr := f.WriteString(hex.EncodeToString(k[:]) + "\n")
		cerr := f.Close()
		if werr != nil || cerr != nil {
			return [32]byte{}, fmt.Errorf("writing identity: %v %v", werr, cerr)
		}
		return k, nil
	}
	if err != nil {
		return k, fmt.Errorf("reading identity: %w", err)
	}
	decoded, err := hex.DecodeString(strings.TrimSpace(string(raw)))
	if err != nil || len(decoded) != 32 {
		return k, errors.New("identity file does not hold a 32-byte hex key")
	}
	copy(k[:], decoded)
	if k == ([32]byte{}) {
		return k, errors.New("identity file holds the zero key")
	}
	return k, nil
}

func readCredential(path string) (string, error) {
	if path == "" {
		return "", errors.New("a credential file is required")
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("reading credential: %w", err)
	}
	credential := strings.TrimSpace(string(raw))
	if !credentialPattern.MatchString(credential) {
		return "", errors.New("credential file does not hold a relay credential (nrr1_...)")
	}
	return credential, nil
}

func controlRoots(caFile string) (*tls.Config, error) {
	cfg := &tls.Config{MinVersion: tls.VersionTLS12}
	if caFile == "" {
		return cfg, nil
	}
	pem, err := os.ReadFile(caFile)
	if err != nil {
		return nil, fmt.Errorf("reading CA bundle: %w", err)
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(pem) {
		return nil, errors.New("CA bundle holds no certificate")
	}
	cfg.RootCAs = pool
	return cfg, nil
}

// run serves until ctx ends. ready, when set, receives the bound address once the
// listener is up.
func run(ctx context.Context, cfg relayConfig, ready func(net.Addr)) error {
	if cfg.Logf == nil {
		cfg.Logf = func(string, ...any) {}
	}
	identity, err := loadOrCreateIdentity(cfg.IdentityFile)
	if err != nil {
		return err
	}
	credential, err := readCredential(cfg.CredentialFile)
	if err != nil {
		return err
	}
	roots, err := controlRoots(cfg.CAFile)
	if err != nil {
		return err
	}
	cert, err := tls.LoadX509KeyPair(cfg.CertFile, cfg.KeyFile)
	if err != nil {
		return fmt.Errorf("loading TLS certificate: %w", err)
	}

	// The cache calls back when keys disappear or the snapshot expires; the relay it
	// calls back into exists only after the cache, hence the late binding.
	var mu sync.Mutex
	var relay *derpwire.RelayServer
	invalidate := func() {
		mu.Lock()
		r := relay
		mu.Unlock()
		if r != nil {
			cfg.Logf("[SOVEREIGN-DERP-RELAY] admission withdrawn or expired: closing every session")
			r.Invalidate()
		}
	}
	cache, err := derpwire.NewAdmissionCache(cfg.AdmissionURL, credential, roots, invalidate)
	if err != nil {
		return err
	}
	r, err := derpwire.NewRelay(identity, cache.Allows, cfg.Logf)
	if err != nil {
		return err
	}
	mu.Lock()
	relay = r
	mu.Unlock()
	defer r.Close()

	handler := http.NewServeMux()
	handler.Handle("/derp", r)
	// Healthy means "can admit": a relay serving an expired snapshot refuses every
	// client, and saying so lets the orchestrator and the operator see it.
	handler.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		if cache.Valid() {
			_, _ = w.Write([]byte("ok\n"))
			return
		}
		http.Error(w, "no valid admission snapshot", http.StatusServiceUnavailable)
	})

	ln, err := net.Listen("tcp", cfg.ListenAddr)
	if err != nil {
		return err
	}
	server := &http.Server{
		Handler:           handler,
		TLSConfig:         &tls.Config{MinVersion: tls.VersionTLS12, Certificates: []tls.Certificate{cert}},
		ReadHeaderTimeout: 10 * time.Second,
	}
	runCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	go cache.Run(runCtx, cfg.Refresh)

	served := make(chan error, 1)
	go func() { served <- server.ServeTLS(ln, "", "") }()
	cfg.Logf("[SOVEREIGN-DERP-RELAY] derp-v2 relay listening on %s; every client refused until the first admission snapshot", ln.Addr())
	if ready != nil {
		ready(ln.Addr())
	}
	select {
	case <-ctx.Done():
		shutdown, done := context.WithTimeout(context.Background(), 5*time.Second)
		defer done()
		_ = server.Shutdown(shutdown)
		return nil
	case err := <-served:
		return err
	}
}
