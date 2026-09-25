//go:build windows
// +build windows

// cmd/neronet-windows/main.go
// NeroNet v4 - Windows Client (WP-602)
// WireGuard-go + Wintun userspace tunnel + Windows Service (SCM) + system tray
package main

import (
	"fmt"
	"log"
	"os"

	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
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

	// CLI mode
	if len(os.Args) < 2 {
		fmt.Fprintf(os.Stderr, "Usage: neronet-windows [install|uninstall|start|stop|run]\n")
		os.Exit(1)
	}

	switch os.Args[1] {
	case "install":
		installService()
	case "uninstall":
		uninstallService()
	case "start":
		startService()
	case "stop":
		stopService()
	case "run":
		// Direct run (debug mode, no SCM)
		n := newNeroNetService()
		if err := n.Run(); err != nil {
			log.Fatalf("run failed: %v", err)
		}
	default:
		fmt.Fprintf(os.Stderr, "Unknown command: %s\n", os.Args[1])
		os.Exit(1)
	}
}

func installService() {
	exePath, err := os.Executable()
	if err != nil {
		log.Fatalf("cannot determine executable path: %v", err)
	}

	m, err := mgr.Connect()
	if err != nil {
		log.Fatalf("cannot connect to SCM: %v", err)
	}
	defer m.Disconnect()

	s, err := m.CreateService(serviceName, exePath, mgr.Config{
		DisplayName:      serviceDisplayName,
		Description:      serviceDescription,
		StartType:        mgr.StartAutomatic,
		DelayedAutoStart: true,
	})
	if err != nil {
		log.Fatalf("cannot create service: %v", err)
	}
	defer s.Close()

	fmt.Printf("Service '%s' installed successfully\n", serviceName)
	fmt.Println("Start with: net start NeroNet  (or: sc start NeroNet)")
}

func uninstallService() {
	m, err := mgr.Connect()
	if err != nil {
		log.Fatalf("cannot connect to SCM: %v", err)
	}
	defer m.Disconnect()

	s, err := m.OpenService(serviceName)
	if err != nil {
		log.Fatalf("service not found: %v", err)
	}
	defer s.Close()

	if err := s.Delete(); err != nil {
		log.Fatalf("cannot delete service: %v", err)
	}
	fmt.Printf("Service '%s' removed\n", serviceName)
}

func startService() {
	m, err := mgr.Connect()
	if err != nil { log.Fatalf("SCM error: %v", err) }
	defer m.Disconnect()
	s, err := m.OpenService(serviceName)
	if err != nil { log.Fatalf("service not found: %v", err) }
	defer s.Close()
	if err := s.Start(); err != nil { log.Fatalf("start failed: %v", err) }
	fmt.Println("Service started")
}

func stopService() {
	m, err := mgr.Connect()
	if err != nil { log.Fatalf("SCM error: %v", err) }
	defer m.Disconnect()
	s, err := m.OpenService(serviceName)
	if err != nil { log.Fatalf("service not found: %v", err) }
	defer s.Close()
	_, err = s.Control(svc.Stop)
	if err != nil { log.Fatalf("stop failed: %v", err) }
	fmt.Println("Service stopped")
}
