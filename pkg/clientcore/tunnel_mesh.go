package clientcore

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"sync"
	"time"

	"github.com/sovereign/proxy/v4/pkg/meshnode"
)

// ErrSuspended is what a Tunnel returns when the console ended the app's approval in a way a new
// approval puts right (a blocked device, a changed password, an expired lifetime). The installation and
// its keys are still good: the person signs in again and the same device comes back.
var ErrSuspended = errors.New("this device's approval ended; sign in again")

// MeshConfig says where the node reaches the control plane and where it keeps its state. It carries
// no key: the installation key is the Core's, handed to the tunnel at every Up.
type MeshConfig struct {
	// ControlURL is the console's address, and ControlCAPath a PEM file of the only CA trusted for it
	// (empty uses the system roots).
	ControlURL    string
	ControlCAPath string

	// StateDir holds the node's stored netmap, so that it can start on the last document it had.
	StateDir string

	// DataplaneMode is "netstack" (userspace, needs no privilege, reached through SocksAddr) or "tun"
	// (a kernel interface, needs the right to create one). Empty means netstack.
	DataplaneMode string

	// SocksAddr, when set, is a loopback SOCKS5 proxy that carries a program's traffic into the mesh
	// (netstack mode). Empty starts none.
	SocksAddr string
}

// nodeHandle is what MeshTunnel needs of a running node: meshnode.Handle, or a fake in a test.
type nodeHandle interface {
	Stop()
	Ready() bool
	NodeID() string
}

// MeshTunnel is the Tunnel the app uses: it starts the node agent's own code (pkg/meshnode), registered
// as the person's installation, and stops it. Only the plain WireGuard method exists; the WebSocket and
// AmneziaWG methods are not wired into the app, so Available says so and the connection order skips them
// instead of pretending.
type MeshTunnel struct {
	cfg   MeshConfig
	start func(ctx context.Context, o meshnode.Options) (nodeHandle, error)
	poll  time.Duration

	// names resolves mesh names for the whole computer; only a tunnel with an interface (tun mode) has one.
	names *NameService

	mu sync.Mutex
	h  nodeHandle
}

// NewMeshTunnel builds the tunnel for a configuration.
func NewMeshTunnel(cfg MeshConfig) (*MeshTunnel, error) {
	if cfg.ControlURL == "" || cfg.StateDir == "" {
		return nil, errors.New("clientcore: a control URL and a state directory are required")
	}
	t := &MeshTunnel{
		cfg:  cfg,
		poll: 100 * time.Millisecond,
		start: func(ctx context.Context, o meshnode.Options) (nodeHandle, error) {
			h, err := meshnode.Start(ctx, o)
			if err != nil {
				return nil, err
			}
			return h, nil
		},
	}
	if cfg.DataplaneMode == "tun" {
		t.names = NewHostNameService()
	}
	return t, nil
}

// tunInterface is the name the data plane gives its kernel interface.
const tunInterface = "nero0"

// ClearStale removes the settings an earlier run of this service left in the system when it was killed.
// The service calls it once at start.
func (t *MeshTunnel) ClearStale() {
	if t.names != nil {
		t.names.ClearStale(tunInterface)
	}
}

// Names says whether mesh names resolve for the whole computer, and how.
func (t *MeshTunnel) Names() NamesState {
	if t.names == nil {
		return NamesState{Status: NamesOff}
	}
	return t.names.State()
}

// Available is true for plain WireGuard only.
func (t *MeshTunnel) Available(m Method) bool { return m == MethodWireGuard }

// KillSwitch is not implemented by this tunnel, and says so: "unsupported" is the truth, not "off".
func (t *MeshTunnel) KillSwitch() KillSwitchState { return KillSwitchUnknown }

// Up starts the node as the installation (its key, its registration) and returns once it runs on a
// netmap, or ctx ends. The node's own lifetime is not ctx's: ctx bounds one attempt of the connection
// order, and the node must outlive it.
func (t *MeshTunnel) Up(ctx context.Context, req UpRequest) error {
	if req.Method != MethodWireGuard {
		return fmt.Errorf("connection method %q is not available on this device", req.Method)
	}
	if req.Key == nil {
		return errors.New("clientcore: the tunnel needs the installation key")
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.names != nil {
		t.names.Stop()
	}
	if t.h != nil {
		t.h.Stop()
		t.h = nil
	}
	mode := t.cfg.DataplaneMode
	if mode == "" {
		mode = "netstack"
	}
	var onNames meshnode.NamesSink
	if t.names != nil {
		onNames = t.names.Sink()
	}
	h, err := t.start(context.Background(), meshnode.Options{
		OnNames:             onNames,
		SocksAddr:           t.cfg.SocksAddr,
		ControlURL:          t.cfg.ControlURL,
		ControlCA:           t.cfg.ControlCAPath,
		IdentityPath:        filepath.Join(t.cfg.StateDir, "node-state"),
		DataplaneMode:       mode,
		Keypair:             req.Key,
		MeshDNS:             true,
		RequireRegistration: true,
	})
	if err != nil {
		var re *meshnode.RegistrationError
		if errors.As(err, &re) {
			switch {
			case re.Revoked():
				return ErrRevoked
			case re.Suspended():
				return ErrSuspended
			}
		}
		return err
	}
	tick := time.NewTicker(t.poll)
	defer tick.Stop()
	for !h.Ready() {
		select {
		case <-ctx.Done():
			h.Stop()
			return fmt.Errorf("the node did not get a netmap in time: %w", ctx.Err())
		case <-tick.C:
		}
	}
	t.h = h
	if t.names != nil {
		// Not fatal: the tunnel does not depend on names, and the state says what did not work.
		_ = t.names.Start(tunInterface)
	}
	return nil
}

// Down stops the node.
func (t *MeshTunnel) Down(context.Context) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.names != nil {
		t.names.Stop()
	}
	if t.h != nil {
		t.h.Stop()
		t.h = nil
	}
	return nil
}
