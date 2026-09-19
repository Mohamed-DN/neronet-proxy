package bridge

import (
	"context"
	"errors"
	"io"
	"net"
	"sync"
	"testing"
	"time"
)

// recordingOverlay stands in for the data plane device. It records what it was
// asked to dial and connects to a plain local listener, so the test measures the
// routing decision and not the WireGuard stack.
type recordingOverlay struct {
	mu     sync.Mutex
	dialed []string
	target string
	err    error
}

func (r *recordingOverlay) DialContext(ctx context.Context, network, address string) (net.Conn, error) {
	r.mu.Lock()
	r.dialed = append(r.dialed, address)
	r.mu.Unlock()
	if r.err != nil {
		return nil, r.err
	}
	var d net.Dialer
	return d.DialContext(ctx, network, r.target)
}

func (r *recordingOverlay) addresses() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string(nil), r.dialed...)
}

func startEchoListener(t *testing.T) string {
	t.Helper()

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("starting echo listener: %v", err)
	}
	t.Cleanup(func() { ln.Close() })

	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				defer conn.Close()
				_, _ = io.Copy(conn, conn)
			}()
		}
	}()
	return ln.Addr().String()
}

func TestDialAndPipeSendsOverlayDestinationsThroughTheMesh(t *testing.T) {
	overlay := &recordingOverlay{target: startEchoListener(t)}

	b := NewNetstackBridge(NewSandboxPolicyEngine(SandboxPolicyConfig{}), nil, nil)
	b.SetOverlayDialer(overlay)

	client, proxySide := net.Pipe()
	defer client.Close()

	done := make(chan error, 1)
	go func() { done <- b.DialAndPipe(context.Background(), proxySide, "100.64.0.2", 9999) }()

	_ = client.SetDeadline(time.Now().Add(5 * time.Second))
	const marker = "overlay-routed"
	if _, err := client.Write([]byte(marker)); err != nil {
		t.Fatalf("writing to the proxy: %v", err)
	}
	got := make([]byte, len(marker))
	if _, err := io.ReadFull(client, got); err != nil {
		t.Fatalf("reading the echo back: %v", err)
	}
	if string(got) != marker {
		t.Fatalf("echo returned %q, want %q", got, marker)
	}

	client.Close()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("DialAndPipe did not return after the client closed")
	}

	dialed := overlay.addresses()
	if len(dialed) != 1 || dialed[0] != "100.64.0.2:9999" {
		t.Fatalf("overlay dialer saw %v, want one dial of 100.64.0.2:9999", dialed)
	}
}

// TestDialAndPipeWithoutOverlayKeepsBogonRejection pins the behaviour of a node
// with -dataplane=off: the assigned 100.64 addresses stay unreachable, exactly as
// before this package was wired in.
func TestDialAndPipeWithoutOverlayKeepsBogonRejection(t *testing.T) {
	b := NewNetstackBridge(NewSandboxPolicyEngine(SandboxPolicyConfig{}), nil, nil)

	client, proxySide := net.Pipe()
	defer client.Close()

	err := b.DialAndPipe(context.Background(), proxySide, "100.64.0.2", 9999)
	if !errors.Is(err, ErrBogonIPBlocked) {
		t.Fatalf("DialAndPipe returned %v, want ErrBogonIPBlocked", err)
	}
}

// TestDialAndPipeLeavesPublicDestinationsAlone checks the overlay dialer is not a
// catch-all: a public address still goes through the sandbox and the normal dialer.
func TestDialAndPipeLeavesPublicDestinationsAlone(t *testing.T) {
	overlay := &recordingOverlay{err: errors.New("the overlay must not be used here")}

	b := NewNetstackBridge(NewSandboxPolicyEngine(SandboxPolicyConfig{}), nil, nil)
	b.SetOverlayDialer(overlay)

	client, proxySide := net.Pipe()
	defer client.Close()

	// Port 25 is on the anti-abuse blocklist, so the sandbox rejects this before
	// any socket is opened. That the sandbox is what answered is the point.
	err := b.DialAndPipe(context.Background(), proxySide, "198.51.100.10", 25)
	if !errors.Is(err, ErrAbusePortBlocked) {
		t.Fatalf("DialAndPipe returned %v, want ErrAbusePortBlocked", err)
	}
	if dialed := overlay.addresses(); len(dialed) != 0 {
		t.Fatalf("overlay dialer was used for a public destination: %v", dialed)
	}
}

func TestIsOverlayIP(t *testing.T) {
	for addr, want := range map[string]bool{
		"100.64.0.1":        true,
		"100.127.255.254":   true,
		"fd7a:115c:a1e0::1": true,
		"100.128.0.1":       false,
		"10.0.0.1":          false,
		"198.51.100.10":     false,
		"fd00::1":           false,
	} {
		if got := IsOverlayIP(net.ParseIP(addr)); got != want {
			t.Errorf("IsOverlayIP(%s) = %t, want %t", addr, got, want)
		}
	}
	if IsOverlayIP(nil) {
		t.Error("IsOverlayIP(nil) = true")
	}
}
