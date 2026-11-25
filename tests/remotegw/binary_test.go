//go:build rgwit

package remotegw

import (
	"bytes"
	"crypto/ecdh"
	"crypto/rand"
	"crypto/tls"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/sovereign/proxy/v4/pkg/control"
)

// The real sovereign-node binary against a stub control plane, with the environment a systemd
// unit of the neronet-gateway package sets. The point: a setting that is read and advertised but
// never reaches the code that uses it (which is how VLESS once shipped, ADR 0036) cannot pass
// here, because nothing below the process boundary is faked on the node's side.

type stubControl struct {
	srv      *httptest.Server
	mu       sync.Mutex
	register []control.RegisterRequest
	auth     []string
	vless    *control.VlessConfig
	peer     control.NetmapPeer
}

func newStubControl(t *testing.T, tlsOn bool, vless *control.VlessConfig, peer control.NetmapPeer) *stubControl {
	t.Helper()
	priv, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	s := &stubControl{vless: vless, peer: peer}
	write := func(w http.ResponseWriter, v any) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(v)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/v4/control/challenge", func(w http.ResponseWriter, _ *http.Request) {
		nonce := make([]byte, 16)
		_, _ = rand.Read(nonce)
		write(w, control.ChallengeResponse{
			Nonce: hex.EncodeToString(nonce), ControlPlanePubHex: hex.EncodeToString(priv.PublicKey().Bytes()),
			ExpiresAt: time.Now().Add(time.Minute).UTC().Format(time.RFC3339),
		})
	})
	mux.HandleFunc("/v4/control/register", func(w http.ResponseWriter, r *http.Request) {
		var req control.RegisterRequest
		_ = json.NewDecoder(r.Body).Decode(&req)
		s.mu.Lock()
		s.register = append(s.register, req)
		s.auth = append(s.auth, r.Header.Get("Authorization"))
		s.mu.Unlock()
		write(w, control.RegisterResponse{
			AssignedNodeID: "gw-test", OverlayIPv4: "100.64.0.9", OverlayIPv6: "fd7a:115c:a1e0::9",
			Credential: "cred-test", NetworkPSKHex: strings.Repeat("00", 32),
		})
	})
	mux.HandleFunc("/v4/control/heartbeat", func(w http.ResponseWriter, _ *http.Request) {
		write(w, control.HeartbeatResponse{Acknowledged: true, NetmapVersion: 1})
	})
	mux.HandleFunc("/v4/control/netmap", func(w http.ResponseWriter, _ *http.Request) {
		doc := control.NetmapResponse{
			Version: 1, GeneratedAtUnix: time.Now().Unix(), MaxStalenessSeconds: 3600,
			Self:  control.NetmapSelf{OverlayIPv4: "100.64.0.9", MTU: 1280, ListenPort: 0, Vless: s.vless},
			Peers: []control.NetmapPeer{s.peer},
		}
		write(w, doc)
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, _ *http.Request) { write(w, map[string]any{}) })
	if tlsOn {
		s.srv = httptest.NewUnstartedServer(mux)
		s.srv.TLS = &tls.Config{MinVersion: tls.VersionTLS12}
		s.srv.StartTLS()
	} else {
		s.srv = httptest.NewServer(mux)
	}
	t.Cleanup(s.srv.Close)
	return s
}

func (s *stubControl) registrations() ([]control.RegisterRequest, []string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]control.RegisterRequest(nil), s.register...), append([]string(nil), s.auth...)
}

