package main

import (
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"os"
	"strings"
	"syscall"
	"time"
)

// runDown implements `neronet down`: it stops the running instance with SIGTERM (SIGKILL if
// it does not exit), then tears down whatever is still recorded. Running it with nothing up
// is not an error.
func runDown(dir string, stdout, stderr io.Writer) error {
	st, err := loadState(dir)
	if errors.Is(err, fs.ErrNotExist) {
		fmt.Fprintln(stdout, "neronet: not running")
		return nil
	}
	if err != nil {
		return err
	}
	if os.Geteuid() != 0 {
		return errors.New("needs root: run it with sudo")
	}
	if processAlive(st.PID) {
		if err := syscall.Kill(st.PID, syscall.SIGTERM); err != nil {
			return fmt.Errorf("signalling pid %d: %w", st.PID, err)
		}
		if !waitGone(st.PID, 15*time.Second) {
			fmt.Fprintf(stderr, "neronet: pid %d did not exit after SIGTERM; killing it\n", st.PID)
			_ = syscall.Kill(st.PID, syscall.SIGKILL)
			if !waitGone(st.PID, 5*time.Second) {
				return fmt.Errorf("pid %d is still running", st.PID)
			}
		}
		// The instance normally removed its own state; reload to see what it left.
		st, err = loadState(dir)
		if errors.Is(err, fs.ErrNotExist) {
			fmt.Fprintln(stdout, "neronet: down")
			return nil
		}
		if err != nil {
			return err
		}
	}
	if err := (&runtime{dir: dir, st: st}).teardown(); err != nil {
		return err
	}
	fmt.Fprintln(stdout, "neronet: down")
	return nil
}

// waitGone polls until pid has exited or the timeout passes.
func waitGone(pid int, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for processAlive(pid) {
		if time.Now().After(deadline) {
			return false
		}
		time.Sleep(100 * time.Millisecond)
	}
	return true
}

// runStatus implements `neronet status`.
func runStatus(dir string, stdout io.Writer) error {
	st, err := loadState(dir)
	if errors.Is(err, fs.ErrNotExist) {
		return errors.New("not running")
	}
	if err != nil {
		return err
	}
	fmt.Fprintf(stdout, "interface:   %s\n", st.Interface)
	if !processAlive(st.PID) {
		return fmt.Errorf("stale state: pid %d is not running; run `sudo neronet down` to clean up", st.PID)
	}
	fmt.Fprintf(stdout, "state:       up (pid %d, since %s)\n", st.PID, st.Started.Format(time.RFC3339))
	fmt.Fprintf(stdout, "profile:     %s\n", st.Summary)
	if st.ConsoleURL != "" {
		fmt.Fprintf(stdout, "console:     %s\n", st.ConsoleURL)
	}
	fmt.Fprintf(stdout, "kill switch: %s\n", onOff(st.KillSwitch))
	if st.DNSSet {
		fmt.Fprintf(stdout, "DNS:         set (%s)\n", strings.Join(st.DNS, ", "))
	} else {
		fmt.Fprintln(stdout, "DNS:         not set")
	}

	ds, err := queryUAPI(st.Interface)
	if err != nil {
		return fmt.Errorf("reading the device: %w", err)
	}
	fmt.Fprintf(stdout, "listen port: %d\n", ds.ListenPort)
	now := time.Now()
	for _, p := range ds.Peers {
		fmt.Fprintf(stdout, "peer %s\n", p.PublicKey)
		if p.Endpoint != "" {
			fmt.Fprintf(stdout, "  endpoint:    %s\n", p.Endpoint)
		}
		fmt.Fprintf(stdout, "  allowed ips: %s\n", strings.Join(p.AllowedIPs, ", "))
		fmt.Fprintf(stdout, "  handshake:   %s\n", formatHandshake(p.LastHandshake, now))
		fmt.Fprintf(stdout, "  transfer:    rx %d B, tx %d B\n", p.RxBytes, p.TxBytes)
	}
	return nil
}

// queryUAPI asks the device for its state over wireguard-go's IPC socket. The reply never
// contains the private key or the preshared key.
func queryUAPI(iface string) (deviceStatus, error) {
	c, err := net.DialTimeout("unix", uapiSocketPath(iface), 3*time.Second)
	if err != nil {
		return deviceStatus{}, err
	}
	defer c.Close()
	_ = c.SetDeadline(time.Now().Add(5 * time.Second))
	if _, err := io.WriteString(c, "get=1\n\n"); err != nil {
		return deviceStatus{}, err
	}
	return parseUAPIGet(c)
}

// formatHandshake describes the last handshake relative to now.
func formatHandshake(last, now time.Time) string {
	if last.IsZero() {
		return "never"
	}
	return now.Sub(last).Round(time.Second).String() + " ago"
}

func onOff(b bool) string {
	if b {
		return "on"
	}
	return "off"
}
