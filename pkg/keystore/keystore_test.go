package keystore

import (
	"bytes"
	"crypto/rand"
	"errors"
	"os"
	"runtime"
	"testing"
)

func TestFileKeyStore(t *testing.T) {
	tempDir, err := os.MkdirTemp("", "keystore-test-*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tempDir)

	ks, err := NewFileKeyStore(tempDir)
	if err != nil {
		t.Fatalf("NewFileKeyStore failed: %v", err)
	}

	if ks.BackendType() != "secure_file_0600" {
		t.Errorf("expected backend 'secure_file_0600', got '%s'", ks.BackendType())
	}

	keyData := make([]byte, 32)
	_, _ = rand.Read(keyData)

	alias := "node-identity-key"

	t.Run("Store and Load key roundtrip", func(t *testing.T) {
		if err := ks.StoreKey(alias, keyData); err != nil {
			t.Fatalf("StoreKey failed: %v", err)
		}

		loaded, err := ks.LoadKey(alias)
		if err != nil {
			t.Fatalf("LoadKey failed: %v", err)
		}

		if !bytes.Equal(loaded, keyData) {
			t.Fatalf("loaded key does not match stored key")
		}
	})

	t.Run("Verify POSIX permissions are 0600", func(t *testing.T) {
		if runtime.GOOS == "windows" {
			t.Skip("POSIX file permissions not applicable on Windows")
		}
		keyFile := ks.keyPath(alias)
		info, err := os.Stat(keyFile)
		if err != nil {
			t.Fatalf("failed to stat key file: %v", err)
		}
		mode := info.Mode().Perm()
		if mode != 0o600 {
			t.Errorf("expected file mode 0600, got %04o", mode)
		}
	})

	t.Run("Tamper detection returns ErrTamperedKey", func(t *testing.T) {
		keyFile := ks.keyPath(alias)
		raw, err := os.ReadFile(keyFile)
		if err != nil {
			t.Fatalf("failed to read key file: %v", err)
		}

		// Tamper with last byte of ciphertext (auth tag)
		raw[len(raw)-1] ^= 0xFF
		if err := os.WriteFile(keyFile, raw, 0o600); err != nil {
			t.Fatalf("failed to write tampered file: %v", err)
		}

		_, err = ks.LoadKey(alias)
		if !errors.Is(err, ErrTamperedKey) {
			t.Fatalf("expected ErrTamperedKey, got %v", err)
		}

		// Restore valid key
		_ = ks.StoreKey(alias, keyData)
	})

	t.Run("Load non-existent alias returns ErrKeyNotFound", func(t *testing.T) {
		_, err := ks.LoadKey("non-existent-alias")
		if !errors.Is(err, ErrKeyNotFound) {
			t.Fatalf("expected ErrKeyNotFound, got %v", err)
		}
	})

	t.Run("Multiple aliases isolation", func(t *testing.T) {
		alias2 := "psk-rosenpass"
		key2 := []byte("rosenpass-psk-material-super-key")

		if err := ks.StoreKey(alias2, key2); err != nil {
			t.Fatalf("StoreKey alias2 failed: %v", err)
		}

		loaded1, err := ks.LoadKey(alias)
		if err != nil || !bytes.Equal(loaded1, keyData) {
			t.Fatalf("alias 1 corrupted by alias 2")
		}

		loaded2, err := ks.LoadKey(alias2)
		if err != nil || !bytes.Equal(loaded2, key2) {
			t.Fatalf("alias 2 loading failed")
		}
	})

	t.Run("DeleteKey and crypto-shredding", func(t *testing.T) {
		if err := ks.DeleteKey(alias); err != nil {
			t.Fatalf("DeleteKey failed: %v", err)
		}

		_, err := ks.LoadKey(alias)
		if !errors.Is(err, ErrKeyNotFound) {
			t.Fatalf("expected ErrKeyNotFound after deletion, got %v", err)
		}
	})
}

func TestFactory(t *testing.T) {
	tempDir, err := os.MkdirTemp("", "keystore-factory-*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tempDir)

	ks, err := NewDefaultKeyStore(tempDir)
	if err != nil {
		t.Fatalf("NewDefaultKeyStore failed: %v", err)
	}
	if ks == nil {
		t.Fatalf("expected non-nil KeyStore")
	}

	backend := ks.BackendType()
	if backend == "" {
		t.Errorf("expected non-empty backend type")
	}

	testKey := []byte("default-keystore-secret-12345")
	if err := ks.StoreKey("factory-test", testKey); err != nil {
		t.Fatalf("StoreKey failed: %v", err)
	}

	loaded, err := ks.LoadKey("factory-test")
	if err != nil {
		t.Fatalf("LoadKey failed: %v", err)
	}
	if !bytes.Equal(loaded, testKey) {
		t.Errorf("loaded key does not match")
	}
}
