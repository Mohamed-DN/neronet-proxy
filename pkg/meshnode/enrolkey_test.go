package meshnode

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/sovereign/proxy/v4/pkg/control"
	"github.com/sovereign/proxy/v4/pkg/crypto"
)

const testPreauth = "nnk1:TESTKEYTESTKEYTESTKEY:0123456789ab"

func writeKey(t *testing.T, content string, mode os.FileMode) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "enrol.key")
	if err := os.WriteFile(p, []byte(content), mode); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(p, mode); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestEnrolmentKeyFromFileIsReadTrimmedAndConsumed(t *testing.T) {
	p := writeKey(t, testPreauth+"\n", 0o600)
	key, consume, err := enrolmentKeySource("", p)
	if err != nil || key != testPreauth {
		t.Fatalf("key %q err %v", key, err)
	}
	if _, err := os.Stat(p); err != nil {
		t.Fatal("the file went away before the key was used")
	}
	consume()
	if _, err := os.Stat(p); !os.IsNotExist(err) {
		t.Fatal("the key file survived its first use")
	}
	// once enrolled, the next start has no file and that is not an error
	key, _, err = enrolmentKeySource("", p)
	if err != nil || key != "" {
		t.Fatalf("after use: %q %v", key, err)
	}
}

func TestEnrolmentKeyEnvWinsAndTheFileIsLeftAlone(t *testing.T) {
	p := writeKey(t, "other", 0o600)
	key, consume, err := enrolmentKeySource(testPreauth, p)
	consume()
	if err != nil || key != testPreauth {
		t.Fatalf("%q %v", key, err)
	}
	if _, err := os.Stat(p); err != nil {
		t.Fatal("a file that was not used was removed")
	}
}

func TestEnrolmentKeyFileThatOthersCanReadIsRefused(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX modes")
	}
	p := writeKey(t, testPreauth, 0o644)
	_, _, err := enrolmentKeySource("", p)
	if err == nil {
		t.Fatal("a world-readable key file was accepted")
	}
	if strings.Contains(err.Error(), "TESTKEY") {
		t.Fatalf("the error carries the key: %v", err)
	}
}

func TestEnrolmentKeyEmptyFileIsRefused(t *testing.T) {
	p := writeKey(t, " \n", 0o600)
	if _, _, err := enrolmentKeySource("", p); err == nil {
		t.Fatal("an empty key file was accepted")
	}
}

func strangerCert(t *testing.T) tls.Certificate {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(7), Subject: pkix.Name{CommonName: "stranger"},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour),
		IPAddresses: []net.IP{net.ParseIP("127.0.0.1")}, DNSNames: []string{"localhost"},
		KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}
}

func selfSignedCA(t *testing.T, srv *httptest.Server) []byte {
	t.Helper()
	return pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: srv.Certificate().Raw})
}

// The control plane's public address is reached over TLS verified against the pinned CA:
// there is no setting that skips verification, and a server the CA did not sign is refused.
func TestControlPlaneIsVerifiedAgainstThePinnedCA(t *testing.T) {
	var trustedHits, otherHits atomic.Int32
	trusted := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		trustedHits.Add(1)
		w.WriteHeader(http.StatusForbidden)
	}))
	trusted.TLS = &tls.Config{MinVersion: tls.VersionTLS12}
	trusted.StartTLS()
	defer trusted.Close()
	// httptest servers share one built-in certificate; the stranger needs its own.
	other := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { otherHits.Add(1) }))
	other.TLS = &tls.Config{Certificates: []tls.Certificate{strangerCert(t)}, MinVersion: tls.VersionTLS12}
	other.StartTLS()
	defer other.Close()

	caPath := filepath.Join(t.TempDir(), "ca.pem")
	if err := os.WriteFile(caPath, selfSignedCA(t, trusted), 0o600); err != nil {
		t.Fatal(err)
	}
	kp, err := crypto.GenerateKeypair()
	if err != nil {
		t.Fatal(err)
	}
	try := func(url string) error {
		c, err := newControlClient(url, caPath)
		if err != nil {
			t.Fatal(err)
		}
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_, err = enrolmentFor(kp, testPreauth).register(ctx, c, "EXIT_BRIDGE", control.CapabilityDesc{}, nil)
		return err
	}
	_ = try(trusted.URL)
	if trustedHits.Load() == 0 {
		t.Fatal("the server the pinned CA signed was never reached")
	}
	if err := try(other.URL); err == nil || otherHits.Load() != 0 {
		t.Fatalf("a server the pinned CA did not sign was reached (%d requests) or accepted: %v", otherHits.Load(), err)
	}
}

func TestEnrolmentKeyFromEnvReadsBothVariables(t *testing.T) {
	p := writeKey(t, testPreauth, 0o600)
	t.Setenv("SOVEREIGN_ENROLMENT_KEY", "")
	t.Setenv("SOVEREIGN_ENROLMENT_KEY_FILE", p)
	key, _, err := EnrolmentKeyFromEnv()
	if err != nil || key != testPreauth {
		t.Fatalf("%q %v", key, err)
	}
}
