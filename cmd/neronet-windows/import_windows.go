//go:build windows
// +build windows

package main

import (
	"bytes"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"golang.org/x/sys/windows"

	"github.com/sovereign/proxy/v4/pkg/profile"
)

// Protected DACLs: "P" stops inheritance from ProgramData, which grants Users read access.
// Only SYSTEM (the service runs as LocalSystem) and Administrators keep full control.
const (
	sddlDirectory = "D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)"
	sddlFile      = "D:P(A;;FA;;;SY)(A;;FA;;;BA)"
)

// restrictACL replaces path's DACL with the one in sddl and stops inheritance.
func restrictACL(path, sddl string) error {
	sd, err := windows.SecurityDescriptorFromString(sddl)
	if err != nil {
		return fmt.Errorf("build ACL: %w", err)
	}
	dacl, _, err := sd.DACL()
	if err != nil {
		return fmt.Errorf("read ACL: %w", err)
	}
	if err := windows.SetNamedSecurityInfo(path, windows.SE_FILE_OBJECT,
		windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION,
		nil, nil, dacl, nil); err != nil {
		return fmt.Errorf("set ACL on %s: %w", path, err)
	}
	return nil
}

// ensureDataDir creates the data directory and restricts it. Without this, a directory
// created by a service would keep the readable ProgramData default.
func ensureDataDir(dir string) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("create %s: %w", dir, err)
	}
	return restrictACL(dir, sddlDirectory)
}

// importProfile validates a profile and copies it to %ProgramData%\NeroNet\profile.conf,
// readable only by SYSTEM and Administrators. It writes to a temporary file and renames it,
// so a running service never sees a half-written profile.
func importProfile(src string) error {
	info, err := os.Stat(src)
	if err != nil {
		return err
	}
	if err := checkImportSource(src, info.Mode().IsRegular(), info.Size()); err != nil {
		return err
	}
	f, err := os.Open(src)
	if err != nil {
		return err
	}
	data, err := io.ReadAll(io.LimitReader(f, maxProfileBytes+1))
	f.Close()
	if err != nil {
		return fmt.Errorf("read %s: %w", src, err)
	}
	if len(data) > maxProfileBytes {
		return fmt.Errorf("import: %s grew past %d bytes while reading", src, maxProfileBytes)
	}

	p, err := profile.Parse(bytes.NewReader(data))
	if err != nil {
		return fmt.Errorf("import %s: %w", src, err)
	}
	// Refuse here what the service would refuse at start, so the error shows at import time.
	if _, err := planNetwork(p); err != nil {
		return fmt.Errorf("import %s: %w", src, err)
	}

	dir := dataDirectory()
	if err := ensureDataDir(dir); err != nil {
		return err
	}
	dst := profilePath(dir)
	tmp := dst + ".tmp"
	os.Remove(tmp)
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return fmt.Errorf("write profile: %w", err)
	}
	if err := restrictACL(tmp, sddlFile); err != nil {
		os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, dst); err != nil {
		os.Remove(tmp)
		return fmt.Errorf("install profile: %w", err)
	}
	fmt.Printf("Imported %s into %s\n", p.String(), filepath.Clean(dst))
	fmt.Println("Start the tunnel with: neronet-windows up")
	return nil
}
