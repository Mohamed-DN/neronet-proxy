package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestNewControlClientWithoutCA(t *testing.T) {
	c, err := newControlClient("http://127.0.0.1:8443", "")
	if err != nil || c == nil {
		t.Fatalf("no CA must give a plain client, got %v, %v", c, err)
	}
}

func TestNewControlClientRefusesAnUnreadableCA(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "absent-ca.pem")
	if _, err := newControlClient("https://frontend:8443", missing); err == nil {
		t.Fatal("a CA file that does not exist must stop the node, not fall back to the system roots")
	}
}

func TestNewControlClientRefusesAFileWithNoCertificate(t *testing.T) {
	path := filepath.Join(t.TempDir(), "ca.pem")
	if err := os.WriteFile(path, []byte("hello"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := newControlClient("https://frontend:8443", path); err == nil {
		t.Fatal("a CA file without a certificate was accepted")
	}
}
