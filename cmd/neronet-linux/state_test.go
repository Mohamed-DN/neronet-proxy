package main

import (
	"bytes"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestStateRoundTripAndNoSecretsOnDisk(t *testing.T) {
	dir := t.TempDir()
	p := mustParse(t, sampleProfileText("10.99.0.2/32", "10.99.0.0/24"))
	st := newState(p, 4242, time.Unix(1700000000, 0).UTC())
	st.Routes = []routeSpec{{Prefix: "10.99.0.0/24", Dev: tunName}}
	st.Bypass = []routeSpec{{Prefix: "10.77.42.10/32", Via: "10.77.42.1", Dev: "eth0"}}
	st.KillSwitch = true
	if err := st.save(dir); err != nil {
		t.Fatal(err)
	}

	got, err := loadState(dir)
	if err != nil {
		t.Fatal(err)
	}
	if got.PID != 4242 || got.Interface != tunName || got.Summary != st.Summary || !got.KillSwitch {
		t.Fatalf("loaded %+v", got)
	}
	if len(got.Routes) != 1 || len(got.Bypass) != 1 || got.Bypass[0].Via != "10.77.42.1" {
		t.Fatalf("routes lost in the round trip: %+v", got)
	}

	raw, err := os.ReadFile(filepath.Join(dir, stateFileName))
	if err != nil {
		t.Fatal(err)
	}
	privB64 := base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{1}, 32))
	pskB64 := base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{3}, 32))
	for _, secret := range []string{privB64, pskB64, hex.EncodeToString(bytes.Repeat([]byte{1}, 32)), hex.EncodeToString(bytes.Repeat([]byte{3}, 32))} {
		if strings.Contains(string(raw), secret) {
			t.Fatalf("state file holds a key: %s", raw)
		}
	}
	info, err := os.Stat(filepath.Join(dir, stateFileName))
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("state file mode = %v, want 0600", info.Mode().Perm())
	}
}

func TestLoadStateMissingAndCorrupt(t *testing.T) {
	dir := t.TempDir()
	if _, err := loadState(dir); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("missing state: err = %v, want ErrNotExist", err)
	}
	if err := os.WriteFile(filepath.Join(dir, stateFileName), []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := loadState(dir); err == nil || errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("corrupt state: err = %v, want a parse error", err)
	}
}

func TestRemoveStateIsIdempotent(t *testing.T) {
	dir := t.TempDir()
	if err := removeState(dir); err != nil {
		t.Fatalf("removing a missing state: %v", err)
	}
	if err := (&state{PID: 1, Interface: tunName}).save(dir); err != nil {
		t.Fatal(err)
	}
	if err := removeState(dir); err != nil {
		t.Fatal(err)
	}
	if err := removeState(dir); err != nil {
		t.Fatalf("second removal: %v", err)
	}
}

func TestProcessAlive(t *testing.T) {
	if !processAlive(os.Getpid()) {
		t.Error("the test process must count as alive")
	}
	for _, pid := range []int{0, -1, 1 << 22} {
		if processAlive(pid) {
			t.Errorf("processAlive(%d) = true", pid)
		}
	}
}