func waitFor(t *testing.T, what string, d time.Duration, f func() bool) {
	t.Helper()
	end := time.Now().Add(d)
	for time.Now().Before(end) {
		if f() {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func buildNode(t *testing.T, dir string) string {
	t.Helper()
	bin := filepath.Join(dir, "sovereign-node")
	cmd := exec.Command("go", "build", "-o", bin, "./cmd/sovereign-node")
	cmd.Dir = filepath.Join("..", "..")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("go build: %v\n%s", err, out)
	}
	return bin
}

type nodeRun struct {
	cmd *exec.Cmd
	log *bytes.Buffer
}

func (n *nodeRun) stop() {
	if n.cmd.Process != nil {
		_ = n.cmd.Process.Kill()
		_, _ = n.cmd.Process.Wait()
	}
}

func startNode(t *testing.T, bin, dir string, env map[string]string) *nodeRun {
	t.Helper()
	cmd := exec.Command(bin)
	cmd.Dir = dir // config.LoadDotEnv reads .env from here: there is none
	cmd.Env = []string{"PATH=" + os.Getenv("PATH"), "HOME=" + dir}
	for k, v := range env {
		cmd.Env = append(cmd.Env, k+"="+v)
	}
	buf := &bytes.Buffer{}
	cmd.Stdout, cmd.Stderr = buf, buf
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	n := &nodeRun{cmd: cmd, log: buf}
	t.Cleanup(n.stop)
	return n
}

func TestGatewayBinaryReportsThePublicPortBindsLoopbackAndConsumesItsKey(t *testing.T) {
	xray := need(t, "XRAY_BIN")
	dir := t.TempDir()
	bin := buildNode(t, dir)

	priv, _ := x25519(t, xray)
	coverAddr, _ := coverSite(t, "cover-bin")
	const deviceUUID = "6f0f2a6e-1c5b-4f43-9a52-0b3c1d2e4f60"
	vless := &control.VlessConfig{ListenPort: 443, Dest: coverAddr, ServerNames: []string{neroSNI}, PrivateKey: priv, ShortIDs: []string{shortID}}
	peer := control.NetmapPeer{
		NodeID: "dev-1", PublicKeyHex: strings.Repeat("ab", 32), Profile: true, AccessMethod: "vless-reality",
		VlessUUID: deviceUUID, AllowedIPs: []string{"100.64.0.20/32"},
	}
	cp := newStubControl(t, true, vless, peer)

	caPath := filepath.Join(dir, "control-ca.pem")
	if err := os.WriteFile(caPath, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: cp.srv.Certificate().Raw}), 0o644); err != nil {
		t.Fatal(err)
	}
	keyFile := filepath.Join(dir, "enrol.key")
	const preauth = "preauth-0123456789abcdef"
	if err := os.WriteFile(keyFile, []byte(preauth+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	xrayCfg := filepath.Join(dir, "xray", "config.json")
	vlessListen := fmt.Sprintf("127.0.0.1:%d", freePort(t))
	socksDev := fmt.Sprintf("127.0.0.1:%d", freePort(t))

	env := map[string]string{
		"SOVEREIGN_CONTROL_PLANE_URL":  cp.srv.URL,
		"SOVEREIGN_CONTROL_PLANE_CA":   caPath,
		"SOVEREIGN_NODE_KEY_PATH":      filepath.Join(dir, "node_identity.key"),
		"SOVEREIGN_ENROLMENT_KEY_FILE": keyFile,
		"SOVEREIGN_DATAPLANE":          "netstack",
		"SOVEREIGN_SOCKS5_LISTEN_ADDR": fmt.Sprintf("127.0.0.1:%d", freePort(t)),
		"SOVEREIGN_HTTP_LISTEN_ADDR":   fmt.Sprintf("127.0.0.1:%d", freePort(t)),
		"SOVEREIGN_VLESS_PORT":         "443",
		"SOVEREIGN_VLESS_LISTEN":       vlessListen,
		"SOVEREIGN_VLESS_ACCEPT_PROXY": "true",
		"SOVEREIGN_VLESS_SOCKS_LISTEN": socksDev,
		"SOVEREIGN_VLESS_SOCKS_ADDR":   socksDev,
		"SOVEREIGN_XRAY_CONFIG":        xrayCfg,
	}
	node := startNode(t, bin, dir, env)
	defer func() {
		if t.Failed() {
			t.Logf("node log:\n%s", node.log.String())
		}
	}()

	// Enrolment: the pre-auth key from the file, no fleet token, over the pinned CA.
	waitFor(t, "the registration", 20*time.Second, func() bool { r, _ := cp.registrations(); return len(r) > 0 })
	regs, auths := cp.registrations()
	if regs[0].PreAuthKey != preauth {
		t.Fatalf("the key file was not used for enrolment (sent %q)", regs[0].PreAuthKey)
	}
	if regs[0].AuthToken != "" || (auths[0] != "" && !strings.HasPrefix(auths[0], "Bearer ")) {
		t.Fatalf("a fleet token was sent: %q %q", regs[0].AuthToken, auths[0])
	}
	// What the console is told: the public port, not the loopback one.
	if regs[0].Capability.VlessPort != 443 || !contains(regs[0].Capability.Capabilities, "vless-v1") {
		t.Fatalf("capability %+v", regs[0].Capability)
	}
	waitFor(t, "the key file to be consumed", 5*time.Second, func() bool { _, err := os.Stat(keyFile); return os.IsNotExist(err) })
	if strings.Contains(node.log.String(), preauth) {
		t.Fatal("the pre-auth key was logged")
	}

	// The real binary wrote Xray's configuration with the loopback socket, from the netmap.
	waitFor(t, "the Xray configuration", 20*time.Second, func() bool { _, err := os.Stat(xrayCfg); return err == nil })
	raw, err := os.ReadFile(xrayCfg)
	if err != nil {
		t.Fatal(err)
	}
	var cfg struct {
		Inbounds []struct {
			Listen         string
			Port           int
			StreamSettings struct{ Sockopt struct{ AcceptProxyProtocol bool } }
			Settings       struct{ Clients []struct{ ID string } }
		}
	}
	if err := json.Unmarshal(raw, &cfg); err != nil {
		t.Fatal(err)
	}
	host, port, _ := net.SplitHostPort(vlessListen)
	in := cfg.Inbounds[0]
	if in.Listen != host || fmt.Sprint(in.Port) != port || !in.StreamSettings.Sockopt.AcceptProxyProtocol ||
		len(in.Settings.Clients) != 1 || in.Settings.Clients[0].ID != deviceUUID {
		t.Fatalf("inbound %+v", in)
	}

	// And a real Xray accepts that file and listens where the node said, on loopback only.
	proc := startXray(t, xray, dir, "from-node", raw)
	defer proc.stop()
	waitFor(t, "Xray to listen on the loopback address", 10*time.Second, func() bool {
		c, err := net.DialTimeout("tcp", vlessListen, time.Second)
		if err == nil {
			_ = c.Close()
		}
		return err == nil
	})

	// A control plane the pinned CA did not sign is never talked to: no insecure fallback.
	other := newStubControl(t, true, vless, peer)
	envBad := map[string]string{}
	for k, v := range env {
		envBad[k] = v
	}
	envBad["SOVEREIGN_CONTROL_PLANE_URL"] = other.srv.URL
	envBad["SOVEREIGN_NODE_KEY_PATH"] = filepath.Join(dir, "second_identity.key")
	envBad["SOVEREIGN_ENROLMENT_KEY_FILE"] = ""
	envBad["SOVEREIGN_ENROLMENT_KEY"] = "never-sent"
	envBad["SOVEREIGN_SOCKS5_LISTEN_ADDR"] = fmt.Sprintf("127.0.0.1:%d", freePort(t))
	envBad["SOVEREIGN_HTTP_LISTEN_ADDR"] = fmt.Sprintf("127.0.0.1:%d", freePort(t))
	envBad["SOVEREIGN_VLESS_SOCKS_LISTEN"] = fmt.Sprintf("127.0.0.1:%d", freePort(t))
	envBad["SOVEREIGN_VLESS_SOCKS_ADDR"] = envBad["SOVEREIGN_VLESS_SOCKS_LISTEN"]
	envBad["SOVEREIGN_VLESS_LISTEN"] = fmt.Sprintf("127.0.0.1:%d", freePort(t))
	envBad["SOVEREIGN_XRAY_CONFIG"] = filepath.Join(dir, "xray2", "config.json")
	strangerNode := startNode(t, bin, dir, envBad) // its CA is the first server's, not this one's
	time.Sleep(4 * time.Second)
	strangerNode.stop()
	if r, _ := other.registrations(); len(r) != 0 {
		t.Fatalf("the node registered with a control plane its pinned CA did not sign")
	}
}

func contains(l []string, s string) bool {
	for _, v := range l {
		if v == s {
			return true
		}
	}
	return false
}

func TestGatewayBinaryRefusesPROXYProtocolOffLoopback(t *testing.T) {
	dir := t.TempDir()
	bin := buildNode(t, dir)
	cp := newStubControl(t, false, nil, control.NetmapPeer{})
	for _, listen := range []string{"0.0.0.0:8445", ""} {
		env := map[string]string{
			"SOVEREIGN_CONTROL_PLANE_URL":  cp.srv.URL,
			"SOVEREIGN_NODE_KEY_PATH":      filepath.Join(dir, "k"+fmt.Sprint(len(listen))),
			"SOVEREIGN_DATAPLANE":          "netstack",
			"SOVEREIGN_SOCKS5_LISTEN_ADDR": fmt.Sprintf("127.0.0.1:%d", freePort(t)),
			"SOVEREIGN_HTTP_LISTEN_ADDR":   fmt.Sprintf("127.0.0.1:%d", freePort(t)),
			"SOVEREIGN_VLESS_PORT":         "443",
			"SOVEREIGN_VLESS_LISTEN":       listen,
			"SOVEREIGN_VLESS_ACCEPT_PROXY": "true",
			"SOVEREIGN_VLESS_SOCKS_LISTEN": fmt.Sprintf("127.0.0.1:%d", freePort(t)),
			"SOVEREIGN_VLESS_SOCKS_ADDR":   "127.0.0.1:1",
			"SOVEREIGN_XRAY_CONFIG":        filepath.Join(dir, "x.json"),
		}
		n := startNode(t, bin, dir, env)
		done := make(chan error, 1)
		go func() { done <- n.cmd.Wait() }()
		select {
		case err := <-done:
			if err == nil {
				t.Fatalf("listen %q: the node exited cleanly with PROXY protocol off loopback", listen)
			}
			if !strings.Contains(n.log.String(), "PROXY") && !strings.Contains(n.log.String(), "SOVEREIGN_VLESS") {
				t.Fatalf("listen %q: it stopped, but not for the reason under test:\n%s", listen, n.log.String())
			}
		case <-time.After(20 * time.Second):
			n.stop()
			t.Fatalf("listen %q: the node kept running with PROXY protocol off loopback", listen)
		}
	}
}
