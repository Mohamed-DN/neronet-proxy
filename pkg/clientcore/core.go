package clientcore

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"sync"
	"time"

	"github.com/sovereign/proxy/v4/pkg/crypto"
	"github.com/sovereign/proxy/v4/pkg/keystore"
)

// APIVersion is the version of the state and of the local API. It changes only when an
// interface built for the old one would misread the new one.
const APIVersion = 1

const (
	aliasInstallation = "app-installation-key"
	aliasSigning      = "app-signing-key"
	aliasToken        = "app-token"
	aliasEnrolment    = "app-enrolment"
)

// ErrRevoked is what a Tunnel returns when the console no longer accepts this node.
var ErrRevoked = errors.New("this device was removed from the network")

// Enrolment is what the console assigned to this installation.
type Enrolment struct {
	NodeID      string `json:"node_id"`
	OverlayIPv4 string `json:"overlay_ipv4"`
	OverlayIPv6 string `json:"overlay_ipv6,omitempty"`
}

// Enroller joins the mesh as one node with a grant.
type Enroller interface {
	Enrol(ctx context.Context, key *crypto.Keypair, grant Grant) (*Enrolment, error)
}

// UpRequest is everything a tunnel needs to come up.
type UpRequest struct {
	Method Method
	Exit   string
	Key    *crypto.Keypair
	NodeID string
}

// Tunnel starts and stops the data plane. Up must return once ctx ends.
type Tunnel interface {
	Up(ctx context.Context, req UpRequest) error
	Down(ctx context.Context) error
	Available(m Method) bool
	KillSwitch() KillSwitchState
}

// Config wires a Core. Every field is required except Sleep and PerAttempt.
type Config struct {
	Platform   string
	DeviceName string
	Console    Console
	Enroller   Enroller
	Tunnel     Tunnel
	Store      keystore.KeyStore
	PerAttempt time.Duration
	Sleep      func(context.Context, time.Duration) error
}

// Core is the app's brain. Its methods are what the local API exposes, and nothing else.
type Core struct {
	cfg  Config
	hub  *Hub
	ops  sync.Mutex // one command at a time
	mu   sync.Mutex
	key  *crypto.Keypair
	sign ed25519.PrivateKey
	flow context.CancelFunc // the running sign-in, if any
}

