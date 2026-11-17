package main

import (
	"errors"
	"fmt"
	"strings"
)

// upArgs is the parsed command line of `neronet up`.
type upArgs struct {
	ProfilePath string
	KillSwitch  bool
}

// parseUpArgs accepts --kill-switch before or after the profile path, and exactly one path.
// Go's flag package stops at the first positional argument, which would reject
// `neronet up profile.conf --kill-switch`, so the arguments are scanned by hand.
func parseUpArgs(args []string) (upArgs, error) {
	var ua upArgs
	var positional []string
	for _, a := range args {
		switch {
		case a == "--kill-switch":
			ua.KillSwitch = true
		case strings.HasPrefix(a, "-") && a != "-":
			return upArgs{}, fmt.Errorf("unknown flag %q", a)
		default:
			positional = append(positional, a)
		}
	}
	switch len(positional) {
	case 0:
		return upArgs{}, errors.New("missing profile path")
	case 1:
		ua.ProfilePath = positional[0]
		return ua, nil
	default:
		return upArgs{}, fmt.Errorf("want one profile path, got %d", len(positional))
	}
}
