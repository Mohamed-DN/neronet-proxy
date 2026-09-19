package dataplane

import (
	"net/netip"
	"strings"
	"testing"
)

func mustAddr(s string) netip.Addr { return netip.MustParseAddr(s) }

const validSpikeDocument = `{
  "version": 3,
  "addresses": ["100.64.0.1/10"],
  "listen_port": 51820,
  "mtu": 1420,
  "echo_port": 9999,
  "probe_target": "100.64.0.2",
  "probe_interval_seconds": 5,
  "enforce": false,
  "peers": [
    {
      "public_key": "8f40c5adb68f25624ae5b214ea767a6ec94d829d3d7b5e1ad1ba6f3e2138285f",
      "endpoint": "10.89.0.3:51820",
      "allowed_ips": ["100.64.0.2/32"],
      "persistent_keepalive": 25
    }
  ]
}`

func TestParseSpikeConfig(t *testing.T) {
	cfg, err := ParseSpikeConfig([]byte(validSpikeDocument))
	if err != nil {
		t.Fatalf("a valid document was rejected: %v", err)
	}
	if cfg.Version != 3 {
		t.Fatalf("version = %d, want 3", cfg.Version)
	}
	if len(cfg.Addresses) != 1 || cfg.Addresses[0].String() != "100.64.0.1/10" {
		t.Fatalf("addresses = %v, want [100.64.0.1/10]", cfg.Addresses)
	}
	if cfg.EchoPort != 9999 || cfg.ProbeTarget != "100.64.0.2" || cfg.ProbeIntervalSeconds != 5 {
		t.Fatalf("spike instrumentation fields not read back: %+v", cfg)
	}
	if len(cfg.Peers) != 1 {
		t.Fatalf("peers = %d, want 1", len(cfg.Peers))
	}
	if cfg.Peers[0].AllowedIPs[0].String() != "100.64.0.2/32" {
		t.Fatalf("allowed IPs = %v", cfg.Peers[0].AllowedIPs)
	}
	if cfg.Peers[0].PersistentKeepalive != 25 {
		t.Fatalf("persistent keepalive = %d, want 25", cfg.Peers[0].PersistentKeepalive)
	}
	if cfg.Enforce {
		t.Fatal("enforce read back as true from a document that says false")
	}
}

func TestParseSpikeConfigRejectsBadDocuments(t *testing.T) {
	cases := map[string]string{
		"short public key": strings.Replace(validSpikeDocument,
			"8f40c5adb68f25624ae5b214ea767a6ec94d829d3d7b5e1ad1ba6f3e2138285f", "8f40c5ad", 1),
		"non hex public key": strings.Replace(validSpikeDocument,
			"8f40c5adb68f25624ae5b214ea767a6ec94d829d3d7b5e1ad1ba6f3e2138285f",
			"zzzzc5adb68f25624ae5b214ea767a6ec94d829d3d7b5e1ad1ba6f3e2138285f", 1),
		"no allowed IPs":     strings.Replace(validSpikeDocument, `["100.64.0.2/32"]`, `[]`, 1),
		"endpoint no port":   strings.Replace(validSpikeDocument, `"10.89.0.3:51820"`, `"10.89.0.3"`, 1),
		"probe not an addr":  strings.Replace(validSpikeDocument, `"100.64.0.2"`, `"not-an-address"`, 1),
		"unknown field":      strings.Replace(validSpikeDocument, `"version": 3,`, `"version": 3, "rotate_keys": true,`, 1),
		"not json":           "peers: []",
		"allowed IP garbage": strings.Replace(validSpikeDocument, `"100.64.0.2/32"`, `"100.64.0.2"`, 1),
	}

	for name, doc := range cases {
		if _, err := ParseSpikeConfig([]byte(doc)); err == nil {
			t.Errorf("%s: a document that cannot be applied was accepted", name)
		}
	}
}

func TestLoadSpikeConfigMissingFile(t *testing.T) {
	if _, err := LoadSpikeConfig(t.TempDir() + "/absent.json"); err == nil {
		t.Fatal("a missing spike document was accepted")
	}
}
