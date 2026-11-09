//go:build windows
// +build windows

package main

import (
	"errors"
	"fmt"
	"io/fs"
	"os"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
)

func installService() error {
	exePath, err := os.Executable()
	if err != nil {
		return fmt.Errorf("cannot determine executable path: %w", err)
	}
	m, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("cannot connect to the service manager (run as Administrator): %w", err)
	}
	defer m.Disconnect()

	s, err := m.CreateService(serviceName, exePath, mgr.Config{
		DisplayName:      serviceDisplayName,
		Description:      serviceDescription,
		StartType:        mgr.StartAutomatic,
		DelayedAutoStart: true,
	})
	if err != nil {
		return fmt.Errorf("cannot create service: %w", err)
	}
	defer s.Close()

	fmt.Printf("Service '%s' installed.\n", serviceName)
	fmt.Println("Next: neronet-windows import <profile.conf>, then neronet-windows up")
	return nil
}

func uninstallService() error {
	m, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("cannot connect to the service manager (run as Administrator): %w", err)
	}
	defer m.Disconnect()

	s, err := m.OpenService(serviceName)
	if err != nil {
		return fmt.Errorf("service not found: %w", err)
	}
	defer s.Close()

	if err := s.Delete(); err != nil {
		return fmt.Errorf("cannot delete service: %w", err)
	}
	fmt.Printf("Service '%s' removed\n", serviceName)
	return nil
}

func startService() error {
	m, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("service manager: %w", err)
	}
	defer m.Disconnect()
	s, err := m.OpenService(serviceName)
	if err != nil {
		return fmt.Errorf("service not found (run install first): %w", err)
	}
	defer s.Close()
	if err := s.Start(); err != nil {
		return fmt.Errorf("start failed: %w", err)
	}
	fmt.Println("Service started")
	return nil
}

func stopService() error {
	m, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("service manager: %w", err)
	}
	defer m.Disconnect()
	s, err := m.OpenService(serviceName)
	if err != nil {
		return fmt.Errorf("service not found: %w", err)
	}
	defer s.Close()
	if _, err := s.Control(svc.Stop); err != nil {
		return fmt.Errorf("stop failed: %w", err)
	}
	fmt.Println("Service stopped")
	return nil
}

// serviceState returns a human-readable service state, or "not installed".
func serviceState() string {
	m, err := mgr.Connect()
	if err != nil {
		return fmt.Sprintf("unknown (service manager: %v)", err)
	}
	defer m.Disconnect()
	s, err := m.OpenService(serviceName)
	if err != nil {
		if errors.Is(err, windows.ERROR_SERVICE_DOES_NOT_EXIST) {
			return "not installed"
		}
		return fmt.Sprintf("unknown (%v)", err)
	}
	defer s.Close()
	st, err := s.Query()
	if err != nil {
		return fmt.Sprintf("unknown (%v)", err)
	}
	switch st.State {
	case svc.Stopped:
		return "stopped"
	case svc.StartPending:
		return "starting"
	case svc.StopPending:
		return "stopping"
	case svc.Running:
		return "running"
	default:
		return fmt.Sprintf("state %d", st.State)
	}
}

// printStatus shows the service state and the imported profile (no secrets).
func printStatus() error {
	rep := statusReport{Service: serviceState()}
	p, err := loadProfile(profilePath(dataDirectory()))
	switch {
	case err == nil:
		rep.Profile = p
	case errors.Is(err, fs.ErrNotExist):
		// No profile imported yet.
	default:
		rep.ProfileErr = fmt.Errorf("%w (status reads the profile as Administrator)", err)
	}
	fmt.Print(formatStatus(rep))
	return nil
}
