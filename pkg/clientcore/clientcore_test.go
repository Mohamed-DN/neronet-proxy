package clientcore

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/sovereign/proxy/v4/pkg/crypto"
	"github.com/sovereign/proxy/v4/pkg/keystore"
)

const (
	goodDevice  = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	goodAccess  = "nna_" + goodDevice
	goodRefresh = "nnr_" + goodDevice
	goodGrant   = "nnk1_" + goodDevice
)

// ---- fakes --------------------------------------------------------------------------------

type memStore struct {
	mu sync.Mutex
	m  map[string][]byte
}

func newMemStore() *memStore { return &memStore{m: map[string][]byte{}} }
func (s *memStore) StoreKey(a string, k []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.m[a] = append([]byte(nil), k...)
	return nil
}
func (s *memStore) LoadKey(a string) ([]byte, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if v, ok := s.m[a]; ok {
		return append([]byte(nil), v...), nil
	}
	return nil, keystore.ErrKeyNotFound
}
func (s *memStore) DeleteKey(a string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.m, a)
	return nil
}
func (s *memStore) BackendType() string { return "memory" }

type fakeConsole struct {
	mu       sync.Mutex
	polls    []PollResult
	pollErr  error
	started  []StartRequest
	startErr error
}

func (f *fakeConsole) Start(_ context.Context, r StartRequest) (*DeviceCode, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.started = append(f.started, r)
	if f.startErr != nil {
		return nil, f.startErr
	}
	return &DeviceCode{DeviceCode: goodDevice, UserCode: "ABCD-EFGH", VerificationURI: "/collega", VerificationURIComplete: "/collega?code=ABCD-EFGH", Interval: 1, ExpiresIn: 600}, nil
}
func (f *fakeConsole) Poll(context.Context, string) (*PollResult, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.pollErr != nil {
		return nil, f.pollErr
	}
	if len(f.polls) == 0 {
		return &PollResult{Status: "pending"}, nil
	}
	p := f.polls[0]
	f.polls = f.polls[1:]
	return &p, nil
}
func (f *fakeConsole) Refresh(context.Context, string, string) (*AppToken, error) {
	return nil, errors.New("not used")
}

func approved() PollResult {
	return PollResult{Status: "approved",
		Token: &AppToken{AccessToken: goodAccess, RefreshToken: goodRefresh, ExpiresIn: 3600, RefreshExpiresIn: 86400, Scopes: []string{"app:self"}},
		Grant: &Grant{PreauthKey: goodGrant, NodeID: "pk_0123456789abcdef", Role: "CLIENT_ORIGIN"}}
}

type fakeEnroller struct {
	err    error
	grants []Grant
}

func (f *fakeEnroller) Enrol(_ context.Context, _ *crypto.Keypair, g Grant) (*Enrolment, error) {
	f.grants = append(f.grants, g)
	if f.err != nil {
		return nil, f.err
	}
	return &Enrolment{NodeID: g.NodeID, OverlayIPv4: "100.64.1.2"}, nil
}

type fakeTunnel struct {
	mu        sync.Mutex
	unavail   map[Method]bool
	failures  map[Method]error
	tried     []Method
	up        bool
	exitSeen  string
	killState KillSwitchState
}

func (t *fakeTunnel) Up(ctx context.Context, r UpRequest) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.tried = append(t.tried, r.Method)
	t.exitSeen = r.Exit
	if err := t.failures[r.Method]; err != nil {
		return err
	}
	t.up = true
	return nil
}
func (t *fakeTunnel) Down(context.Context) error {
	t.mu.Lock()
	t.up = false
	t.mu.Unlock()
	return nil
}
func (t *fakeTunnel) Available(m Method) bool { return !t.unavail[m] }
func (t *fakeTunnel) KillSwitch() KillSwitchState {
	if t.killState == "" {
		return KillSwitchUnknown
	}
	return t.killState
}

func instantSleep(ctx context.Context, _ time.Duration) error { return ctx.Err() }

