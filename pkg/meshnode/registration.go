package meshnode

import (
	"regexp"
	"strconv"
	"strings"
)

// RegistrationError is a registration the control plane did not accept, as Start returns it when
// RequireRegistration is set. The control client reports a refusal as text ("... status 403: ..."), so
// the status and the console's reason are read from it here, once, for every caller.
type RegistrationError struct{ Err error }

func (e *RegistrationError) Error() string { return "registration failed: " + e.Err.Error() }
func (e *RegistrationError) Unwrap() error { return e.Err }

var statusText = regexp.MustCompile(`status (\d{3})(?:: (.*))?$`)

// Status is the HTTP status the control plane answered with, 0 if it did not answer.
func (e *RegistrationError) Status() int {
	m := statusText.FindStringSubmatch(e.Err.Error())
	if m == nil {
		return 0
	}
	n, _ := strconv.Atoi(m[1])
	return n
}

// Reason is the console's own words for the refusal, empty if there were none.
func (e *RegistrationError) Reason() string {
	m := statusText.FindStringSubmatch(e.Err.Error())
	if m == nil {
		return ""
	}
	return m[2]
}

// Refused is whether the control plane answered and said no (as opposed to not answering).
func (e *RegistrationError) Refused() bool {
	switch e.Status() {
	case 401, 403, 409:
		return true
	}
	return false
}

// Revoked is a refusal for good: the app or its key was removed. Retrying cannot change it.
func (e *RegistrationError) Revoked() bool {
	r := strings.ToLower(e.Reason())
	return e.Refused() && (strings.Contains(r, "has been revoked") || strings.Contains(r, "was removed"))
}

// Suspended is a refusal that a new approval of the same installation puts right.
func (e *RegistrationError) Suspended() bool {
	return e.Refused() && strings.Contains(strings.ToLower(e.Reason()), "must be approved again")
}
