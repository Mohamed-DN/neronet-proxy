package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
)

// writeFile replaces path atomically with data and mode. The mode is enforced even when the
// file existed with another one, so a secret profile is never left world-readable. Writing
// through a temporary file and renaming also works when path is a running executable, which
// on macOS refuses to be written in place.
func writeFile(path string, data []byte, mode os.FileMode) error {
	tmp := path + ".tmp"
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, mode)
	if err != nil {
		return err
	}
	if _, err := f.Write(data); err != nil {
		f.Close()
		os.Remove(tmp)
		return err
	}
	if err := f.Close(); err != nil {
		os.Remove(tmp)
		return err
	}
	if err := os.Chmod(tmp, mode); err != nil {
		os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		os.Remove(tmp)
		return err
	}
	return nil
}

// removeIfExists deletes path and ignores a missing file.
func removeIfExists(path string) error {
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

// runCmd runs one argv from the plans in netcfg.go and reports its output on failure.
func runCmd(argv []string) error {
	out, err := exec.Command(argv[0], argv[1:]...).CombinedOutput()
	if err != nil {
		return fmt.Errorf("%s: %v: %s", strings.Join(argv, " "), err, strings.TrimSpace(string(out)))
	}
	return nil
}

// requireRoot refuses to run a command that changes the network or system files.
func requireRoot() error {
	if os.Geteuid() != 0 {
		return errors.New("this command needs root: run it with sudo")
	}
	return nil
}
