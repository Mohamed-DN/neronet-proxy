package main

import (
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"syscall"
	"time"
)

// showStatus prints the running tunnel recorded by `neronet up`, if any.
func showStatus(stdout io.Writer) error {
	s, err := readState(statePath)
	if errors.Is(err, os.ErrNotExist) {
		fmt.Fprintln(stdout, "not running")
		return nil
	}
	if err != nil {
		return err
	}
	if !processAlive(s.PID) {
		fmt.Fprintf(stdout, "not running (stale state for pid %d; run neronet down to clear it)\n", s.PID)
		return nil
	}
	fmt.Fprintf(stdout, "running (pid %d, since %s)\n", s.PID, s.StartedAt.Local().Format(time.RFC3339))
	fmt.Fprintf(stdout, "interface: %s\n", s.Interface)
	fmt.Fprintf(stdout, "profile: %s\n", s.Profile)
	fmt.Fprintf(stdout, "addresses: %s\n", listOrNone(s.Addresses))
	fmt.Fprintf(stdout, "routes: %s\n", listOrNone(s.Routes))
	fmt.Fprintf(stdout, "endpoints: %s\n", listOrNone(s.Endpoints))
	fmt.Fprintf(stdout, "dns: %s\n", listOrNone(s.DNS))
	if s.Resolver != "" {
		fmt.Fprintf(stdout, "resolver file: %s\n", s.Resolver)
	} else {
		fmt.Fprintln(stdout, "system DNS: not changed")
	}
	return nil
}

// stopTunnel asks the running `neronet up` to tear down (SIGTERM) and waits for it to exit.
// Without a live process it only clears the stale state, so it can be run any number of times.
func stopTunnel(stdout io.Writer) error {
	if err := requireRoot(); err != nil {
		return err
	}
	s, err := readState(statePath)
	if errors.Is(err, os.ErrNotExist) {
		fmt.Fprintln(stdout, "not running")
		return nil
	}
	if err != nil {
		return err
	}
	if !processAlive(s.PID) {
		if s.Resolver != "" {
			if err := removeIfExists(s.Resolver); err != nil {
				return err
			}
		}
		if err := removeIfExists(statePath); err != nil {
			return err
		}
		fmt.Fprintln(stdout, "not running (cleared stale state)")
		return nil
	}
	if err := syscall.Kill(s.PID, syscall.SIGTERM); err != nil {
		return fmt.Errorf("signal pid %d: %w", s.PID, err)
	}
	deadline := time.Now().Add(15 * time.Second)
	for processAlive(s.PID) {
		if time.Now().After(deadline) {
			return fmt.Errorf("pid %d did not exit within 15s", s.PID)
		}
		time.Sleep(200 * time.Millisecond)
	}
	fmt.Fprintln(stdout, "stopped")
	return nil
}

func listOrNone(items []string) string {
	if len(items) == 0 {
		return "none"
	}
	return strings.Join(items, ", ")
}
