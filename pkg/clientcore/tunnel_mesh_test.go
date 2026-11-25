package clientcore

import (
	"context"
	"errors"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/sovereign/proxy/v4/pkg/meshnode"
)

type fakeNode struct {
	ready   atomic.Bool
	stopped atomic.Int32
}

func (f *fakeNode) Stop()          { f.stopped.Add(1) }
func (f *fakeNode) Ready() bool    { return f.ready.Load() }
func (f *fakeNode) NodeID() string { return "pk_0123456789abcdef" }

func tunnelWith(t *testing.T, start func(context.Context, meshnode.Options) (nodeHandle, error)) *MeshTunnel {
	t.Helper()
	tun, err := NewMeshTunnel(MeshConfig{ControlURL: "https://console.example.com", StateDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	tun.start = start
	tun.poll = 5 * time.Millisecond
	return tun
}

func refused(status, reason string) error {
	return &meshnode.RegistrationError{Err: errors.New("control plane refused registration: status " + status + ": " + reason)}
}

func TestMeshTunnelHandsTheInstallationKeyToTheNodeAndWaitsForANetmap(t *testing.T) {
	var got meshnode.Options
	node := &fakeNode{}
	tun := tunnelWith(t, func(_ context.Context, o meshnode.Options) (nodeHandle, error) {
		got = o
		go func() { time.Sleep(30 * time.Millisecond); node.ready.Store(true) }()
		return node, nil
	})
	key := testKey()
	if err := tun.Up(context.Background(), UpRequest{Method: MethodWireGuard, Key: key, NodeID: "pk_0123456789abcdef"}); err != nil {
		t.Fatal(err)
	}
	if got.Keypair != key {
		t.Error("the node did not get the installation's own key")
	}
	if !got.RequireRegistration {
		t.Error("a refused registration would be hidden behind a standalone node")
	}
	if got.SocksAddr != "" || got.HTTPAddr != "" || got.DropListen != "" || got.MetricsAddr != "" {
		t.Errorf("the app started listeners it was not asked for: %+v", got)
	}
	if got.DataplaneMode != "netstack" {
		t.Errorf("mode %q", got.DataplaneMode)
	}
	if !got.MeshDNS {
		t.Error("mesh names are off")
	}
	if !node.Ready() {
		t.Error("Up returned before the node had a netmap")
	}
	if err := tun.Down(context.Background()); err != nil || node.stopped.Load() != 1 {
		t.Errorf("down: %v, stopped %d times", err, node.stopped.Load())
	}
	_ = tun.Down(context.Background())
	if node.stopped.Load() != 1 {
		t.Error("a second Down stopped the node again")
	}
}

func TestMeshTunnelNodeOutlivesTheAttemptThatStartedIt(t *testing.T) {
	var parent context.Context
	node := &fakeNode{}
	node.ready.Store(true)
	tun := tunnelWith(t, func(ctx context.Context, o meshnode.Options) (nodeHandle, error) {
		parent = ctx
		return node, nil
	})
	attempt, cancel := context.WithTimeout(context.Background(), time.Second)
	if err := tun.Up(attempt, UpRequest{Method: MethodWireGuard, Key: testKey()}); err != nil {
		t.Fatal(err)
	}
	cancel()
	if parent.Err() != nil {
		t.Error("the node was started on the attempt's context: it ends with the attempt")
	}
}

func TestMeshTunnelTellsRevokedAndSuspendedApart(t *testing.T) {
	for reason, want := range map[string]error{
		"this key has been revoked":       ErrRevoked,
		"this app was removed":            ErrRevoked,
		"this app must be approved again": ErrSuspended,
	} {
		reason, want := reason, want
		tun := tunnelWith(t, func(context.Context, meshnode.Options) (nodeHandle, error) { return nil, refused("403", reason) })
		err := tun.Up(context.Background(), UpRequest{Method: MethodWireGuard, Key: testKey()})
		if !errors.Is(err, want) {
			t.Errorf("%q: got %v, want %v", reason, err, want)
		}
	}
	// Anything else is an ordinary failure, to be tried again on the next path.
	tun := tunnelWith(t, func(context.Context, meshnode.Options) (nodeHandle, error) {
		return nil, &meshnode.RegistrationError{Err: errors.New("connection refused")}
	})
	err := tun.Up(context.Background(), UpRequest{Method: MethodWireGuard, Key: testKey()})
	if err == nil || errors.Is(err, ErrRevoked) || errors.Is(err, ErrSuspended) {
		t.Errorf("got %v", err)
	}
}

func TestMeshTunnelGivesUpAndStopsTheNodeWhenNoNetmapComes(t *testing.T) {
	node := &fakeNode{}
	tun := tunnelWith(t, func(context.Context, meshnode.Options) (nodeHandle, error) { return node, nil })
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Millisecond)
	defer cancel()
	if err := tun.Up(ctx, UpRequest{Method: MethodWireGuard, Key: testKey()}); err == nil {
		t.Fatal("Up reported success without a netmap")
	}
	if node.stopped.Load() != 1 {
		t.Error("a node that never became ready was left running")
	}
}

func TestMeshTunnelOnlyDoesPlainWireGuardAndAdmitsIt(t *testing.T) {
	tun := tunnelWith(t, func(context.Context, meshnode.Options) (nodeHandle, error) { return &fakeNode{}, nil })
	if !tun.Available(MethodWireGuard) || tun.Available(MethodWireGuardWSS) || tun.Available(MethodAmneziaWG) {
		t.Error("the tunnel claims methods it does not have")
	}
	err := tun.Up(context.Background(), UpRequest{Method: MethodWireGuardWSS, Key: testKey()})
	if err == nil || !strings.Contains(err.Error(), "not available") {
		t.Errorf("got %v", err)
	}
	if tun.KillSwitch() != KillSwitchUnknown {
		t.Error("a kill switch that is not built is reported as something else")
	}
	if _, err := NewMeshTunnel(MeshConfig{}); err == nil {
		t.Error("an empty configuration was accepted")
	}
}

func TestSuspensionFromTheTunnelKeepsKeysAndAsksForANewSignIn(t *testing.T) {
	tun := &fakeTunnel{failures: map[Method]error{MethodWireGuard: ErrSuspended}}
	core, store := signedInCore(t, tun)
	keyBefore := core.PublicKeyHex()
	if err := core.Connect(context.Background()); !errors.Is(err, ErrSuspended) {
		t.Fatalf("got %v", err)
	}
	st := core.State()
	if st.Phase != PhaseSignedOut || !strings.Contains(st.Message, "Sign in again") {
		t.Errorf("%s %q", st.Phase, st.Message)
	}
	if len(tun.tried) != 1 {
		t.Errorf("tried %v after being told the approval ended", tun.tried)
	}
	if core.PublicKeyHex() != keyBefore {
		t.Error("the keys were replaced for a recoverable suspension")
	}
	if _, err := store.LoadKey(aliasToken); err == nil {
		t.Error("token kept")
	}
}
