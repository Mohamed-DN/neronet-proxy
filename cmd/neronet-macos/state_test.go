package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestStateRoundTripHasNoKeyMaterial(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.json")
	in := tunnelState{
		PID:       4242,
		Interface: "utun7",
		Profile:   "NeroNet profile v1 device=dev-1 addresses=[100.64.12.34/32]",
		Addresses: []string{"100.64.12.34/32"},
		Routes:    []string{"100.64.0.0/10"},
		DNS:       []string{"100.64.0.1"},
		Resolver:  "/etc/resolver/corp.example",
		StartedAt: time.Date(2026, 11, 9, 10, 0, 0, 0, time.UTC),
	}
	if err := writeState(path, in); err != nil {
		t.Fatal(err)
	}
	out, err := readState(path)
	if err != nil {
		t.Fatal(err)
	}
	if out.PID != in.PID || out.Interface != in.Interface || out.Resolver != in.Resolver ||
		!out.StartedAt.Equal(in.StartedAt) || len(out.Routes) != 1 {
		t.Fatalf("round trip changed the state: %+v", out)
	}
	data, _ := os.ReadFile(path)
	for _, key := range []string{"PrivateKey", "PresharedKey", "private_key"} {
		if strings.Contains(string(data), key) {
			t.Fatalf("state file mentions %s", key)
		}
	}
}

func TestProcessAlive(t *testing.T) {
	if !processAlive(os.Getpid()) {
		t.Error("own pid reported dead")
	}
	for _, pid := range []int{0, -1} {
		if processAlive(pid) {
			t.Errorf("processAlive(%d) = true", pid)
		}
	}
}

func TestWriteFileEnforcesModeOnExistingFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "profile.conf")
	if err := os.WriteFile(path, []byte("old"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := writeFile(path, []byte("secret"), 0600); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0600 {
		t.Fatalf("mode = %v, want 0600", info.Mode().Perm())
	}
	data, _ := os.ReadFile(path)
	if string(data) != "secret" {
		t.Fatalf("content = %q", data)
	}
	if _, err := os.Stat(path + ".tmp"); !os.IsNotExist(err) {
		t.Fatal("temporary file left behind")
	}
}

func TestRemoveIfExistsIgnoresMissing(t *testing.T) {
	if err := removeIfExists(filepath.Join(t.TempDir(), "absent")); err != nil {
		t.Fatalf("missing file is an error: %v", err)
	}
}
