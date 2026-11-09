// Command neronet is the macOS client for NeroNet profile devices (ADR 0029, v0).
//
// It runs as root under launchd and brings a NeroNet profile up with wireguard-go on a utun
// interface. It is unsigned: there is no Apple Developer ID, so there is no NetworkExtension.
// Private keys are never printed or logged.
package main

import (
	"errors"
	"fmt"
	"io"
	"os"
)

// version is set at build time with -ldflags "-X main.version=...".
var version = "0.1.0-dev"

const usage = `neronet: NeroNet client for macOS (profile devices, ADR 0029)

Usage:
  neronet up <profile.conf>         bring the tunnel up in the foreground (root)
  neronet down                      stop the running tunnel (root)
  neronet status                    show the running tunnel
  neronet install-daemon <profile>  install the profile and the launchd daemon (root)
  neronet uninstall-daemon          stop and remove the daemon, its profile and binary (root)
  neronet version
`

func main() {
	if err := run(os.Args[1:], os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, "neronet:", err)
		os.Exit(1)
	}
}

func run(args []string, stdout io.Writer) error {
	if len(args) == 0 {
		fmt.Fprint(stdout, usage)
		return errors.New("no command given")
	}
	switch args[0] {
	case "up":
		if len(args) != 2 {
			return errors.New("usage: neronet up <profile.conf>")
		}
		return runUp(args[1], stdout)
	case "down":
		return stopTunnel(stdout)
	case "status":
		return showStatus(stdout)
	case "version":
		fmt.Fprintf(stdout, "neronet %s\n", version)
		return nil
	case "install-daemon":
		if len(args) != 2 {
			return errors.New("usage: neronet install-daemon <profile.conf>")
		}
		return installDaemon(args[1], stdout)
	case "uninstall-daemon":
		return uninstallDaemon(stdout)
	case "help", "-h", "--help":
		fmt.Fprint(stdout, usage)
		return nil
	default:
		fmt.Fprint(stdout, usage)
		return fmt.Errorf("unknown command %q", args[0])
	}
}
