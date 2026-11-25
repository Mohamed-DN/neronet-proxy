//go:build rgwit

package remotegw

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"fmt"
	"io"
	"math/big"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"golang.org/x/net/proxy"

	"github.com/sovereign/proxy/v4/pkg/bridge"
	"github.com/sovereign/proxy/v4/pkg/xrayconf"
)

// ADR 0043. One container, everything real: an nginx stream router in front of two Xray REALITY
// servers, one standing for the service that already owns TCP 443 (its own key, its own name) and
// one rendered by pkg/xrayconf as the NeroNet gateway would render it (loopback, optionally with
// PROXY protocol), two real Xray clients, and the real neronet-443-swap script. See
// scripts/dev/test-remote-gateway.sh.
//
// Needs root (it binds 443), XRAY_BIN, nginx with the stream module, openssl, and
// SWAP_SCRIPT (packaging/gateway/bin/neronet-443-swap).

const (
	oldSNI     = "old.example.test"
	neroSNI    = "nero.example.test"
	wrongSNI   = "other.example.test"
	oldUUID    = "0a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d"
	neroUUID   = "6f0f2a6e-1c5b-4f43-9a52-0b3c1d2e4f60"
	strangerID = "11111111-2222-4333-8444-555555555555"
	shortID    = "0123456789abcdef"
	oldBackend = "127.0.0.1:8444"
	neroListen = "127.0.0.1:8445"
)

func need(t *testing.T, name string) string {
	t.Helper()
	v := os.Getenv(name)
	if v == "" {
		t.Skipf("%s is not set", name)
	}
	return v
}

func freePort(t *testing.T) int {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port
}

func publicAddr(t *testing.T) string {
	t.Helper()
	addrs, _ := net.InterfaceAddrs()
	for _, a := range addrs {
		if ip, ok := a.(*net.IPNet); ok && ip.IP.To4() != nil && !ip.IP.IsLoopback() {
			return ip.IP.String()
		}
	}
	t.Skip("no non-loopback IPv4 address")
	return ""
}

func x25519(t *testing.T, bin string) (priv, pub string) {
	t.Helper()
	out, err := exec.Command(bin, "x25519").CombinedOutput()
	if err != nil {
		t.Fatalf("xray x25519: %v", err)
	}
	for _, line := range strings.Split(string(out), "\n") {
		k, v, ok := strings.Cut(strings.TrimSpace(line), ":")
		if !ok {
			continue
		}
		switch {
		case k == "PrivateKey":
			priv = strings.TrimSpace(v)
		case strings.HasPrefix(k, "Password") || strings.HasPrefix(k, "PublicKey"):
			pub = strings.TrimSpace(v)
		}
	}
	if priv == "" || pub == "" {
		t.Fatal("could not read the key pair from xray x25519 output")
	}
	return
}

// fingerprint formats a certificate like `openssl x509 -fingerprint -sha256`.
func fingerprint(der []byte) string {
	sum := sha256.Sum256(der)
	parts := make([]string, len(sum))
	for i, b := range sum {
		parts[i] = fmt.Sprintf("%02X", b)
	}
	return strings.Join(parts, ":")
}

// coverSite is a TLS 1.3 site with its own certificate: what REALITY shows to anyone who cannot
// authenticate. Returns its address and the certificate's fingerprint.
func coverSite(t *testing.T, cn string) (addr, fp string) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(time.Now().UnixNano()), Subject: pkix.Name{CommonName: cn},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(24 * time.Hour),
		DNSNames: []string{cn}, KeyUsage: x509.KeyUsageDigitalSignature,
		ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	l, err := tls.Listen("tcp", "127.0.0.1:0", &tls.Config{
		Certificates: []tls.Certificate{{Certificate: [][]byte{der}, PrivateKey: key}},
		MinVersion:   tls.VersionTLS13,
	})
	if err != nil {
		t.Fatal(err)
	}
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("cover " + cn)) })}
	go func() { _ = srv.Serve(l) }()
	t.Cleanup(func() { _ = srv.Close() })
	return l.Addr().String(), fingerprint(der)
}

