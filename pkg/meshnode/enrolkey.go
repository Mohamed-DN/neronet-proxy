package meshnode

import (
	"errors"
	"fmt"
	"log"
	"os"
	"runtime"
	"strings"
)

// Where a node's one-time pre-auth key comes from (ADR 0043).
//
// A gateway on a server the fleet token must never reach enrols with a pre-auth key issued
// for that one node. The key is a credential, so it should not sit in the process
// environment or a unit file: SOVEREIGN_ENROLMENT_KEY_FILE names a file that holds it,
// readable by the node's user only. The node reads it, and removes the file once the control
// plane has accepted the registration; a node that is already enrolled proves it holds its
// key and needs no file, so a missing file is not an error. The key is never logged and no
// error repeats it. SOVEREIGN_ENROLMENT_KEY, when set, wins and the file is left alone.

// enrolmentKeySource takes the two settings (SOVEREIGN_ENROLMENT_KEY and _FILE, read in env.go) and returns the pre-auth key (empty when there is none) and a function to
// call after a successful registration, which removes the key file if it was the source.
func enrolmentKeySource(envKey, filePath string) (string, func(), error) {
	nothing := func() {}
	if k := strings.TrimSpace(envKey); k != "" {
		return k, nothing, nil
	}
	path := strings.TrimSpace(filePath)
	if path == "" {
		return "", nothing, nil
	}
	fi, err := os.Stat(path)
	if errors.Is(err, os.ErrNotExist) {
		return "", nothing, nil // used already, or never needed
	}
	if err != nil {
		return "", nothing, fmt.Errorf("cannot read the enrolment key file: %v", errors.Unwrap(err))
	}
	if !fi.Mode().IsRegular() {
		return "", nothing, errors.New("the enrolment key file is not a regular file")
	}
	if runtime.GOOS != "windows" && fi.Mode().Perm()&0o077 != 0 {
		return "", nothing, errors.New("the enrolment key file must not be readable by group or others (chmod 600)")
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return "", nothing, errors.New("cannot read the enrolment key file")
	}
	key := strings.TrimSpace(string(raw))
	if key == "" {
		return "", nothing, errors.New("the enrolment key file is empty")
	}
	return key, func() {
		if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
			log.Printf("[SOVEREIGN-NODE] Warning: could not remove the used enrolment key file (remove it by hand)")
		}
	}, nil
}
