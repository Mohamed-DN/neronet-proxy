package control

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
	"testing"
	"time"
)

// A control plane on TLS answering the challenge endpoint, with a self-signed
// certificate of its own. Generated per server: httptest's default certificate is the
// same for every server, which would make two "different" CAs one and the same.
func tlsControlPlane(t *testing.T) (*httptest.Server, []byte) {
	t.Helper()

	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	serial, err := rand.Int(rand.Reader, big.NewInt(1<<62))
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber:          serial,
		Subject:               pkix.Name{CommonName: "test control plane"},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(time.Hour),
		IsCA:                  true,
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		IPAddresses:           []net.IP{net.ParseIP("127.0.0.1")},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}

	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"nonce":"00","cp_public_key":"00"}`))
	}))
	srv.TLS = &tls.Config{Certificates: []tls.Certificate{{Certificate: [][]byte{der}, PrivateKey: key}}}
	srv.StartTLS()
	t.Cleanup(srv.Close)

	return srv, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
}

func challenge(c *Client) error {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, err := c.GetChallenge(ctx)
	return err
}

func TestClientWithCATrustsItsControlPlane(t *testing.T) {
	srv, ca := tlsControlPlane(t)

	c, err := NewClientWithCA(srv.URL, ca)
	if err != nil {
		t.Fatalf("NewClientWithCA: %v", err)
	}
	if err := challenge(c); err != nil {
		t.Fatalf("a client given the control plane's CA must reach it: %v", err)
	}
}

func TestDefaultClientRefusesAnUnknownCA(t *testing.T) {
	srv, _ := tlsControlPlane(t)

	if err := challenge(NewClient(srv.URL)); err == nil {
		t.Fatal("a client with only the system roots accepted a certificate no system CA signed")
	}
}

func TestClientWithCARefusesAControlPlaneSignedByAnotherCA(t *testing.T) {
	_, caA := tlsControlPlane(t)
	srvB, _ := tlsControlPlane(t)

	c, err := NewClientWithCA(srvB.URL, caA)
	if err != nil {
		t.Fatalf("NewClientWithCA: %v", err)
	}
	if err := challenge(c); err == nil {
		t.Fatal("a client pinned to one CA accepted a certificate from another")
	}
}

func TestNewClientWithCARefusesBadInput(t *testing.T) {
	srv, ca := tlsControlPlane(t)

	if _, err := NewClientWithCA(srv.URL, []byte("not a certificate")); err == nil {
		t.Error("a CA bundle with no certificate was accepted")
	}
	// A CA means nothing on plain HTTP; accepting it would leave the operator
	// believing the control plane connection is verified.
	if _, err := NewClientWithCA("http://127.0.0.1:8443", ca); err == nil {
		t.Error("a CA was accepted for an http URL")
	}
}
