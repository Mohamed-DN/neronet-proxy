// Command neronet is the Linux client for NeroNet profiles (ADR 0029, version 0).
//
// `neronet up` brings a NeroNet profile (a wg-quick configuration with NeroNet comment
// metadata, see pkg/profile) up with the userspace WireGuard implementation: a TUN interface,
// its addresses, routes, DNS and, with --kill-switch, an nftables table that blocks everything
// except the tunnel and the peer endpoints. It stays in the foreground. `neronet down` stops
// it; `neronet status` reads it back through the device's UAPI socket.
package main

import (
	"fmt"
	"io"
	"os"
)

// version is set at build time with -ldflags "-X main.version=...".
var version = "0.0.0-dev"

const usage = `usage:
  neronet up [--kill-switch] <profile.conf>  bring the tunnel up; stays in the foreground
  neronet down                               tear down the running tunnel
  neronet status                             interface, peers, last handshake, traffic
  neronet version
`

func main() {
	os.Exit(run(os.Args[1:], os.Stdout, os.Stderr))
}

func run(args []string, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		fmt.Fprint(stderr, usage)
		return 2
	}
	var err error
	switch args[0] {
	case "up":
		var ua upArgs
		ua, err = parseUpArgs(args[1:])
		if err != nil {
			fmt.Fprintf(stderr, "neronet up: %v\n%s", err, usage)
			return 2
		}
		err = runUp(ua, defaultRunDir, stdout, stderr)
	case "down":
		err = runDown(defaultRunDir, stdout, stderr)
	case "status":
		err = runStatus(defaultRunDir, stdout)
	case "version", "--version", "-v":
		fmt.Fprintf(stdout, "neronet %s\n", version)
	case "help", "--help", "-h":
		fmt.Fprint(stdout, usage)
	default:
		fmt.Fprintf(stderr, "neronet: unknown command %q\n%s", args[0], usage)
		return 2
	}
	if err != nil {
		fmt.Fprintf(stderr, "neronet %s: %v\n", args[0], err)
		return 1
	}
	return 0
}