var exitName = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`)

// New loads or creates the installation key and restores a previous sign-in.
func New(cfg Config) (*Core, error) {
	if cfg.Console == nil || cfg.Enroller == nil || cfg.Tunnel == nil || cfg.Store == nil {
		return nil, errors.New("clientcore: console, enroller, tunnel and key store are required")
	}
	if cfg.PerAttempt <= 0 {
		cfg.PerAttempt = 12 * time.Second
	}
	req := StartRequest{Platform: cfg.Platform, DeviceName: cfg.DeviceName, PublicKeyHex: hex64Zero, SigningKeyHex: hex64Zero}
	if err := req.Validate(); err != nil {
		return nil, fmt.Errorf("clientcore: %w", err)
	}
	c := &Core{cfg: cfg}
	key, err := loadOrCreateKey(cfg.Store)
	if err != nil {
		return nil, err
	}
	c.key = key
	sign, err := loadOrCreateSigningKey(cfg.Store)
	if err != nil {
		return nil, err
	}
	c.sign = sign
	initial := State{Phase: PhaseSignedOut, KillSwitch: cfg.Tunnel.KillSwitch(), Order: Order{Methods: append([]Method(nil), DefaultOrder...)}}
	if raw, err := cfg.Store.LoadKey(aliasEnrolment); err == nil {
		var e Enrolment
		if json.Unmarshal(raw, &e) == nil && nodeIDRe.MatchString(e.NodeID) {
			initial.Phase = PhaseDisconnected
			initial.NodeID = e.NodeID
			initial.Overlay = e.OverlayIPv4
		}
	}
	c.hub = NewHub(initial)
	return c, nil
}

const hex64Zero = "0000000000000000000000000000000000000000000000000000000000000000"

func loadOrCreateKey(ks keystore.KeyStore) (*crypto.Keypair, error) {
	raw, err := ks.LoadKey(aliasInstallation)
	if err == nil {
		if len(raw) != crypto.KeySize {
			return nil, errors.New("clientcore: stored installation key has the wrong size")
		}
		var priv [crypto.KeySize]byte
		copy(priv[:], raw)
		pub, derr := crypto.DH(priv, [crypto.KeySize]byte{9})
		if derr != nil {
			return nil, fmt.Errorf("clientcore: stored installation key is not usable: %w", derr)
		}
		return &crypto.Keypair{PrivateKey: priv, PublicKey: pub}, nil
	}
	if !errors.Is(err, keystore.ErrKeyNotFound) {
		return nil, fmt.Errorf("clientcore: reading the installation key: %w", err)
	}
	kp, gerr := crypto.GenerateKeypair()
	if gerr != nil {
		return nil, gerr
	}
	if serr := ks.StoreKey(aliasInstallation, kp.PrivateKey[:]); serr != nil {
		return nil, fmt.Errorf("clientcore: storing the installation key: %w", serr)
	}
	return kp, nil
}

func loadOrCreateSigningKey(ks keystore.KeyStore) (ed25519.PrivateKey, error) {
	raw, err := ks.LoadKey(aliasSigning)
	if err == nil {
		if len(raw) != ed25519.SeedSize {
			return nil, errors.New("clientcore: stored signing key has the wrong size")
		}
		return ed25519.NewKeyFromSeed(raw), nil
	}
	if !errors.Is(err, keystore.ErrKeyNotFound) {
		return nil, fmt.Errorf("clientcore: reading the signing key: %w", err)
	}
	seed := make([]byte, ed25519.SeedSize)
	if _, err := rand.Read(seed); err != nil {
		return nil, err
	}
	if err := ks.StoreKey(aliasSigning, seed); err != nil {
		return nil, fmt.Errorf("clientcore: storing the signing key: %w", err)
	}
	return ed25519.NewKeyFromSeed(seed), nil
}

// SigningKeyHex is the public half of the key that signs token refreshes.
func (c *Core) SigningKeyHex() string {
	return fmt.Sprintf("%x", c.sign.Public().(ed25519.PublicKey))
}

// PublicKeyHex is the installation's public key, which the console binds the app to.
func (c *Core) PublicKeyHex() string { return fmt.Sprintf("%x", c.key.PublicKey[:]) }

// State is the current state. Subscribe is the stream.
func (c *Core) State() State { return c.hub.Get() }

// Subscribe returns a stream of states, starting with the current one.
func (c *Core) Subscribe() (<-chan State, func()) { return c.hub.Subscribe() }

// SignIn starts the device-code flow. It returns once the console has issued a code; the
// wait for approval, the storing of the token and the enrolment continue in the background
// and show up in the state. Calling it while a sign-in runs returns an error.
func (c *Core) SignIn(ctx context.Context) error {
	c.ops.Lock()
	defer c.ops.Unlock()
	if ph := c.hub.Get().Phase; ph != PhaseSignedOut && ph != PhaseFailed {
		return fmt.Errorf("cannot sign in while %s", ph)
	}
	dc, err := c.cfg.Console.Start(ctx, StartRequest{Platform: c.cfg.Platform, DeviceName: c.cfg.DeviceName, PublicKeyHex: c.PublicKeyHex(), SigningKeyHex: c.SigningKeyHex()})
	if err != nil {
		c.fail("could not reach the console to sign in")
		return err
	}
	flowCtx, cancel := context.WithCancel(context.Background())
	c.mu.Lock()
	c.flow = cancel
	c.mu.Unlock()
	c.hub.Update(func(s *State) {
		s.Phase = PhaseSigningIn
		s.Message = ""
		s.UserCode = dc.UserCode
		s.VerifyPath = dc.VerificationURIComplete
	})
	go c.finishSignIn(flowCtx, dc)
	return nil
}

func (c *Core) finishSignIn(ctx context.Context, dc *DeviceCode) {
	res, err := WaitApproved(ctx, c.cfg.Console, dc, c.cfg.Sleep)
	if err != nil {
		switch {
		case errors.Is(err, context.Canceled):
			c.hub.Update(func(s *State) { s.Phase = PhaseSignedOut; s.UserCode = ""; s.VerifyPath = "" })
		case errors.Is(err, ErrDenied):
			c.fail("the sign-in was denied")
		case errors.Is(err, ErrExpired):
			c.fail("the code expired, start again")
		default:
			c.fail("sign-in stopped: the console could not be reached")
		}
		return
	}
	tok, _ := json.Marshal(res.Token)
	if err := c.cfg.Store.StoreKey(aliasToken, tok); err != nil {
		c.fail("the sign-in could not be saved on this device")
		return
	}
	c.hub.Update(func(s *State) { s.Phase = PhaseEnrolling; s.UserCode = ""; s.VerifyPath = "" })
	enrolCtx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	en, err := c.cfg.Enroller.Enrol(enrolCtx, c.key, *res.Grant)
	if err != nil {
		_ = c.cfg.Store.DeleteKey(aliasToken)
		c.fail("this device could not join the network")
		return
	}
	raw, _ := json.Marshal(en)
	if err := c.cfg.Store.StoreKey(aliasEnrolment, raw); err != nil {
		c.fail("the enrolment could not be saved on this device")
		return
	}
	c.hub.Update(func(s *State) {
		s.Phase = PhaseDisconnected
		s.Message = ""
		s.NodeID = en.NodeID
		s.Overlay = en.OverlayIPv4
	})
}

func (c *Core) fail(msg string) {
	c.hub.Update(func(s *State) {
		s.Phase = PhaseFailed
		s.Message = msg
		s.UserCode = ""
		s.VerifyPath = ""
	})
}

// CancelSignIn stops a sign-in that is waiting for approval.
func (c *Core) CancelSignIn() {
	c.mu.Lock()
	cancel := c.flow
	c.mu.Unlock()
	if cancel != nil {
		cancel()
	}
}

// Connect brings the tunnel up by walking the connection order.
func (c *Core) Connect(ctx context.Context) error {
	c.ops.Lock()
	defer c.ops.Unlock()
	st := c.hub.Get()
	if st.Phase != PhaseDisconnected && st.Phase != PhaseFailed || st.NodeID == "" {
		return fmt.Errorf("cannot connect while %s", st.Phase)
	}
	c.hub.Update(func(s *State) { s.Phase = PhaseConnecting; s.Message = ""; s.Skipped = nil; s.Failed = nil })
	res, err := Walk(ctx, st.Order, c.cfg.Tunnel.Available, func(actx context.Context, m Method) error {
		return c.cfg.Tunnel.Up(actx, UpRequest{Method: m, Exit: st.Exit, Key: c.key, NodeID: st.NodeID})
	}, c.cfg.PerAttempt)
	if errors.Is(err, ErrRevoked) {
		c.forget("this device was removed from the network")
		return ErrRevoked
	}
	if err != nil {
		c.hub.Update(func(s *State) {
			s.Phase = PhaseFailed
			s.Message = "no connection method worked"
			s.Skipped, s.Failed = res.Skipped, res.Failed
			s.KillSwitch = c.cfg.Tunnel.KillSwitch()
		})
		return err
	}
	c.hub.Update(func(s *State) {
		s.Phase = PhaseConnected
		s.Method = res.Used
		s.Skipped, s.Failed = res.Skipped, res.Failed
		s.KillSwitch = c.cfg.Tunnel.KillSwitch()
	})
	return nil
}

// Disconnect brings the tunnel down.
func (c *Core) Disconnect(ctx context.Context) error {
	c.ops.Lock()
	defer c.ops.Unlock()
	if err := c.cfg.Tunnel.Down(ctx); err != nil {
		return err
	}
	c.hub.Update(func(s *State) {
		s.Phase = PhaseDisconnected
		s.Method = ""
		s.KillSwitch = c.cfg.Tunnel.KillSwitch()
	})
	return nil
}

// SetExit chooses the exit by its mesh name, or clears it with "". Applied at the next connect.
func (c *Core) SetExit(name string) error {
	if name != "" && !exitName.MatchString(name) {
		return errors.New("an exit name is lower-case letters, digits and hyphens")
	}
	c.hub.Update(func(s *State) { s.Exit = name })
	return nil
}

// SetOrder replaces the connection order. Applied at the next connect.
func (c *Core) SetOrder(o Order) error {
	if err := o.Validate(); err != nil {
		return err
	}
	c.hub.Update(func(s *State) { s.Order = Order{Methods: append([]Method(nil), o.Methods...), Forced: o.Forced} })
	return nil
}

// SignOut forgets the sign-in on this device and brings the tunnel down. It does not revoke
// anything at the console: that is the person's or an administrator's act, from the console.
func (c *Core) SignOut(ctx context.Context) error {
	c.ops.Lock()
	defer c.ops.Unlock()
	c.CancelSignIn()
	_ = c.cfg.Tunnel.Down(ctx)
	c.forget("")
	return nil
}

func (c *Core) forget(msg string) {
	_ = c.cfg.Store.DeleteKey(aliasToken)
	_ = c.cfg.Store.DeleteKey(aliasEnrolment)
	c.hub.Update(func(s *State) {
		s.Phase = PhaseSignedOut
		s.Message = msg
		s.NodeID, s.Overlay, s.Method, s.UserCode, s.VerifyPath = "", "", "", "", ""
		s.KillSwitch = c.cfg.Tunnel.KillSwitch()
	})
}
