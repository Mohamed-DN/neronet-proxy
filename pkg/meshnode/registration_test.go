package meshnode

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/sovereign/proxy/v4/pkg/crypto"
)

func regErr(text string) *RegistrationError { return &RegistrationError{Err: errors.New(text)} }

func TestRegistrationErrorReadsTheConsolesAnswer(t *testing.T) {
	cases := []struct {
		text                        string
		status                      int
		refused, revoked, suspended bool
	}{
		{"control plane refused registration: status 403: this key has been revoked", 403, true, true, false},
		{"control plane refused registration: status 403: this app was removed", 403, true, true, false},
		{"control plane refused registration: status 403: this app must be approved again", 403, true, false, true},
		{"control plane refused registration: status 401: invalid pre-auth key", 401, true, false, false},
		{"control plane refused registration: status 503", 503, false, false, false},
		{"control plane register failed: dial tcp: connection refused", 0, false, false, false},
	}
	for _, c := range cases {
		e := regErr(c.text)
		if e.Status() != c.status || e.Refused() != c.refused || e.Revoked() != c.revoked || e.Suspended() != c.suspended {
			t.Errorf("%q: status %d refused %v revoked %v suspended %v", c.text, e.Status(), e.Refused(), e.Revoked(), e.Suspended())
		}
	}
}

// The app keeps its key in the system key store: a key handed to Start is used, and no key file is read or
// made at IdentityPath.
func TestStartUsesTheKeyItIsGivenAndMakesNoKeyFile(t *testing.T) {
	kp, err := crypto.GenerateKeypair()
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "identity.key")
	_, err = Start(context.Background(), Params{
		Keypair:      kp,
		IdentityPath: path,
		ControlURL:   "http://127.0.0.1:1",
		CountryCode:  "not-a-country",
	})
	if err == nil || !strings.Contains(err.Error(), "Invalid -country") {
		t.Fatalf("got %v", err)
	}
	if _, serr := os.Stat(path); serr == nil {
		t.Error("a key file was written although the key was handed over")
	}
}

func TestEveryNodeHasItsOwnMetrics(t *testing.T) {
	a, b := newNodeMetrics(), newNodeMetrics()
	if a == b || a == globalNodeMetrics {
		t.Fatal("collectors are shared")
	}
	a.RecordHeartbeat(10*time.Millisecond, true, false)
	if a.heartbeatsSent != 1 || b.heartbeatsSent != 0 {
		t.Errorf("one node's heartbeat was counted elsewhere: %d %d", a.heartbeatsSent, b.heartbeatsSent)
	}
}
