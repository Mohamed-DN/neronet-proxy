package xrayconf

import (
	"encoding/json"
	"strings"
	"testing"
)

const (
	testPriv = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" // 43 base64url characters, not a real key
	uuidA    = "6f0f2a6e-1c5b-4f43-9a52-0b3c1d2e4f60"
	uuidB    = "0a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d"
)

func baseSpec() Spec {
	return Spec{
		ListenPort:  443,
		Dest:        "www.example.com:443",
		ServerNames: []string{"www.example.com"},
		PrivateKey:  testPriv,
		ShortIDs:    []string{"0123456789abcdef"},
		SocksHost:   "gateway",
		SocksPort:   1081,
		Clients: []Client{
			{DeviceID: "dev-b", UUID: uuidB, SocksPassword: "pw-b"},
			{DeviceID: "dev-a", UUID: uuidA, SocksPassword: "pw-a"},
		},
	}
}

func render(t *testing.T, s Spec) map[string]any {
	t.Helper()
	raw, err := Render(s)
	if err != nil {
		t.Fatal(err)
	}
	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("not JSON: %v", err)
	}
	return out
}

func TestEachUUIDRoutesToItsOwnSocksOutboundWithItsOwnCredentials(t *testing.T) {
	cfg := render(t, baseSpec())

	// uuid -> email (device id) on the inbound
	in := cfg["inbounds"].([]any)[0].(map[string]any)
	emailOf := map[string]string{}
	for _, c := range in["settings"].(map[string]any)["clients"].([]any) {
		m := c.(map[string]any)
		emailOf[m["id"].(string)] = m["email"].(string)
		if m["flow"] != "xtls-rprx-vision" {
			t.Errorf("client flow %v", m["flow"])
		}
	}
	if emailOf[uuidA] != "dev-a" || emailOf[uuidB] != "dev-b" {
		t.Fatalf("uuid to device mapping: %v", emailOf)
	}

	// outbound tag -> socks credentials
	creds := map[string][2]string{}
	for _, o := range cfg["outbounds"].([]any) {
		m := o.(map[string]any)
		if m["protocol"] != "socks" {
			continue
		}
		srv := m["settings"].(map[string]any)["servers"].([]any)[0].(map[string]any)
		u := srv["users"].([]any)[0].(map[string]any)
		creds[m["tag"].(string)] = [2]string{u["user"].(string), u["pass"].(string)}
		if srv["address"] != "gateway" || srv["port"].(float64) != 1081 {
			t.Errorf("socks target %v:%v", srv["address"], srv["port"])
		}
	}

	// routing: user -> outbound tag; the outbound's socks user must be the same device
	n := 0
	for _, r := range cfg["routing"].(map[string]any)["rules"].([]any) {
		m := r.(map[string]any)
		users, ok := m["user"].([]any)
		if !ok {
			continue
		}
		n++
		dev := users[0].(string)
		got := creds[m["outboundTag"].(string)]
		want := map[string]string{"dev-a": "pw-a", "dev-b": "pw-b"}[dev]
		if got[0] != dev || got[1] != want {
			t.Errorf("%s is routed to an outbound that authenticates as %v", dev, got)
		}
	}
	if n != 2 {
		t.Fatalf("%d per-device rules, want 2", n)
	}
}

func TestAnythingUnmatchedIsBlockedNotSentAnywhere(t *testing.T) {
	cfg := render(t, baseSpec())
	outs := cfg["outbounds"].([]any)
	if first := outs[0].(map[string]any); first["protocol"] != "blackhole" {
		t.Fatalf("the default (first) outbound is %v, want blackhole", first["protocol"])
	}
	for _, o := range outs {
		if p := o.(map[string]any)["protocol"]; p == "freedom" {
			t.Fatal("a freedom outbound would let a user out of the gateway's policy")
		}
	}
}

func TestRealityInboundCarriesTheOrganisationParameters(t *testing.T) {
	cfg := render(t, baseSpec())
	in := cfg["inbounds"].([]any)[0].(map[string]any)
	ss := in["streamSettings"].(map[string]any)
	if ss["security"] != "reality" || ss["network"] != "tcp" {
		t.Fatalf("stream settings %v", ss)
	}
	rs := ss["realitySettings"].(map[string]any)
	if rs["privateKey"] != testPriv || rs["dest"] != "www.example.com:443" {
		t.Fatalf("reality settings %v", rs)
	}
	if in["port"].(float64) != 443 {
		t.Fatal("port")
	}
}

func TestRenderIsDeterministicSoAnUnchangedNetmapDoesNotRestartXray(t *testing.T) {
	a, _ := Render(baseSpec())
	s := baseSpec()
	s.Clients[0], s.Clients[1] = s.Clients[1], s.Clients[0]
	b, _ := Render(s)
	if string(a) != string(b) {
		t.Fatal("client order changes the output")
	}
}

func TestRenderRefusesInvalidInput(t *testing.T) {
	mut := map[string]func(*Spec){
		"no private key":       func(s *Spec) { s.PrivateKey = "" },
		"short private key":    func(s *Spec) { s.PrivateKey = "abc" },
		"no server name":       func(s *Spec) { s.ServerNames = nil },
		"no short id":          func(s *Spec) { s.ShortIDs = nil },
		"odd short id":         func(s *Spec) { s.ShortIDs = []string{"abc"} },
		"non-hex short id":     func(s *Spec) { s.ShortIDs = []string{"zz"} },
		"dest without port":    func(s *Spec) { s.Dest = "www.example.com" },
		"bad uuid":             func(s *Spec) { s.Clients[0].UUID = "not-a-uuid" },
		"duplicate uuid":       func(s *Spec) { s.Clients[0].UUID = s.Clients[1].UUID },
		"duplicate device":     func(s *Spec) { s.Clients[0].DeviceID = s.Clients[1].DeviceID },
		"empty socks password": func(s *Spec) { s.Clients[0].SocksPassword = "" },
		"no socks host":        func(s *Spec) { s.SocksHost = "" },
		"zero port":            func(s *Spec) { s.ListenPort = 0 },
	}
	for name, f := range mut {
		s := baseSpec()
		f(&s)
		if _, err := Render(s); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

func TestErrorsNeverCarryTheSecrets(t *testing.T) {
	s := baseSpec()
	s.Clients[0].UUID = "bad"
	_, err := Render(s)
	if err == nil {
		t.Fatal("accepted")
	}
	for _, secret := range []string{testPriv, "pw-a", "pw-b"} {
		if strings.Contains(err.Error(), secret) {
			t.Fatalf("error leaks a secret: %v", err)
		}
	}
}
