package main

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"

	"github.com/sovereign/proxy/v4/pkg/profile"
)

// installDaemon copies this executable and a validated profile into supportDir and writes the
// launchd job. It does not start the job: the printed commands do that, so installing never
// changes the network by itself.
func installDaemon(profilePath string, stdout io.Writer) error {
	if err := requireRoot(); err != nil {
		return err
	}
	data, err := os.ReadFile(profilePath)
	if err != nil {
		return err
	}
	if _, err := profile.Parse(bytes.NewReader(data)); err != nil {
		return fmt.Errorf("refusing to install an invalid profile: %w", err)
	}
	if _, err := searchDomain(data); err != nil {
		return err
	}
	self, err := os.Executable()
	if err != nil {
		return err
	}
	bin, err := os.ReadFile(self)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(supportDir, 0755); err != nil {
		return err
	}
	if err := writeFile(binaryFile, bin, 0755); err != nil {
		return err
	}
	// The profile holds the device's private key: root only.
	if err := writeFile(profileFile, data, 0600); err != nil {
		return err
	}
	if err := writeFile(plistPath, []byte(plistText(binaryFile, profileFile)), 0644); err != nil {
		return err
	}
	fmt.Fprintf(stdout, "installed:\n  %s\n  %s (mode 0600)\n  %s\n", binaryFile, profileFile, plistPath)
	fmt.Fprintf(stdout, "start it with:  sudo launchctl bootstrap system %s\n", plistPath)
	fmt.Fprintf(stdout, "after a new profile, reload with:  sudo launchctl kickstart -k system/%s\n", daemonLabel)
	return nil
}

// uninstallDaemon stops the job (its teardown removes routes and DNS), then removes the
// launchd job, the profile and the binary. A job that is not loaded is not an error.
func uninstallDaemon(stdout io.Writer) error {
	if err := requireRoot(); err != nil {
		return err
	}
	// bootout exits non-zero when the job is not loaded; that is the state we want anyway.
	_ = exec.Command("/bin/launchctl", "bootout", "system/"+daemonLabel).Run()
	for _, p := range []string{plistPath, profileFile, binaryFile} {
		if err := removeIfExists(p); err != nil {
			return err
		}
	}
	// Only removes the directory when nothing else is in it.
	if err := os.Remove(supportDir); err != nil && !errors.Is(err, os.ErrNotExist) {
		fmt.Fprintf(stdout, "kept %s: %v\n", supportDir, err)
	}
	fmt.Fprintln(stdout, "uninstalled")
	return nil
}
