package main

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"syscall"
	"time"
)

// defaultRunDir holds the state of the running instance (ADR 0029: "under /run/neronet").
const defaultRunDir = "/run/neronet"

const stateFileName = "state.json"

// routeSpec is a route this client installed, recorded so that teardown can remove exactly it.
type routeSpec struct {
	Prefix string `json:"prefix"`
	Via    string `json:"via,omitempty"`
	Dev    string `json:"dev"`
}

// state is what `neronet down` and `neronet status` need to know about the running instance.
// It never holds a private key or a preshared key: the summary is profile.String().
type state struct {
	PID        int         `json:"pid"`
	Interface  string      `json:"interface"`
	Started    time.Time   `json:"started"`
	Summary    string      `json:"summary"`
	ConsoleURL string      `json:"console_url,omitempty"`
	DeviceID   string      `json:"device_id,omitempty"`
	Addresses  []string    `json:"addresses"`
	Endpoints  []string    `json:"endpoints,omitempty"`
	Routes     []routeSpec `json:"routes,omitempty"`
	Bypass     []routeSpec `json:"bypass,omitempty"`
	DNS        []string    `json:"dns,omitempty"`
	DNSSet     bool        `json:"dns_set,omitempty"`
	KillSwitch bool        `json:"kill_switch,omitempty"`
}

// loadState reads the state file. A missing file is reported as fs.ErrNotExist.
func loadState(dir string) (*state, error) {
	raw, err := os.ReadFile(filepath.Join(dir, stateFileName))
	if err != nil {
		return nil, err
	}
	var st state
	if err := json.Unmarshal(raw, &st); err != nil {
		return nil, errors.New("state file is corrupt: " + err.Error())
	}
	return &st, nil
}

// save writes the state atomically (temporary file, then rename), readable by root only.
func (s *state) save(dir string) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	final := filepath.Join(dir, stateFileName)
	tmp := final + ".tmp"
	if err := os.WriteFile(tmp, append(raw, '\n'), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, final)
}

// removeState deletes the state file; a missing file is not an error.
func removeState(dir string) error {
	err := os.Remove(filepath.Join(dir, stateFileName))
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return nil
}

// processAlive reports whether pid is a running process. A zombie (exited, not yet reaped)
// counts as gone, since it no longer runs and holds nothing.
func processAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	if err := syscall.Kill(pid, 0); err != nil && !errors.Is(err, syscall.EPERM) {
		return false
	}
	raw, err := os.ReadFile(filepath.Join("/proc", strconv.Itoa(pid), "stat"))
	if err != nil {
		return true
	}
	// The state field follows the parenthesised command name, which may contain spaces.
	for i := len(raw) - 1; i >= 0; i-- {
		if raw[i] == ')' && i+2 < len(raw) {
			return raw[i+2] != 'Z'
		}
	}
	return true
}
