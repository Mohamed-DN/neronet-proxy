package main

import (
	"encoding/json"
	"errors"
	"os"
	"syscall"
	"time"
)

// tunnelState is what a running `neronet up` records for `status` and `down`. It never holds
// key material: Profile is profile.String(), which shows only a public-key prefix.
type tunnelState struct {
	PID       int       `json:"pid"`
	Interface string    `json:"interface"`
	Profile   string    `json:"profile"`
	Addresses []string  `json:"addresses,omitempty"`
	Endpoints []string  `json:"endpoints,omitempty"`
	Routes    []string  `json:"routes,omitempty"`
	DNS       []string  `json:"dns,omitempty"`
	Resolver  string    `json:"resolver,omitempty"`
	StartedAt time.Time `json:"started_at"`
}

func writeState(path string, s tunnelState) error {
	data, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	return writeFile(path, append(data, '\n'), 0644)
}

func readState(path string) (tunnelState, error) {
	var s tunnelState
	data, err := os.ReadFile(path)
	if err != nil {
		return s, err
	}
	err = json.Unmarshal(data, &s)
	return s, err
}

// processAlive reports whether pid exists. EPERM means it exists but belongs to another user
// (the daemon runs as root, `status` may not), so it counts as alive.
func processAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	err := syscall.Kill(pid, 0)
	return err == nil || errors.Is(err, syscall.EPERM)
}
