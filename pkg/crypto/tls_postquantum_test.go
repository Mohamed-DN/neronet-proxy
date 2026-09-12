package crypto_test

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"
)

// selfSignedCert builds a throwaway certificate for a local handshake.
func selfSignedCert(t *testing.T) tls.Certificate {
	t.Helper()

	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}

	template := x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{CommonName: "localhost"},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(time.Hour),
		DNSNames:     []string{"localhost"},
		IPAddresses:  []net.IP{net.ParseIP("127.0.0.1")},
	}

	der, err := x509.CreateCertificate(rand.Reader, &template, &template, &key.PublicKey, key)
	if err != nil {
		t.Fatalf("CreateCertificate: %v", err)
	}

	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}
}

// TestTLSNegotiatesPostQuantumKeyExchange asserts that a handshake using the project's
// TLS defaults actually agrees on a hybrid post-quantum group.
//
// This is the only thing standing between the codebase and a silent downgrade. Go
// offers X25519MLKEM768 by default, but only while Config.CurvePreferences is nil --
// and "hardening" a TLS config by pinning curve preferences is a natural-looking
// change that turns post-quantum protection off without any error, warning, or
// visible difference. Traffic captured today and decrypted years from now is the
// cost, so the guarantee has to be asserted rather than assumed.
func TestTLSNegotiatesPostQuantumKeyExchange(t *testing.T) {
	cert := selfSignedCert(t)

	listener, err := tls.Listen("tcp", "127.0.0.1:0", &tls.Config{
		Certificates: []tls.Certificate{cert},
		MinVersion:   tls.VersionTLS13,
		// CurvePreferences deliberately left nil: that is the condition under which
		// Go offers the hybrid group, and the condition this test protects.
	})
	if err != nil {
		t.Fatalf("tls.Listen: %v", err)
	}
	defer listener.Close()

	serverErr := make(chan error, 1)
	go func() {
		conn, acceptErr := listener.Accept()
		if acceptErr != nil {
			serverErr <- acceptErr
			return
		}
		defer conn.Close()
		serverErr <- conn.(*tls.Conn).Handshake()
	}()

	client, err := tls.Dial("tcp", listener.Addr().String(), &tls.Config{
		InsecureSkipVerify: true, // self-signed certificate, loopback only
		MinVersion:         tls.VersionTLS13,
	})
	if err != nil {
		t.Fatalf("tls.Dial: %v", err)
	}
	defer client.Close()

	if err := <-serverErr; err != nil {
		t.Fatalf("server handshake: %v", err)
	}

	state := client.ConnectionState()
	if state.CurveID != tls.X25519MLKEM768 {
		t.Fatalf(
			"TLS negotiated key exchange group %v, want X25519MLKEM768 (%v). "+
				"Post-quantum protection is off: check that no tls.Config sets CurvePreferences, "+
				"and that go.mod does not declare a Go version older than 1.24.",
			state.CurveID, tls.X25519MLKEM768,
		)
	}
}

// TestNoCurvePreferencesPinnedInSource fails if any tls.Config in this repository pins
// CurvePreferences without naming a post-quantum group.
//
// The handshake test above only covers a config built the way this test builds one.
// This one covers the actual failure mode: somebody adding CurvePreferences to a real
// config elsewhere in the tree, where nothing would exercise it.
func TestNoCurvePreferencesPinnedInSource(t *testing.T) {
	root, err := filepath.Abs(filepath.Join("..", ".."))
	if err != nil {
		t.Fatalf("resolve repo root: %v", err)
	}

	assignment := regexp.MustCompile(`CurvePreferences\s*[:=]`)
	var offenders []string

	err = filepath.WalkDir(root, func(path string, d os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return nil // unreadable paths are not this test's concern
		}
		if d.IsDir() {
			switch d.Name() {
			case "node_modules", ".git", "dist", "build", "vendor":
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(path, ".go") {
			return nil
		}
		// This file names the symbol in prose and in the pattern above.
		if strings.HasSuffix(path, "tls_postquantum_test.go") {
			return nil
		}

		content, readErr := os.ReadFile(path)
		if readErr != nil {
			return nil
		}

		for i, line := range strings.Split(string(content), "\n") {
			trimmed := strings.TrimSpace(line)
			if strings.HasPrefix(trimmed, "//") || !assignment.MatchString(line) {
				continue
			}
			// Pinning is acceptable as long as a hybrid group is among the choices.
			if strings.Contains(line, "MLKEM") {
				continue
			}
			rel, _ := filepath.Rel(root, path)
			offenders = append(offenders, rel+":"+itoa(i+1))
		}

		return nil
	})
	if err != nil {
		t.Fatalf("walk: %v", err)
	}

	if len(offenders) > 0 {
		t.Fatalf(
			"CurvePreferences is pinned without a post-quantum group at: %s. "+
				"Setting it overrides Go's default hybrid key exchange and silently disables "+
				"post-quantum protection. Either leave it nil or include tls.X25519MLKEM768.",
			strings.Join(offenders, ", "),
		)
	}
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var digits []byte
	for n > 0 {
		digits = append([]byte{byte('0' + n%10)}, digits...)
		n /= 10
	}
	return string(digits)
}
