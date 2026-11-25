package xrayconf

import (
	"strings"
	"testing"
)

func inbound(t *testing.T, s Spec) map[string]any {
	t.Helper()
	return render(t, s)["inbounds"].([]any)[0].(map[string]any)
}

func TestListenHostMovesTheSocketAndNothingElse(t *testing.T) {
	s := baseSpec()
	s.ListenHost = "127.0.0.1"
	s.ListenPort = 8445
	in := inbound(t, s)
	if in["listen"] != "127.0.0.1" || in["port"].(float64) != 8445 {
		t.Fatalf("listen %v port %v", in["listen"], in["port"])
	}
	if _, ok := in["streamSettings"].(map[string]any)["sockopt"]; ok {
		t.Fatal("sockopt present without PROXY protocol")
	}
}

func TestAcceptProxyProtocolOnLoopbackSetsSockopt(t *testing.T) {
	for _, host := range []string{"127.0.0.1", "::1"} {
		s := baseSpec()
		s.ListenHost = host
		s.AcceptProxyProtocol = true
		so := inbound(t, s)["streamSettings"].(map[string]any)["sockopt"].(map[string]any)
		if so["acceptProxyProtocol"] != true {
			t.Fatalf("%s: %v", host, so)
		}
	}
}

// PROXY protocol from a peer that can be reached from outside lets anyone claim any source
// address, and the per-IP limits then count the claimed one.
func TestAcceptProxyProtocolIsRefusedOffLoopback(t *testing.T) {
	for _, host := range []string{"", "0.0.0.0", "::", "192.0.2.10", "localhost", "example.com"} {
		s := baseSpec()
		s.ListenHost = host
		s.AcceptProxyProtocol = true
		if _, err := Render(s); err == nil {
			t.Errorf("host %q: PROXY protocol accepted off loopback", host)
		}
	}
}

func TestListenHostMustBeAnIPAddress(t *testing.T) {
	for _, host := range []string{"not a host", "127.0.0.1:80", "300.1.1.1", "[::1]"} {
		s := baseSpec()
		s.ListenHost = host
		_, err := Render(s)
		if err == nil {
			t.Errorf("host %q accepted", host)
		} else if strings.Contains(err.Error(), host) {
			t.Errorf("error repeats the value: %v", err)
		}
	}
}
