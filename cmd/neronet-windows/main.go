//go:build windows
// +build windows

// cmd/neronet-windows/main.go
// NeroNet v4 - Windows client (ADR 0029, v0 profile client)
// wireguard-go + Wintun tunnel, run as a Windows service configured from an imported profile.
package main

import (
	"errors"
	"fmt"
	"log"
	"os"

	"golang.org/x/sys/windows/svc"
)

const (
	serviceName        = "NeroNet"
	serviceDisplayName = "NeroNet v4 Sovereign Mesh"
	serviceDescription = "NeroNet encrypted peer-to-peer mesh network client"
)

func main() {
	isService, err := svc.IsWindowsService()
	if err != nil {
		log.Fatalf("failed to detect service mode: %v", err)
	}
	if isService {
		runAsService()
		return
	}

	cmd, err := parseCommand(os.Args[1:])
	if err != nil {
		if errors.Is(err, errUsage) {
			fmt.Fprintln(os.Stderr, usage)
		} else {
			fmt.Fprintf(os.Stderr, "neronet-windows: %v\n\n%s\n", err, usage)
		}
		os.Exit(2)
	}

	switch cmd.name {
	case "import":
		err = importProfile(cmd.args[0])
	case "install":
		err = installService()
	case "uninstall":
		err = uninstallService()
	case "up", "start":
		err = startService()
	case "down", "stop":
		err = stopService()
	case "status":
		err = printStatus()
	case "run":
		// Debug mode: the tunnel runs in this console until Ctrl+C.
		err = newNeroNetService().Run()
	}
	if err != nil {
		fmt.Fprintf(os.Stderr, "neronet-windows: %v\n", err)
		os.Exit(1)
	}
}
