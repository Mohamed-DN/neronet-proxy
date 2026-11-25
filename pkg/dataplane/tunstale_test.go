package dataplane

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func fakeSys(t *testing.T, name string, tun bool) string {
	t.Helper()
	root := t.TempDir()
	if name == "" {
		return root
	}
	dir := filepath.Join(root, "class", "net", name)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if tun {
		if err := os.WriteFile(filepath.Join(dir, "tun_flags"), []byte("0x1002\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return root
}

func TestClearStaleTUNRemovesALeftoverTunDeviceOfOurName(t *testing.T) {
	var deleted []string
	err := clearStaleTUN(fakeSys(t, "nero0", true), "nero0", func(n string) error { deleted = append(deleted, n); return nil })
	if err != nil {
		t.Fatal(err)
	}
	if len(deleted) != 1 || deleted[0] != "nero0" {
		t.Errorf("deleted %v", deleted)
	}
}

func TestClearStaleTUNLeavesAnotherKindOfInterfaceAlone(t *testing.T) {
	err := clearStaleTUN(fakeSys(t, "nero0", false), "nero0", func(string) error {
		t.Error("an interface that is not a TUN device was deleted")
		return nil
	})
	if err == nil || !strings.Contains(err.Error(), "not a TUN") {
		t.Errorf("got %v", err)
	}
}

func TestClearStaleTUNDoesNothingWhenNothingIsThere(t *testing.T) {
	if err := clearStaleTUN(fakeSys(t, "", false), "nero0", func(string) error {
		t.Error("deleted something that is not there")
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

func TestClearStaleTUNReportsAFailedRemoval(t *testing.T) {
	boom := errors.New("busy")
	if err := clearStaleTUN(fakeSys(t, "nero0", true), "nero0", func(string) error { return boom }); !errors.Is(err, boom) {
		t.Errorf("got %v", err)
	}
}
