package profile

import (
	"encoding/base64"
	"encoding/hex"
	"strings"
	"testing"
)

// 32-byte keys, base64 as wg-quick writes them.
const (
	priv = "YHk3Hc9V+N4Gm5H1T0b6s0zQyVbS3l1v0X3eV4mY2Fk="
	pub  = "xTIBA5rboUvnH4htodjb6e697QjLERt1NAB4mZqp8Dg="
	psk  = "FpCyhws9cxwWoV4xELtfJvjJN+zQVRPISllRWgeopVE="
)

const sample = `# NeroNet-Profile: 1
# NeroNet-Console: https://console.example/me
# NeroNet-Device: dev-0123abcd
[Interface]
PrivateKey = ` + priv + `
Address = 100.64.12.34/32, fd7a:115c:a1e0::1234/128
DNS = 100.64.0.1

[Peer]
PublicKey = ` + pub + `
PresharedKey = ` + psk + `
Endpoint = gateway.example:51820
AllowedIPs = 100.64.0.0/10
PersistentKeepalive = 25
`

func TestParseReadsNeroNetMetadataAndWireGuardFields(t *testing.T) {
	p, err := Parse(strings.NewReader(sample))
	if err != nil {
		t.Fatal(err)
	}
	if p.Version != 1 || p.ConsoleURL != "https://console.example/me" || p.DeviceID != "dev-0123abcd" {
		t.Fatalf("metadata: %+v", p)
	}
	if len(p.Addresses) != 2 || p.Addresses[0].String() != "100.64.12.34/32" {
		t.Fatalf("addresses: %v", p.Addresses)
	}
	if len(p.DNS) != 1 || p.DNS[0].String() != "100.64.0.1" {
		t.Fatalf("dns: %v", p.DNS)
	}
	if len(p.Peers) != 1 {
		t.Fatalf("peers: %d", len(p.Peers))
	}
	peer := p.Peers[0]
	if peer.Endpoint != "gateway.example:51820" || peer.PersistentKeepalive != 25 || len(peer.AllowedIPs) != 1 {
		t.Fatalf("peer: %+v", peer)
	}
}

func TestPlainWireGuardFileIsAProfileWithoutMetadata(t *testing.T) {
	plain := strings.SplitN(sample, "[Interface]", 2)[1]
	p, err := Parse(strings.NewReader("[Interface]" + plain))
	if err != nil {
		t.Fatal(err)
	}
	if p.Version != 0 || p.ConsoleURL != "" {
		t.Fatalf("a plain file carries no NeroNet metadata: %+v", p)
	}
}

func TestUAPIUsesHexKeysAndReplacesPeers(t *testing.T) {
	p, err := Parse(strings.NewReader(sample))
	if err != nil {
		t.Fatal(err)
	}
	u := p.UAPI("198.51.100.7:51820")
	hexOf := func(b64 string) string {
		raw, _ := base64.StdEncoding.DecodeString(b64)
		return hex.EncodeToString(raw)
	}
	for _, want := range []string{
		"private_key=" + hexOf(priv) + "\n",
		"replace_peers=true\n",
		"public_key=" + hexOf(pub) + "\n",
		"preshared_key=" + hexOf(psk) + "\n",
		"endpoint=198.51.100.7:51820\n",
		"persistent_keepalive_interval=25\n",
		"replace_allowed_ips=true\n",
		"allowed_ip=100.64.0.0/10\n",
	} {
		if !strings.Contains(u, want) {
			t.Fatalf("UAPI lacks %q:\n%s", want, u)
		}
	}
	if strings.Contains(u, priv) {
		t.Fatal("UAPI must carry keys in hex, never the base64 text")
	}
}

func TestRejectsWhatWouldSilentlyMisbehave(t *testing.T) {
	cases := map[string]string{
		"bad private key":  strings.Replace(sample, priv, "notakey", 1),
		"short public key": strings.Replace(sample, pub, base64.StdEncoding.EncodeToString(make([]byte, 16)), 1),
		"no peer":          strings.SplitN(sample, "[Peer]", 2)[0],
		"bad address":      strings.Replace(sample, "100.64.12.34/32", "100.64.12.34/40", 1),
		"bad allowed ip":   strings.Replace(sample, "AllowedIPs = 100.64.0.0/10", "AllowedIPs = everything", 1),
		"bad keepalive":    strings.Replace(sample, "PersistentKeepalive = 25", "PersistentKeepalive = 70000", 1),
		"unknown key":      strings.Replace(sample, "DNS = 100.64.0.1", "DNS = 100.64.0.1\nPostUp = rm -rf /", 1),
		"newer version":    strings.Replace(sample, "NeroNet-Profile: 1", "NeroNet-Profile: 2", 1),
		"console not tls":  strings.Replace(sample, "https://console.example/me", "http://console.example/me", 1),
	}
	for name, text := range cases {
		if _, err := Parse(strings.NewReader(text)); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

func TestStringNeverPrintsThePrivateKey(t *testing.T) {
	p, err := Parse(strings.NewReader(sample))
	if err != nil {
		t.Fatal(err)
	}
	if s := p.String(); strings.Contains(s, priv) || strings.Contains(s, psk) {
		t.Fatalf("String leaks a secret: %s", s)
	}
}