func newCore(t *testing.T, c *fakeConsole, e *fakeEnroller, tun *fakeTunnel) (*Core, *memStore) {
	t.Helper()
	st := newMemStore()
	core, err := New(Config{Platform: "linux", DeviceName: "Test box", Console: c, Enroller: e, Tunnel: tun, Store: st, Sleep: instantSleep, PerAttempt: time.Second})
	if err != nil {
		t.Fatal(err)
	}
	return core, st
}

func waitPhase(t *testing.T, c *Core, want Phase) State {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if s := c.State(); s.Phase == want {
			return s
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("phase never became %s, is %s", want, c.State().Phase)
	return State{}
}

// ---- sign-in client -----------------------------------------------------------------------

func TestStartRequestValidation(t *testing.T) {
	ok := StartRequest{Platform: "linux", DeviceName: "Office laptop", PublicKeyHex: goodDevice}
	if err := ok.Validate(); err != nil {
		t.Fatal(err)
	}
	for name, mut := range map[string]func(*StartRequest){
		"platform": func(r *StartRequest) { r.Platform = "amiga" },
		"name":     func(r *StartRequest) { r.DeviceName = "<b>x</b>" },
		"empty":    func(r *StartRequest) { r.DeviceName = "  " },
		"long":     func(r *StartRequest) { r.DeviceName = strings.Repeat("a", 65) },
		"key":      func(r *StartRequest) { r.PublicKeyHex = "zz" },
	} {
		r := ok
		mut(&r)
		if r.Validate() == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

func TestHTTPConsoleRefusesClearTextAcrossANetwork(t *testing.T) {
	if _, err := NewHTTPConsole("http://console.example.com", nil); err == nil {
		t.Error("plain http to a remote host was accepted")
	}
	if _, err := NewHTTPConsole("http://127.0.0.1:3001", nil); err != nil {
		t.Errorf("loopback http refused: %v", err)
	}
	for _, bad := range []string{"ftp://x", "https://user:pw@x", "https://x?a=b", "", "https://x#f"} {
		if _, err := NewHTTPConsole(bad, nil); err == nil {
			t.Errorf("%q accepted", bad)
		}
	}
}

func consoleServer(t *testing.T, h http.HandlerFunc) *HTTPConsole {
	t.Helper()
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	c, err := NewHTTPConsole(srv.URL, nil)
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func TestHTTPConsoleStartAndPollAgainstTheWireShape(t *testing.T) {
	var gotStart StartRequest
	c := consoleServer(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/app-auth/device/start":
			_ = json.NewDecoder(r.Body).Decode(&gotStart)
			_, _ = fmt.Fprintf(w, `{"device_code":%q,"user_code":"ABCD-EFGH","verification_uri":"/collega","verification_uri_complete":"/collega?code=ABCD-EFGH","interval":5,"expires_in":600,"public_key_hex":%q}`, goodDevice, goodDevice)
		case "/api/app-auth/device/poll":
			_, _ = fmt.Fprintf(w, `{"status":"approved","app_token":{"token_type":"Bearer","access_token":%q,"expires_in":3600,"refresh_token":%q,"refresh_expires_in":86400,"scopes":["app:self"]},"enrolment":{"preauth_key":%q,"node_id":"pk_0123456789abcdef","role":"CLIENT_ORIGIN"},"account":{"username":"x"}}`, goodAccess, goodRefresh, goodGrant)
		default:
			http.NotFound(w, r)
		}
	})
	dc, err := c.Start(context.Background(), StartRequest{Platform: "windows", DeviceName: "Desk PC", PublicKeyHex: goodDevice})
	if err != nil {
		t.Fatal(err)
	}
	if dc.UserCode != "ABCD-EFGH" || gotStart.Platform != "windows" {
		t.Fatalf("unexpected: %+v %+v", dc, gotStart)
	}
	res, err := c.Poll(context.Background(), dc.DeviceCode)
	if err != nil || res.Status != "approved" || res.Grant.NodeID != "pk_0123456789abcdef" {
		t.Fatalf("poll: %+v %v", res, err)
	}
}

func TestHTTPConsoleRejectsAHostileAnswer(t *testing.T) {
	cases := map[string]string{
		"verification on another host": `{"device_code":"` + goodDevice + `","user_code":"ABCD-EFGH","verification_uri":"//evil.example/x","interval":5,"expires_in":600}`,
		"scheme-relative":              `{"device_code":"` + goodDevice + `","user_code":"ABCD-EFGH","verification_uri":"https://evil.example/x","interval":5,"expires_in":600}`,
		"short device code":            `{"device_code":"abc","user_code":"ABCD-EFGH","verification_uri":"/collega","interval":5,"expires_in":600}`,
		"bad user code":                `{"device_code":"` + goodDevice + `","user_code":"hello","verification_uri":"/collega","interval":5,"expires_in":600}`,
		"interval absurd":              `{"device_code":"` + goodDevice + `","user_code":"ABCD-EFGH","verification_uri":"/collega","interval":0,"expires_in":600}`,
		"not json":                     `<html>`,
	}
	for name, body := range cases {
		body := body
		c := consoleServer(t, func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte(body)) })
		if _, err := c.Start(context.Background(), StartRequest{Platform: "linux", DeviceName: "x", PublicKeyHex: goodDevice}); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	// A malformed approved poll is refused as a whole.
	c := consoleServer(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"status":"approved","app_token":{"access_token":"x","refresh_token":"y"},"enrolment":{"preauth_key":"z","node_id":"w"}}`))
	})
	if _, err := c.Poll(context.Background(), goodDevice); err == nil {
		t.Error("malformed approval accepted")
	}
}

func TestHTTPConsoleBoundsWhatItReadsAndSurfacesRateLimits(t *testing.T) {
	big := consoleServer(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(strings.Repeat("a", 2<<20)))
	})
	if _, err := big.Poll(context.Background(), goodDevice); err == nil {
		t.Error("oversize answer accepted")
	}
	limited := consoleServer(t, func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(429) })
	if _, err := limited.Poll(context.Background(), goodDevice); !errors.Is(err, ErrRateLimited) {
		t.Errorf("got %v", err)
	}
	redirect := consoleServer(t, func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "http://127.0.0.1:1/x", http.StatusFound)
	})
	if _, err := redirect.Poll(context.Background(), goodDevice); err == nil {
		t.Error("a redirect was followed or accepted")
	}
}

func TestWaitApprovedHonoursTheConsole(t *testing.T) {
	dc := &DeviceCode{DeviceCode: goodDevice, UserCode: "ABCD-EFGH", VerificationURI: "/collega", Interval: 1, ExpiresIn: 600}
	var slept []time.Duration
	sleep := func(_ context.Context, d time.Duration) error { slept = append(slept, d); return nil }
	f := &fakeConsole{polls: []PollResult{{Status: "pending"}, {Status: "slow_down", Interval: 10}, approved()}}
	res, err := WaitApproved(context.Background(), f, dc, sleep)
	if err != nil || res.Status != "approved" {
		t.Fatalf("%+v %v", res, err)
	}
	if len(slept) != 3 || slept[0] != time.Second || slept[2] != 10*time.Second {
		t.Errorf("did not slow down as asked: %v", slept)
	}
	for status, want := range map[string]error{"denied": ErrDenied, "expired": ErrExpired} {
		f := &fakeConsole{polls: []PollResult{{Status: status}}}
		if _, err := WaitApproved(context.Background(), f, dc, instantSleep); !errors.Is(err, want) {
			t.Errorf("%s: got %v", status, err)
		}
	}
	// A local deadline stops the wait even if the console keeps saying pending.
	short := &DeviceCode{DeviceCode: goodDevice, UserCode: "ABCD-EFGH", VerificationURI: "/collega", Interval: 1, ExpiresIn: 1}
	slow := func(ctx context.Context, d time.Duration) error {
		time.Sleep(1100 * time.Millisecond)
		return ctx.Err()
	}
	if _, err := WaitApproved(context.Background(), &fakeConsole{}, short, slow); !errors.Is(err, ErrExpired) {
		t.Errorf("got %v", err)
	}
}

// ---- connection order ---------------------------------------------------------------------

func TestWalkFallsBackOnceInOrderAndReportsWhy(t *testing.T) {
	var tried []Method
	res, err := Walk(context.Background(), Order{Methods: DefaultOrder}, nil, func(_ context.Context, m Method) error {
		tried = append(tried, m)
		if m == MethodWireGuard {
			return errors.New("udp blocked")
		}
		return nil
	}, time.Second)
	if err != nil || res.Used != MethodWireGuardWSS {
		t.Fatalf("%+v %v", res, err)
	}
	if len(tried) != 2 || res.Failed[MethodWireGuard] != "udp blocked" {
		t.Errorf("tried %v failed %v", tried, res.Failed)
	}
}

func TestWalkIsBounded(t *testing.T) {
	calls := 0
	start := time.Now()
	_, err := Walk(context.Background(), Order{Methods: []Method{MethodWireGuard, MethodWireGuardWSS, MethodAmneziaWG}}, nil, func(ctx context.Context, m Method) error {
		calls++
		<-ctx.Done() // a method that hangs until it is cut off
		return ctx.Err()
	}, 50*time.Millisecond)
	if !errors.Is(err, ErrNoMethod) {
		t.Fatalf("got %v", err)
	}
	if calls != 3 {
		t.Errorf("each method must be tried exactly once, got %d calls", calls)
	}
	if d := time.Since(start); d > 2*time.Second {
		t.Errorf("walk took %v, not bounded by its attempts", d)
	}
}

func TestWalkForcedNeverFallsBack(t *testing.T) {
	var tried []Method
	_, err := Walk(context.Background(), Order{Methods: DefaultOrder, Forced: true}, nil, func(_ context.Context, m Method) error {
		tried = append(tried, m)
		return errors.New("no")
	}, time.Second)
	if !errors.Is(err, ErrNoMethod) || len(tried) != 1 || tried[0] != MethodWireGuard {
		t.Errorf("forced order fell back: %v %v", tried, err)
	}
}

func TestWalkSkipsWhatTheDeviceCannotDoAndSaysSo(t *testing.T) {
	res, err := Walk(context.Background(), Order{Methods: []Method{MethodAmneziaWG, MethodWireGuard}},
		func(m Method) bool { return m != MethodAmneziaWG },
		func(context.Context, Method) error { return nil }, time.Second)
	if err != nil || res.Used != MethodWireGuard || res.Skipped[MethodAmneziaWG] == "" {
		t.Errorf("%+v %v", res, err)
	}
}

func TestWalkStopsWhenCancelled(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := Walk(ctx, Order{Methods: DefaultOrder}, nil, func(context.Context, Method) error { return nil }, time.Second)
	if !errors.Is(err, context.Canceled) {
		t.Errorf("got %v", err)
	}
}

func TestOrderValidation(t *testing.T) {
	for name, o := range map[string]Order{
		"empty":    {},
		"unknown":  {Methods: []Method{"tor"}},
		"repeated": {Methods: []Method{MethodWireGuard, MethodWireGuard}},
		"too many": {Methods: []Method{MethodWireGuard, MethodWireGuardWSS, MethodAmneziaWG, MethodWireGuard}},
	} {
		if o.Validate() == nil {
			t.Errorf("%s accepted", name)
		}
	}
}

// ---- core ---------------------------------------------------------------------------------

func TestSignInEnrolsAndNeverExposesASecret(t *testing.T) {
	cons := &fakeConsole{polls: []PollResult{{Status: "pending"}, approved()}}
	enr := &fakeEnroller{}
	core, store := newCore(t, cons, enr, &fakeTunnel{})
	if core.State().Phase != PhaseSignedOut {
		t.Fatalf("starts %s", core.State().Phase)
	}
	if err := core.SignIn(context.Background()); err != nil {
		t.Fatal(err)
	}
	st := waitPhase(t, core, PhaseDisconnected)
	if st.NodeID != "pk_0123456789abcdef" || st.Overlay != "100.64.1.2" {
		t.Errorf("state: %+v", st)
	}
	if len(enr.grants) != 1 || enr.grants[0].PreauthKey != goodGrant {
		t.Errorf("grant not used once: %+v", enr.grants)
	}
	if cons.started[0].PublicKeyHex != core.PublicKeyHex() {
		t.Error("the console was told a different installation key")
	}
	if _, err := store.LoadKey(aliasToken); err != nil {
		t.Errorf("token not stored: %v", err)
	}
	blob, _ := json.Marshal(core.State())
	for _, secret := range []string{goodAccess, goodRefresh, goodGrant, goodDevice} {
		if strings.Contains(string(blob), secret) {
			t.Errorf("state leaks a secret: %s", secret)
		}
	}
}

func TestSignInDeniedAndEnrolmentFailureLeaveNothingBehind(t *testing.T) {
	core, store := newCore(t, &fakeConsole{polls: []PollResult{{Status: "denied"}}}, &fakeEnroller{}, &fakeTunnel{})
	if err := core.SignIn(context.Background()); err != nil {
		t.Fatal(err)
	}
	waitPhase(t, core, PhaseFailed)
	if _, err := store.LoadKey(aliasToken); err == nil {
		t.Error("a token was stored for a denied sign-in")
	}

	core, store = newCore(t, &fakeConsole{polls: []PollResult{approved()}}, &fakeEnroller{err: errors.New("refused")}, &fakeTunnel{})
	if err := core.SignIn(context.Background()); err != nil {
		t.Fatal(err)
	}
	waitPhase(t, core, PhaseFailed)
	if _, err := store.LoadKey(aliasToken); err == nil {
		t.Error("the token survived a failed enrolment")
	}
	// Failed is not a dead end: a new sign-in may start.
	if err := core.SignIn(context.Background()); err != nil {
		t.Errorf("cannot retry after a failure: %v", err)
	}
	core.CancelSignIn()
	waitPhase(t, core, PhaseSignedOut)
}

func TestSecondSignInWhileOneRunsIsRefused(t *testing.T) {
	core, _ := newCore(t, &fakeConsole{}, &fakeEnroller{}, &fakeTunnel{})
	if err := core.SignIn(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := core.SignIn(context.Background()); err == nil {
		t.Error("two sign-ins ran at once")
	}
	core.CancelSignIn()
	waitPhase(t, core, PhaseSignedOut)
}

func signedInCore(t *testing.T, tun *fakeTunnel) (*Core, *memStore) {
	core, store := newCore(t, &fakeConsole{polls: []PollResult{approved()}}, &fakeEnroller{}, tun)
	if err := core.SignIn(context.Background()); err != nil {
		t.Fatal(err)
	}
	waitPhase(t, core, PhaseDisconnected)
	return core, store
}

func TestConnectWalksTheOrderAndShowsTheKillSwitchTheTunnelReports(t *testing.T) {
	tun := &fakeTunnel{failures: map[Method]error{MethodWireGuard: errors.New("udp blocked")}, killState: KillSwitchArmed}
	core, _ := signedInCore(t, tun)
	if err := core.SetExit("milano"); err != nil {
		t.Fatal(err)
	}
	if err := core.Connect(context.Background()); err != nil {
		t.Fatal(err)
	}
	st := core.State()
	if st.Phase != PhaseConnected || st.Method != MethodWireGuardWSS || st.KillSwitch != KillSwitchArmed {
		t.Errorf("%+v", st)
	}
	if tun.exitSeen != "milano" || len(tun.tried) != 2 {
		t.Errorf("tunnel saw exit %q after %v", tun.exitSeen, tun.tried)
	}
	if st.Failed[MethodWireGuard] == "" {
		t.Error("the failure of the first method is not shown")
	}
	if err := core.Disconnect(context.Background()); err != nil || core.State().Phase != PhaseDisconnected {
		t.Errorf("disconnect: %v %s", err, core.State().Phase)
	}
}

func TestConnectFailsHonestlyWhenNothingWorks(t *testing.T) {
	tun := &fakeTunnel{failures: map[Method]error{MethodWireGuard: errors.New("a"), MethodWireGuardWSS: errors.New("b")}}
	core, _ := signedInCore(t, tun)
	if err := core.Connect(context.Background()); !errors.Is(err, ErrNoMethod) {
		t.Fatalf("got %v", err)
	}
	st := core.State()
	if st.Phase != PhaseFailed || st.KillSwitch != KillSwitchUnknown {
		t.Errorf("%+v", st)
	}
}

func TestARevokedDeviceForgetsItsSignInAndStaysOut(t *testing.T) {
	tun := &fakeTunnel{failures: map[Method]error{MethodWireGuard: ErrRevoked}}
	core, store := signedInCore(t, tun)
	if err := core.Connect(context.Background()); !errors.Is(err, ErrRevoked) {
		t.Fatalf("got %v", err)
	}
	st := core.State()
	if st.Phase != PhaseSignedOut || st.NodeID != "" {
		t.Errorf("%+v", st)
	}
	if len(tun.tried) != 1 {
		t.Errorf("tried %v after being told it was removed; it must not fall back", tun.tried)
	}
	if _, err := store.LoadKey(aliasToken); err == nil {
		t.Error("token kept after revocation")
	}
	if _, err := store.LoadKey(aliasEnrolment); err == nil {
		t.Error("enrolment kept after revocation")
	}
	if err := core.Connect(context.Background()); err == nil {
		t.Error("connect allowed while signed out")
	}
}

func TestStateIsRestoredAfterARestartAndTheKeyIsStable(t *testing.T) {
	core, store := signedInCore(t, &fakeTunnel{})
	key := core.PublicKeyHex()
	again, err := New(Config{Platform: "linux", DeviceName: "Test box", Console: &fakeConsole{}, Enroller: &fakeEnroller{}, Tunnel: &fakeTunnel{}, Store: store})
	if err != nil {
		t.Fatal(err)
	}
	if again.PublicKeyHex() != key {
		t.Error("the installation key changed across a restart")
	}
	if st := again.State(); st.Phase != PhaseDisconnected || st.NodeID == "" {
		t.Errorf("not restored: %+v", st)
	}
}

func TestSetExitAndOrderValidateTheirInput(t *testing.T) {
	core, _ := signedInCore(t, &fakeTunnel{})
	for _, bad := range []string{"Milano", "a b", "-x", "x-", "a/../b", strings.Repeat("a", 64), "xn--ü"} {
		if core.SetExit(bad) == nil {
			t.Errorf("exit %q accepted", bad)
		}
	}
	if core.SetExit("exit-1") != nil || core.SetExit("") != nil {
		t.Error("valid exit refused")
	}
	if core.SetOrder(Order{Methods: []Method{"carrier-pigeon"}}) == nil {
		t.Error("unknown method accepted")
	}
}

func TestStateStreamDeliversTheLatestToASlowWatcher(t *testing.T) {
	h := NewHub(State{Phase: PhaseSignedOut})
	ch, cancel := h.Subscribe()
	defer cancel()
	for i := 0; i < 50; i++ {
		h.Update(func(s *State) { s.Message = fmt.Sprint(i) })
	}
	var last State
	for len(ch) > 0 {
		last = <-ch
	}
	if last.Message != "49" {
		t.Errorf("slow watcher is left with %q", last.Message)
	}
}
