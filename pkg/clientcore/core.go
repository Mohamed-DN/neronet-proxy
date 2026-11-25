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

// Enrolment is what the console assigned to this installation, and the account it belongs to.
type Enrolment struct {
	NodeID      string `json:"node_id"`
	OverlayIPv4 string `json:"overlay_ipv4"`
	OverlayIPv6 string `json:"overlay_ipv6,omitempty"`
	Account     string `json:"account,omitempty"`
}

// storedToken is the app token as kept in the key store, with when it was issued so the core
// knows when to refresh it.
type storedToken struct {
	AppToken
	IssuedAt int64 `json:"issued_at"`
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
	cfg     Config
	hub     *Hub
	ops     sync.Mutex // one command at a time
	mu      sync.Mutex // guards the fields below
	key     *crypto.Keypair
	sign    ed25519.PrivateKey
	flow    context.CancelFunc // the running sign-in, if any
	flowEnd chan struct{}      // closed when the running sign-in's goroutine has finished
}

var exitName = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`)

// New loads or creates the installation keys and restores a previous sign-in.
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
			initial.Account = e.Account
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

func (c *Core) keys() (*crypto.Keypair, ed25519.PrivateKey) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.key, c.sign
}

// SigningKeyHex is the public half of the key that signs token refreshes.
func (c *Core) SigningKeyHex() string {
	_, sign := c.keys()
	return fmt.Sprintf("%x", sign.Public().(ed25519.PublicKey))
}

// PublicKeyHex is the installation's public key, which the console binds the app to.
func (c *Core) PublicKeyHex() string {
	key, _ := c.keys()
	return fmt.Sprintf("%x", key.PublicKey[:])
}

// State is the current state. Subscribe is the stream.
func (c *Core) State() State { return c.hub.Get() }

// Subscribe returns a stream of states, starting with the current one.
func (c *Core) Subscribe() (<-chan State, func()) { return c.hub.Subscribe() }

// flowDone is closed when no sign-in goroutine is running.
func (c *Core) flowDone() <-chan struct{} {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.flowEnd == nil {
		done := make(chan struct{})
		close(done)
		return done
	}
	return c.flowEnd
}

// SignIn starts the device-code flow. It returns once the console has issued a code; the
// wait for approval, the storing of the token and the enrolment continue in the background
// and show up in the state. Calling it while a sign-in runs returns an error.
func (c *Core) SignIn(ctx context.Context) error {
	c.ops.Lock()
	defer c.ops.Unlock()
	if ph := c.hub.Get().Phase; ph != PhaseSignedOut && ph != PhaseFailed {
		return fmt.Errorf("cannot sign in while %s", ph)
	}
	key, _ := c.keys()
	dc, err := c.cfg.Console.Start(ctx, StartRequest{Platform: c.cfg.Platform, DeviceName: c.cfg.DeviceName, PublicKeyHex: c.PublicKeyHex(), SigningKeyHex: c.SigningKeyHex()}, key)
	if err != nil {
		c.fail("could not reach the console to sign in")
		return err
	}
	// The address the person is shown is checked to be on the console, whatever the console sent.
	verifyURL, err := c.cfg.Console.VerifyURL(dc.VerificationURIComplete)
	if err != nil {
		c.fail("the console sent a sign-in address that is not its own")
		return err
	}
	flowCtx, cancel := context.WithCancel(context.Background())
	end := make(chan struct{})
	c.mu.Lock()
	c.flow = cancel
	c.flowEnd = end
	c.mu.Unlock()
	c.hub.Update(func(s *State) {
		s.Phase = PhaseSigningIn
		s.Message = ""
		s.UserCode = dc.UserCode
		s.VerifyPath = verifyURL
	})
	go func() {
		defer close(end)
		c.finishSignIn(flowCtx, dc)
	}()
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
	if err := c.storeToken(*res.Token); err != nil {
		c.fail("the sign-in could not be saved on this device")
		return
	}
	c.hub.Update(func(s *State) { s.Phase = PhaseEnrolling; s.UserCode = ""; s.VerifyPath = "" })
	enrolCtx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	key, _ := c.keys()
	en, err := c.cfg.Enroller.Enrol(enrolCtx, key, *res.Grant)
	if err != nil {
		// The console already holds a session for this app. A join that did not happen must not leave one
		// behind, nor an unspent grant: end it (signed), and go on with new keys, since the console refuses
		// a signed-out installation's key for good.
		c.abortJoin()
		if !errors.Is(err, context.Canceled) {
			c.fail("this device could not join the network")
		}
		return
	}
	en.Account = res.Account.Username
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
		s.Account = en.Account
	})
}

// abortJoin ends the console session of an app that did not finish joining and replaces its keys.
func (c *Core) abortJoin() {
	if tok, err := c.loadToken(); err == nil {
		_, sign := c.keys()
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		_ = c.cfg.Console.SignOut(ctx, tok.AccessToken, sign)
		cancel()
	}
	_ = c.cfg.Store.DeleteKey(aliasToken)
	_ = c.rotateKeys()
}

func (c *Core) storeToken(t AppToken) error {
	raw, _ := json.Marshal(storedToken{AppToken: t, IssuedAt: time.Now().Unix()})
	return c.cfg.Store.StoreKey(aliasToken, raw)
}

func (c *Core) loadToken() (*storedToken, error) {
	raw, err := c.cfg.Store.LoadKey(aliasToken)
	if err != nil {
		return nil, err
	}
	var t storedToken
	if err := json.Unmarshal(raw, &t); err != nil {
		return nil, err
	}
	return &t, nil
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

// RefreshNow rotates the app token. A network failure changes nothing, so the next try uses the same
// token, and a plain refusal (a signature the console did not accept, for example for a wrong clock)
// changes nothing either. When the console says it ended the approval, what is kept depends on why:
//   - suspended: something that can be put right (a blocked device, a changed password, an expired
//     lifetime). The installation and its keys are still good: they are kept and the person is asked
//     to sign in again, which brings the same device back.
//   - revoked: removed by the person or an administrator. Everything is forgotten and the keys are
//     replaced, since the console refuses that key for good.
func (c *Core) RefreshNow(ctx context.Context) error {
	c.ops.Lock()
	defer c.ops.Unlock()
	tok, err := c.loadToken()
	if err != nil {
		return errors.New("not signed in")
	}
	_, sign := c.keys()
	fresh, err := c.cfg.Console.Refresh(ctx, tok.RefreshToken, sign)
	if err != nil {
		var ce *ConsoleError
		if errors.As(err, &ce) && ce.Status == 401 {
			switch ce.Code {
			case "app_revoked":
				if ferr := c.forget("This device was removed from your account. Install the app again to sign in."); ferr != nil {
					return ferr
				}
				if rerr := c.rotateKeys(); rerr != nil {
					return rerr
				}
			case "app_suspended":
				if ferr := c.forget("Your approval ended. Sign in again to continue."); ferr != nil {
					return ferr
				}
			}
		}
		return err
	}
	return c.storeToken(*fresh)
}

// Run keeps the token fresh until ctx ends: it refreshes when 80% of the access token's life is
// gone, and tries again a minute after a failure.
func (c *Core) Run(ctx context.Context) {
	sleep := c.cfg.Sleep
	if sleep == nil {
		sleep = sleepCtx
	}
	for {
		wait := time.Minute
		if tok, err := c.loadToken(); err == nil {
			age := time.Since(time.Unix(tok.IssuedAt, 0))
			due := time.Duration(tok.ExpiresIn) * time.Second * 8 / 10
			if age >= due {
				if err := c.RefreshNow(ctx); err != nil && ctx.Err() == nil {
					wait = time.Minute
				} else {
					wait = time.Second
				}
			} else {
				wait = due - age
			}
		}
		if err := sleep(ctx, wait); err != nil {
			return
		}
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
	key, _ := c.keys()
	c.hub.Update(func(s *State) { s.Phase = PhaseConnecting; s.Message = ""; s.Skipped = nil; s.Failed = nil })
	res, err := Walk(ctx, st.Order, c.cfg.Tunnel.Available, func(actx context.Context, m Method) error {
		return c.cfg.Tunnel.Up(actx, UpRequest{Method: m, Exit: st.Exit, Key: key, NodeID: st.NodeID})
	}, c.cfg.PerAttempt)
	if errors.Is(err, ErrRevoked) {
		_ = c.forget("This device was removed from your account. Install the app again to sign in.")
		_ = c.rotateKeys()
		return ErrRevoked
	}
	if errors.Is(err, ErrSuspended) {
		// Recoverable: the keys stay, the person is asked to approve this installation again.
		_ = c.forget("Your approval ended. Sign in again to continue.")
		return ErrSuspended
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

// Disconnect brings the tunnel down. A signed-out app stays signed out: disconnecting must not
// make it look like it has a node to connect.
func (c *Core) Disconnect(ctx context.Context) error {
	c.ops.Lock()
	defer c.ops.Unlock()
	if err := c.cfg.Tunnel.Down(ctx); err != nil {
		return err
	}
	c.hub.Update(func(s *State) {
		s.Method = ""
		s.KillSwitch = c.cfg.Tunnel.KillSwitch()
		if s.NodeID != "" && (s.Phase == PhaseConnected || s.Phase == PhaseConnecting || s.Phase == PhaseFailed) {
			s.Phase = PhaseDisconnected
		}
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

// SignOut stops a sign-in in progress and waits for it, brings the tunnel down, ends the session at
// the console (which also removes this device's node there), and forgets the sign-in here. The
// installation keys are replaced: the console refuses a signed-out installation's key for good, so
// the next sign-in must come from new ones.
//
// If the console cannot be reached the sign-in is kept and an error returned, so that nothing looks
// signed out here while the console still holds a live session; force signs out locally anyway.
func (c *Core) SignOut(ctx context.Context, force bool) error {
	c.ops.Lock()
	defer c.ops.Unlock()
	c.CancelSignIn()
	select {
	case <-c.flowDone():
	case <-ctx.Done():
		return ctx.Err()
	}
	if tok, err := c.loadToken(); err == nil {
		_, sign := c.keys()
		if err := c.cfg.Console.SignOut(ctx, tok.AccessToken, sign); err != nil && !force {
			return fmt.Errorf("the console could not end this sign-in: %w", err)
		}
	}
	_ = c.cfg.Tunnel.Down(ctx)
	if err := c.forget(""); err != nil {
		return err
	}
	return c.rotateKeys()
}

// rotateKeys replaces both installation keys. It fails loudly if an old key cannot be removed from the
// key store: carrying on would sign in again with a key the console has refused for good.
func (c *Core) rotateKeys() error {
	for _, alias := range []string{aliasInstallation, aliasSigning} {
		if err := c.cfg.Store.DeleteKey(alias); err != nil && !errors.Is(err, keystore.ErrKeyNotFound) {
			return fmt.Errorf("clientcore: could not remove the old %s: %w", alias, err)
		}
	}
	key, err := loadOrCreateKey(c.cfg.Store)
	if err != nil {
		return err
	}
	sign, err := loadOrCreateSigningKey(c.cfg.Store)
	if err != nil {
		return err
	}
	c.mu.Lock()
	c.key, c.sign = key, sign
	c.mu.Unlock()
	return nil
}

func (c *Core) forget(msg string) error {
	var failed error
	for _, alias := range []string{aliasToken, aliasEnrolment} {
		if err := c.cfg.Store.DeleteKey(alias); err != nil && !errors.Is(err, keystore.ErrKeyNotFound) && failed == nil {
			failed = fmt.Errorf("clientcore: could not remove %s: %w", alias, err)
		}
	}
	c.hub.Update(func(s *State) {
		s.Phase = PhaseSignedOut
		s.Message = msg
		s.NodeID, s.Overlay, s.Method, s.UserCode, s.VerifyPath, s.Account = "", "", "", "", "", ""
		s.KillSwitch = c.cfg.Tunnel.KillSwitch()
	})
	return failed
}
