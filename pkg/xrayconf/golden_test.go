package xrayconf

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

// The default rendering is the one every installation already runs. A new option must
// leave it byte for byte as it was, or every gateway restarts Xray on upgrade.
func TestDefaultRenderingIsByteIdenticalToTheGolden(t *testing.T) {
	raw, err := Render(baseSpec())
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join("testdata", "default.golden.json")
	if os.Getenv("UPDATE_GOLDEN") == "1" {
		if err := os.WriteFile(path, raw, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(raw, want) {
		t.Fatalf("default rendering changed:\n%s", raw)
	}
}
