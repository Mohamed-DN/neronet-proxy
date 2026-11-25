package meshnode

import (
	"encoding/json"
	"os"
	"strings"
	"testing"

	"github.com/sovereign/proxy/v4/pkg/control"
)

func TestParseVlessListen(t *testing.T) {
	good := []struct {
		listen string
		proxy  bool
		want   vlessListen
	}{
		{"", false, vlessListen{}},
		{"127.0.0.1:8445", false, vlessListen{Host: "127.0.0.1", Port: 8445}},
		{"[::1]:8445", true, vlessListen{Host: "::1", Port: 8445, AcceptProxy: true}},
		{"127.0.0.1:8445", true, vlessListen{Host: "127.0.0.1", Port: 8445, AcceptProxy: true}},
		{"0.0.0.0:443", false, vlessListen{Host: "0.0.0.0", Port: 443}},
	}
	for _, c := range good {
		got, err := parseVlessListen(c.listen, c.proxy)
		if err != nil || got != c.want {
			t.Errorf("%q proxy=%v: got %+v err %v", c.listen, c.proxy, got, err)
		}
	}
	bad := []struct {
		listen string
		proxy  bool
	}{
		{"8445", false}, {":8445", false}, {"localhost:8445", false}, {"127.0.0.1:0", false},
		{"127.0.0.1:70000", false}, {"127.0.0.1:x", false}, {"127.0.0.1:", false},
		{"", true},               // PROXY protocol with no explicit loopback listen
		{"0.0.0.0:8445", true},   // spoofable
		{"192.0.2.1:8445", true}, // spoofable
	}
	for _, c := range bad {
		if _, err := parseVlessListen(c.listen, c.proxy); err == nil {
			t.Errorf("%q proxy=%v accepted", c.listen, c.proxy)
		}
	}
}

func TestVlessListenErrorsDoNotRepeatTheValue(t *testing.T) {
	_, err := parseVlessListen("secret-host:1", false)
	if err == nil || strings.Contains(err.Error(), "secret-host") {
		t.Fatalf("error %v", err)
	}
}

func TestSetVLESSListenRefusesABadSettingAndKeepsTheOldOne(t *testing.T) {
	m := &netmapManager{}
	if err := m.SetVLESSListen("127.0.0.1:8445", true); err != nil {
		t.Fatal(err)
	}
	if err := m.SetVLESSListen("0.0.0.0:8445", true); err == nil {
		t.Fatal("PROXY protocol accepted off loopback")
	}
	if m.vless.listen != (vlessListen{Host: "127.0.0.1", Port: 8445, AcceptProxy: true}) {
		t.Fatalf("a refused setting replaced the good one: %+v", m.vless.listen)
	}
}

func TestListenOverridesTheSocketNotTheReportedPort(t *testing.T) {
	r := newVlessRig(t)
	r.m.vless.listen = vlessListen{Host: "127.0.0.1", Port: 8445, AcceptProxy: true}
	r.m.reconcileVLESS(vlessDoc(reality(), vlessPeer("dev-a", vlessUUID1, "100.64.0.3", hex64("a"))), nil)
	raw, err := os.ReadFile(r.cfgPath)
	if err != nil {
		t.Fatal(err)
	}
	var cfg struct {
		Inbounds []struct {
			Listen         string
			Port           int
			StreamSettings struct {
				Sockopt struct{ AcceptProxyProtocol bool }
			}
		}
	}
	if err := json.Unmarshal(raw, &cfg); err != nil {
		t.Fatal(err)
	}
	in := cfg.Inbounds[0]
	if in.Listen != "127.0.0.1" || in.Port != 8445 || !in.StreamSettings.Sockopt.AcceptProxyProtocol {
		t.Fatalf("inbound %+v", in)
	}
	// the port the console is told stays the public one
	if got := withVless(control.CapabilityDesc{}, vlessAdvertisedPort(443, "127.0.0.1:1081", "127.0.0.1:1081", "/x")); got.VlessPort != 443 {
		t.Fatalf("reported port %d", got.VlessPort)
	}
}

func TestWithoutListenTheConfigIsTheOneEveryGatewayHas(t *testing.T) {
	r := newVlessRig(t)
	r.m.reconcileVLESS(vlessDoc(reality(), vlessPeer("dev-a", vlessUUID1, "100.64.0.3", hex64("a"))), nil)
	raw, _ := os.ReadFile(r.cfgPath)
	if !strings.Contains(string(raw), `"listen": "0.0.0.0"`) || !strings.Contains(string(raw), `"port": 443`) || strings.Contains(string(raw), "sockopt") {
		t.Fatalf("default changed:\n%s", raw)
	}
}
