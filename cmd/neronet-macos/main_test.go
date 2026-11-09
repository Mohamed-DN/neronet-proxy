package main

import (
	"bytes"
	"strings"
	"testing"
)

func TestRunDispatch(t *testing.T) {
	var out bytes.Buffer
	if err := run([]string{"version"}, &out); err != nil || !strings.HasPrefix(out.String(), "neronet ") {
		t.Fatalf("version: %q %v", out.String(), err)
	}
	for _, args := range [][]string{{}, {"up"}, {"install-daemon"}, {"frobnicate"}} {
		out.Reset()
		if err := run(args, &out); err == nil {
			t.Errorf("run(%q) accepted bad usage", args)
		}
	}
	out.Reset()
	if err := run([]string{"help"}, &out); err != nil || !strings.Contains(out.String(), "install-daemon") {
		t.Fatalf("help: %v", err)
	}
}