// echo answers every connection with tag+data: it shows which service a client really reached.
func echo(t *testing.T, tag string) string {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = l.Close() })
	go func() {
		for {
			c, err := l.Accept()
			if err != nil {
				return
			}
			go func() {
				defer c.Close()
				buf := make([]byte, 7)
				if _, err := io.ReadFull(c, buf); err == nil {
					_, _ = c.Write(append([]byte(tag), buf...))
				}
			}()
		}
	}()
	return l.Addr().String()
}

type fixedDialer struct{ to string }

func (d fixedDialer) DialContext(ctx context.Context, network, _ string) (net.Conn, error) {
	var nd net.Dialer
	return nd.DialContext(ctx, network, d.to)
}

type proc struct{ cmd *exec.Cmd }

func startXray(t *testing.T, bin, dir, name string, cfg []byte) *proc {
	t.Helper()
	path := filepath.Join(dir, name+".json")
	if err := os.WriteFile(path, cfg, 0o600); err != nil {
		t.Fatal(err)
	}
	logf, _ := os.Create(filepath.Join(dir, name+".log"))
	cmd := exec.Command(bin, "run", "-c", path)
	cmd.Stdout, cmd.Stderr = logf, logf
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	p := &proc{cmd: cmd}
	t.Cleanup(p.stop)
	time.Sleep(700 * time.Millisecond)
	return p
}

func (p *proc) stop() {
	if p.cmd.Process != nil {
		_ = p.cmd.Process.Kill()
		_, _ = p.cmd.Process.Wait()
	}
}

func clientConfig(socksPort int, server, uuid, pub, sni string) []byte {
	cfg := map[string]any{
		"log": map[string]any{"loglevel": "warning"},
		"inbounds": []any{map[string]any{
			"listen": "127.0.0.1", "port": socksPort, "protocol": "socks",
			"settings": map[string]any{"auth": "noauth"},
		}},
		"outbounds": []any{map[string]any{
			"protocol": "vless",
			"settings": map[string]any{"vnext": []any{map[string]any{
				"address": server, "port": 443,
				"users": []any{map[string]any{"id": uuid, "encryption": "none", "flow": "xtls-rprx-vision"}},
			}}},
			"streamSettings": map[string]any{
				"network": "tcp", "security": "reality",
				"realitySettings": map[string]any{"serverName": sni, "fingerprint": "chrome", "publicKey": pub, "shortId": shortID},
			},
		}},
	}
	b, _ := json.Marshal(cfg)
	return b
}

// roundTrip sends 7 bytes through an Xray client's SOCKS inbound and returns the reply.
func roundTrip(socksPort int, total time.Duration) (string, error) {
	d, err := proxy.SOCKS5("tcp", fmt.Sprintf("127.0.0.1:%d", socksPort), nil, &net.Dialer{Timeout: total})
	if err != nil {
		return "", err
	}
	type res struct {
		s   string
		err error
	}
	ch := make(chan res, 1)
	go func() {
		c, err := d.Dial("tcp", "10.99.0.1:9999")
		if err != nil {
			ch <- res{"", err}
			return
		}
		defer c.Close()
		_ = c.SetDeadline(time.Now().Add(total))
		if _, err := c.Write([]byte("reality")); err != nil {
			ch <- res{"", err}
			return
		}
		b := make([]byte, 16)
		n, err := io.ReadAtLeast(c, b, 11)
		ch <- res{string(b[:n]), err}
	}()
	select {
	case r := <-ch:
		return r.s, r.err
	case <-time.After(total + time.Second):
		return "", fmt.Errorf("no answer within %s", total)
	}
}

