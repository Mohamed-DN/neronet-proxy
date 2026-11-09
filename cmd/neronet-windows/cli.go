package main

import (
	"errors"
	"fmt"
	"strings"
)

// usage lists every command. Kept platform-independent so it can be tested on any OS.
const usage = `Usage: neronet-windows <command>

Commands:
  import <profile.conf>  copy a NeroNet profile into %ProgramData%\NeroNet (run as Administrator)
  install                register the NeroNet Windows service (run as Administrator)
  uninstall              remove the NeroNet Windows service (run as Administrator)
  up                     start the service and bring the tunnel up
  down                   stop the service and bring the tunnel down
  status                 show the service state and the imported profile (no secrets)
  run                    run the tunnel in this console instead of as a service (debug)

Aliases: start = up, stop = down.`

// errUsage is returned when no command is given.
var errUsage = errors.New(usage)

// commandArity maps each command to the number of arguments it takes.
var commandArity = map[string]int{
	"import":    1,
	"install":   0,
	"uninstall": 0,
	"up":        0,
	"start":     0,
	"down":      0,
	"stop":      0,
	"status":    0,
	"run":       0,
}

// command is a parsed command line.
type command struct {
	name string
	args []string
}

// parseCommand validates the command line (args excludes the program name).
func parseCommand(args []string) (command, error) {
	if len(args) == 0 {
		return command{}, errUsage
	}
	name := strings.ToLower(args[0])
	want, ok := commandArity[name]
	if !ok {
		return command{}, fmt.Errorf("unknown command %q", args[0])
	}
	if got := len(args) - 1; got != want {
		return command{}, fmt.Errorf("%s takes %d argument(s), got %d", name, want, got)
	}
	return command{name: name, args: args[1:]}, nil
}
