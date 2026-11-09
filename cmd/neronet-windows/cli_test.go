package main

import (
	"errors"
	"testing"
)

func TestParseCommandAcceptsKnownCommands(t *testing.T) {
	cases := []struct {
		args []string
		name string
		n    int
	}{
		{[]string{"import", `C:\Users\me\laptop.conf`}, "import", 1},
		{[]string{"install"}, "install", 0},
		{[]string{"UP"}, "up", 0},
		{[]string{"down"}, "down", 0},
		{[]string{"status"}, "status", 0},
		{[]string{"stop"}, "stop", 0},
	}
	for _, c := range cases {
		cmd, err := parseCommand(c.args)
		if err != nil {
			t.Fatalf("%v: %v", c.args, err)
		}
		if cmd.name != c.name || len(cmd.args) != c.n {
			t.Fatalf("%v: got %+v", c.args, cmd)
		}
	}
}

func TestParseCommandRejectsBadInput(t *testing.T) {
	if _, err := parseCommand(nil); !errors.Is(err, errUsage) {
		t.Fatalf("no args: want usage error, got %v", err)
	}
	if _, err := parseCommand([]string{"connect"}); err == nil {
		t.Fatal("unknown command accepted")
	}
	if _, err := parseCommand([]string{"import"}); err == nil {
		t.Fatal("import without a path accepted")
	}
	if _, err := parseCommand([]string{"up", "extra"}); err == nil {
		t.Fatal("up with an argument accepted")
	}
}