func expect(t *testing.T, socks int, want string) {
	t.Helper()
	var got string
	var err error
	for i := 0; i < 5; i++ {
		if got, err = roundTrip(socks, 6*time.Second); err == nil && got == want+"reality" {
			return
		}
		time.Sleep(300 * time.Millisecond)
	}
	t.Fatalf("want a reply from %q, got %q (err %v)", want, got, err)
}

func refused(t *testing.T, socks int) {
	t.Helper()
	if got, err := roundTrip(socks, 5*time.Second); err == nil {
		t.Fatalf("a client that must be refused got %q", got)
	}
}

// tlsFingerprint does a plain TLS 1.3 handshake with sni and returns the certificate seen.
func tlsFingerprint(addr, sni string) (string, error) {
	d := &net.Dialer{Timeout: 4 * time.Second}
	c, err := tls.DialWithDialer(d, "tcp", addr, &tls.Config{ServerName: sni, InsecureSkipVerify: true, MinVersion: tls.VersionTLS13}) //nolint:gosec // a probe of a test rig
	if err != nil {
		return "", err
	}
	defer c.Close()
	return fingerprint(c.ConnectionState().PeerCertificates[0].Raw), nil
}

type swapRig struct {
	t      *testing.T
	script string
	conf   string
	dir    string
	public string
}

func (r *swapRig) run(args ...string) (string, int) {
	r.t.Helper()
	cmd := exec.Command("bash", append([]string{r.script, "--conf", r.conf}, args...)...)
	var buf bytes.Buffer
	cmd.Stdout, cmd.Stderr = &buf, &buf
	err := cmd.Run()
	code := 0
	if ee, ok := err.(*exec.ExitError); ok {
		code = ee.ExitCode()
	} else if err != nil {
		r.t.Fatal(err)
	}
	r.t.Logf("neronet-443-swap %s -> exit %d\n%s", strings.Join(args, " "), code, buf.String())
	return buf.String(), code
}

func routerRunning(dir string) bool {
	b, err := os.ReadFile(filepath.Join(dir, "router.pid"))
	if err != nil {
		return false
	}
	return exec.Command("kill", "-0", strings.TrimSpace(string(b))).Run() == nil
}

