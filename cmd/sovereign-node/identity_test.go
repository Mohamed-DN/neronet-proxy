package main

import (
	"os"
	"path/filepath"
	"testing"
)

// TestIdentitySurvivesRestart is the regression test for nodes enrolling as a new
// device on every start. It calls the loader twice, as two runs of the process
// would, and requires the second to return the key the first created.
func TestIdentitySurvivesRestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "node_identity.key")

	first, err := loadOrCreateIdentity(path)
	if err != nil {
		t.Fatalf("first start: %v", err)
	}

	second, err := loadOrCreateIdentity(path)
	if err != nil {
		t.Fatalf("second start: %v", err)
	}

	if first.PrivateKey != second.PrivateKey {
		t.Error("the private key changed across a restart")
	}
	if first.PublicKey != second.PublicKey {
		t.Errorf("the public key changed across a restart: %x then %x",
			first.PublicKey[:8], second.PublicKey[:8])
	}
}

// TestIdentityFileIsNotWorldReadable checks the stored private key is not left
// readable by other accounts on the host.
func TestIdentityFileIsNotWorldReadable(t *testing.T) {
	path := filepath.Join(t.TempDir(), "sub", "node_identity.key")

	if _, err := loadOrCreateIdentity(path); err != nil {
		t.Fatalf("create: %v", err)
	}

	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Errorf("identity file permissions are %o, want 600", perm)
	}
}

// TestCorruptIdentityIsFatal requires a damaged key to stop the node rather than
// silently regenerate one, which would restore the very behaviour being fixed.
func TestCorruptIdentityIsFatal(t *testing.T) {
	path := filepath.Join(t.TempDir(), "node_identity.key")
	if err := os.WriteFile(path, []byte("truncated"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}

	if _, err := loadOrCreateIdentity(path); err == nil {
		t.Error("a 9-byte identity file was accepted")
	}
}