func TestSNIRouterSharesPort443WithAnExistingREALITYService(t *testing.T) {
	bin := need(t, "XRAY_BIN")
	script := need(t, "SWAP_SCRIPT")
	if os.Geteuid() != 0 {
		t.Skip("binds 443: run as root in the container")
	}
	dir := t.TempDir()
	public := publicAddr(t)
	t.Cleanup(func() {
		if !t.Failed() {
			return
		}
		logs, _ := filepath.Glob(filepath.Join(dir, "*.log"))
		for _, l := range logs {
			b, _ := os.ReadFile(l)
			t.Logf("--- %s\n%s", filepath.Base(l), b)
		}
	})

	oldCover, oldCoverFP := coverSite(t, "cover-old")
	neroCover, neroCoverFP := coverSite(t, "cover-nero")
	oldPriv, oldPub := x25519(t, bin)
	neroPriv, neroPub := x25519(t, bin)

	// --- the service that already owns 443: a REALITY server with its own key and name ---
	oldEcho := echo(t, "old:")
	neroEcho := echo(t, "nero:")
	// Both Xray servers reach their "service" through a SOCKS5 stub (Xray's freedom outbound
	// refuses loopback targets): the existing service as device "old", the gateway as "dev-1".
	reg := bridge.NewDeviceSOCKS()
	reg.Replace(map[string]bridge.DeviceEntry{
		"dev-1": {Password: "per-device-secret", Dialer: fixedDialer{neroEcho}},
		"old":   {Password: "old-secret", Dialer: fixedDialer{oldEcho}},
	})
	socks := bridge.NewSOCKS5Server("127.0.0.1:0", nil)
	socks.SetDeviceAuth(reg.Authenticate)
	if err := socks.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = socks.Close() })
	oldCfg := func(withPublic bool) []byte {
		in := func(listen string, port int) map[string]any {
			return map[string]any{
				"listen": listen, "port": port, "protocol": "vless",
				"settings": map[string]any{"decryption": "none", "clients": []any{map[string]any{"id": oldUUID, "flow": "xtls-rprx-vision"}}},
				"streamSettings": map[string]any{"network": "tcp", "security": "reality", "realitySettings": map[string]any{
					"dest": oldCover, "serverNames": []string{oldSNI}, "privateKey": oldPriv, "shortIds": []string{shortID}}},
			}
		}
		inbounds := []any{in("127.0.0.1", 8444)}
		if withPublic {
			inbounds = append([]any{in("0.0.0.0", 443)}, inbounds...)
		}
		b, _ := json.Marshal(map[string]any{
			"log":      map[string]any{"loglevel": "warning"},
			"inbounds": inbounds,
			"outbounds": []any{map[string]any{"protocol": "socks", "settings": map[string]any{"servers": []any{map[string]any{
				"address": "127.0.0.1", "port": socks.Addr().(*net.TCPAddr).Port,
				"users": []any{map[string]any{"user": "old", "pass": "old-secret"}}}}}}},
		})
		return b
	}
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	must(os.WriteFile(filepath.Join(dir, "old-public.json"), oldCfg(true), 0o600))
	must(os.WriteFile(filepath.Join(dir, "old-loopback.json"), oldCfg(false), 0o600))
	oldSh := filepath.Join(dir, "old.sh")
	must(os.WriteFile(oldSh, []byte(fmt.Sprintf(`#!/bin/sh
# start-public | start-loopback: (re)start the existing service, as an operator's reload would.
pidf=%[1]s/old.pid
[ -f "$pidf" ] && kill "$(cat "$pidf")" 2>/dev/null
[ -f "$pidf" ] && while kill -0 "$(cat "$pidf")" 2>/dev/null; do sleep 0.01; done
case "$1" in
start-public) cfg=%[1]s/old-public.json ;;
start-loopback) cfg=%[1]s/old-loopback.json ;;
esac
nohup %[2]s run -c "$cfg" >>%[1]s/old.log 2>&1 &
echo $! >"$pidf"
`, dir, bin)), 0o755))
	must(exec.Command("sh", oldSh, "start-public").Run())
	t.Cleanup(func() {
		if b, err := os.ReadFile(filepath.Join(dir, "old.pid")); err == nil {
			_ = exec.Command("kill", strings.TrimSpace(string(b))).Run()
		}
	})
	time.Sleep(900 * time.Millisecond)

	// --- the gateway: rendered by xrayconf, behind the router ---
	renderNero := func(proxyProto bool) []byte {
		cfg, err := xrayconf.Render(xrayconf.Spec{
			ListenHost: "127.0.0.1", ListenPort: 8445, AcceptProxyProtocol: proxyProto,
			Dest: neroCover, ServerNames: []string{neroSNI}, PrivateKey: neroPriv, ShortIDs: []string{shortID},
			SocksHost: "127.0.0.1", SocksPort: uint16(socks.Addr().(*net.TCPAddr).Port),
			Clients: []xrayconf.Client{{DeviceID: "dev-1", UUID: neroUUID, SocksPassword: "per-device-secret"}},
		})
		must(err)
		return cfg
	}
	nero := startXray(t, bin, dir, "nero", renderNero(false))

	// --- clients ---
	client := func(name, uuid, pub, sni string) int {
		p := freePort(t)
		startXray(t, bin, dir, name, clientConfig(p, public, uuid, pub, sni))
		return p
	}
	oldClient := client("c-old", oldUUID, oldPub, oldSNI)
	neroClient := client("c-nero", neroUUID, neroPub, neroSNI)
	wrongSNIClient := client("c-wrongsni", neroUUID, neroPub, wrongSNI)
	strangerClient := client("c-stranger", strangerID, neroPub, neroSNI)

	rig := &swapRig{t: t, script: script, dir: dir, public: public, conf: filepath.Join(dir, "swap.conf")}
	routerConf := filepath.Join(dir, "router.conf")
	writeConf := func(proxyProto bool, deadline int) {
		pp := "no"
		if proxyProto {
			pp = "yes"
		}
		must(os.WriteFile(rig.conf, []byte(fmt.Sprintf(`NERONET_SNI=%s
OTHER_SNI=%s
OTHER_BACKEND=%s
NERONET_BACKEND=%s
PUBLIC_ADDR=%s
NERONET_PROXY_PROTOCOL=%s
LISTEN_ADDRS="0.0.0.0:443"
ROUTER_CONF=%s
ROUTER_PID=%s/router.pid
STATE_FILE=%s/state
PROBE_DEADLINE=%d
RELEASE_CMD="sh %s start-loopback"
RESTORE_CMD="sh %s start-public"
ROUTER_START_CMD="nginx -c %s >/dev/null 2>&1"
ROUTER_STOP_CMD="[ -f %s/router.pid ] && kill -TERM \$(cat %s/router.pid); while [ -f %s/router.pid ] && kill -0 \$(cat %s/router.pid) 2>/dev/null; do sleep 0.01; done; true"
`, neroSNI, oldSNI, oldBackend, neroListen, public, pp, routerConf, dir, dir, deadline, oldSh, oldSh, routerConf, dir, dir, dir, dir)), 0o644))
	}
	writeConf(false, 20)

	// ---- before: only the existing service is on 443 ----
	expect(t, oldClient, "old:")
	refused(t, neroClient)

	// ---- plan and the dry run change nothing ----
	if out, code := rig.run("plan"); code != 0 || !strings.Contains(out, "plan: ready") {
		t.Fatalf("plan exit %d", code)
	}
	if out, code := rig.run("apply"); code != 0 || !strings.Contains(out, "dry run: nothing changed") {
		t.Fatalf("dry-run apply exit %d", code)
	}
	if routerRunning(dir) {
		t.Fatal("the dry run started the router")
	}
	expect(t, oldClient, "old:")

	// ---- apply, with the existing service under load the whole time ----
	type sample struct {
		at time.Time
		ok bool
	}
	var mu sync.Mutex
	var samples []sample
	stopLoad := make(chan struct{})
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			select {
			case <-stopLoad:
				return
			default:
			}
			got, err := roundTrip(oldClient, 3*time.Second)
			mu.Lock()
			samples = append(samples, sample{time.Now(), err == nil && got == "old:reality"})
			mu.Unlock()
			time.Sleep(20 * time.Millisecond)
		}
	}()
	time.Sleep(1200 * time.Millisecond)
	out, code := rig.run("apply", "--yes")
	if code != 0 {
		t.Fatalf("apply --yes exit %d", code)
	}
	time.Sleep(1500 * time.Millisecond)
	close(stopLoad)
	wg.Wait()

	// The existing service's gap: the longest stretch between two successful round trips
	// that contains a failure, taken from the client's side.
	var worst time.Duration
	var prevOK time.Time
	failures := 0
	mu.Lock()
	for _, s := range samples {
		if s.ok {
			if !prevOK.IsZero() {
				if d := s.at.Sub(prevOK); d > worst {
					worst = d
				}
			}
			prevOK = s.at
		} else {
			failures++
		}
	}
	n := len(samples)
	endOK := len(samples) > 0 && samples[len(samples)-1].ok
	mu.Unlock()
	t.Logf("MEASURED existing service during the swap: %d round trips, %d failed, longest silence between two successes %v (script: %s)",
		n, failures, worst.Round(time.Millisecond), firstLine(out, "accepted connections again"))
	if !endOK {
		t.Fatal("the existing service was not answering after the swap")
	}
	if worst > 5*time.Second {
		t.Fatalf("the existing service was silent for %v", worst)
	}

	// ---- after: both services answer through 443 ----
	expect(t, oldClient, "old:")
	expect(t, neroClient, "nero:")

	// A client with the wrong name, or an unknown uuid, is refused ...
	refused(t, wrongSNIClient)
	refused(t, strangerClient)
	// ... and the answer to anyone who cannot authenticate is the cover site, not an error:
	// the right name without REALITY credentials shows the certificate of the NeroNet cover
	// site; an unowned name shows the existing service's cover site.
	if fp, err := tlsFingerprint(public+":443", neroSNI); err != nil || fp != neroCoverFP {
		t.Fatalf("NeroNet name without credentials: fp %s err %v, want the cover site's %s", fp, err, neroCoverFP)
	}
	if fp, err := tlsFingerprint(public+":443", wrongSNI); err != nil || fp != oldCoverFP {
		t.Fatalf("an unowned name: fp %s err %v, want the existing service's cover %s", fp, err, oldCoverFP)
	}

	// ---- rollback restores the existing service alone ----
	if _, code := rig.run("rollback"); code != 0 {
		t.Fatalf("rollback exit %d", code)
	}
	if routerRunning(dir) {
		t.Fatal("the router is still running after rollback")
	}
	expect(t, oldClient, "old:")
	refused(t, neroClient)

	// ---- a swap whose probe fails rolls itself back ----
	nero.stop()
	writeConf(false, 4)
	// With the gateway down the preflight refuses and nothing changes ...
	if _, code := rig.run("apply", "--yes"); code == 0 {
		t.Fatal("apply went ahead with the gateway down")
	}
	expect(t, oldClient, "old:")
	// ... and when the gateway dies after the preflight, the probe fails and the swap undoes itself.
	nero = startXray(t, bin, dir, "nero", renderNero(false))
	killer := exec.Command("sh", "-c", "sleep 3; kill -9 "+fmt.Sprint(nero.cmd.Process.Pid)) // after RELEASE_CMD, before the probes
	// RELEASE_CMD is slowed so that the kill lands inside the swap.
	must(os.WriteFile(oldSh+".slow", []byte("sleep 5; sh "+oldSh+" start-loopback\n"), 0o755))
	must(os.WriteFile(rig.conf, append(mustRead(t, rig.conf), []byte("RELEASE_CMD=\"sh "+oldSh+".slow\"\n")...), 0o644))
	must(killer.Start())
	_, code = rig.run("apply", "--yes")
	_ = killer.Wait()
	if code != 2 {
		t.Fatalf("a failed probe must end with exit 2 and a rollback, got %d", code)
	}
	if routerRunning(dir) {
		t.Fatal("the router survived the automatic rollback")
	}
	expect(t, oldClient, "old:")

	// ---- PROXY protocol towards the gateway ----
	nero = startXray(t, bin, dir, "nero", renderNero(true))
	writeConf(true, 20)
	// Xray with acceptProxyProtocol refuses a connection that has no header.
	if fp, err := tlsFingerprint(neroListen, neroSNI); err == nil {
		t.Fatalf("Xray answered a connection without a PROXY header (cert %s)", fp)
	}
	if _, code := rig.run("apply", "--yes"); code != 0 {
		t.Fatalf("apply with PROXY protocol exit %d", code)
	}
	expect(t, neroClient, "nero:")
	expect(t, oldClient, "old:")
	if _, code := rig.run("rollback"); code != 0 {
		t.Fatalf("rollback exit %d", code)
	}
	expect(t, oldClient, "old:")
	_ = nero
}

func firstLine(s, contains string) string {
	for _, l := range strings.Split(s, "\n") {
		if strings.Contains(l, contains) {
			return strings.TrimSpace(l)
		}
	}
	return "-"
}

func mustRead(t *testing.T, p string) []byte {
	t.Helper()
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	return b
}
