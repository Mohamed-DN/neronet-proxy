// Package clientcore is the one core under every NeroNet app (ADR 0040): sign-in by device
// code, enrolment as a mesh node, the connection order walk, the state the interfaces show,
// and a small versioned local API that is the only way an interface reaches it.
//
// It owns no network code of its own for the tunnel: starting and stopping the tunnel is the
// Tunnel interface, implemented with the node agent's data plane. What is here is what must
// be the same on Windows, macOS, Linux, Android and iOS.
package clientcore

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/sovereign/proxy/v4/pkg/control"
	"github.com/sovereign/proxy/v4/pkg/crypto"
)

// Platforms the console accepts, in the console's own words.
var platforms = map[string]bool{"windows": true, "macos": true, "linux": true, "android": true, "ios": true}

// maxResponseBytes bounds what the console may make the client read.
const maxResponseBytes = 1 << 20

var (
	hex64      = regexp.MustCompile(`^[0-9a-f]{64}$`)
	deviceName = regexp.MustCompile(`^[\p{L}\p{N} ._()'-]{1,64}$`)
	userCodeRe = regexp.MustCompile(`^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$`)
)

// Sign-in outcomes the app has to tell apart.
var (
	ErrDenied  = errors.New("the sign-in was denied")
	ErrExpired = errors.New("the sign-in code expired")
)

// StartRequest is what the app tells the console about itself.
type StartRequest struct {
	Platform     string `json:"platform"`
	DeviceName   string `json:"device_name"`
	PublicKeyHex string `json:"public_key_hex"`
	// SigningKeyHex is the installation's Ed25519 public key. Every token refresh is signed with
	// its private half, so a stolen refresh token cannot be used without the device.
	SigningKeyHex string `json:"signing_key"`
	// Nonce and Proof show that the app holds the private half of PublicKeyHex: the console's own
	// challenge, answered with the key. Filled in by Start; a public key alone proves nothing.
	Nonce  string   `json:"nonce"`
	Proof  string   `json:"proof"`
	Scopes []string `json:"scopes,omitempty"`
}

// Validate refuses anything the console would refuse, before it leaves the machine.
func (r StartRequest) Validate() error {
	if !platforms[r.Platform] {
		return fmt.Errorf("unknown platform %q", r.Platform)
	}
	if !deviceName.MatchString(strings.TrimSpace(r.DeviceName)) {
		return errors.New("device name must be 1 to 64 plain characters")
	}
	if !hex64.MatchString(r.PublicKeyHex) {
		return errors.New("installation key must be 64 hex characters")
	}
	if !hex64.MatchString(r.SigningKeyHex) {
		return errors.New("signing key must be 64 hex characters")
	}
	return nil
}

// DeviceCode is the console's answer to a start.
type DeviceCode struct {
	DeviceCode              string `json:"device_code"`
	UserCode                string `json:"user_code"`
	VerificationURI         string `json:"verification_uri"`
	VerificationURIComplete string `json:"verification_uri_complete"`
	Interval                int    `json:"interval"`
	ExpiresIn               int    `json:"expires_in"`
}

func (d DeviceCode) validate() error {
	if !hex64.MatchString(d.DeviceCode) {
		return errors.New("console sent a malformed device code")
	}
	if !userCodeRe.MatchString(d.UserCode) {
		return errors.New("console sent a malformed user code")
	}
	// A path on the console, never another host: the person is told to open it there.
	if !strings.HasPrefix(d.VerificationURI, "/") || strings.HasPrefix(d.VerificationURI, "//") {
		return errors.New("console sent a verification address that is not a path")
	}
	// The complete address is the same path with the code in the fragment, never a query: a fragment
	// never reaches a server or a proxy log.
	if !strings.HasPrefix(d.VerificationURIComplete, d.VerificationURI) || strings.ContainsAny(d.VerificationURIComplete, "?\\ \r\n\t") {
		return errors.New("console sent a complete verification address that is not its path with a fragment")
	}
	if d.Interval < 1 || d.Interval > 60 || d.ExpiresIn < 1 || d.ExpiresIn > 3600 {
		return errors.New("console sent an interval or expiry out of range")
	}
	return nil
}

// AppToken is the credential the app keeps in the system key store.
type AppToken struct {
	AccessToken      string   `json:"access_token"`
	ExpiresIn        int      `json:"expires_in"`
	RefreshToken     string   `json:"refresh_token"`
	RefreshExpiresIn int      `json:"refresh_expires_in"`
	Scopes           []string `json:"scopes"`
}

// Grant is the single-use permission to enrol exactly one node.
type Grant struct {
	PreauthKey string `json:"preauth_key"`
	NodeID     string `json:"node_id"`
	Role       string `json:"role"`
}

var (
	accessRe  = regexp.MustCompile(`^nna_[0-9a-f]{64}$`)
	refreshRe = regexp.MustCompile(`^nnr_[0-9a-f]{64}$`)
	grantRe   = regexp.MustCompile(`^nnk1_[0-9a-f]{64}$`)
	nodeIDRe  = regexp.MustCompile(`^pk_[0-9a-f]{16}$`)
)

// Account is who approved: shown to the person on the app so they can see which account joined.
type Account struct {
	Username       string `json:"username"`
	OrganizationID string `json:"organization_id"`
}

// PollResult is one answer to a poll. Token and Grant are set only when Status is approved.
type PollResult struct {
	Status   string    `json:"status"`
	Interval int       `json:"interval,omitempty"`
	Token    *AppToken `json:"app_token,omitempty"`
	Grant    *Grant    `json:"enrolment,omitempty"`
	Account  *Account  `json:"account,omitempty"`
}

func (p PollResult) validate() error {
	switch p.Status {
	case "pending", "slow_down", "denied", "expired":
		return nil
	case "approved":
		if p.Token == nil || p.Grant == nil || p.Account == nil {
			return errors.New("console approved without a token, a grant and an account")
		}
		if n := len(p.Account.Username); n < 1 || n > 128 {
			return errors.New("console sent an account name out of range")
		}
		if !accessRe.MatchString(p.Token.AccessToken) || !refreshRe.MatchString(p.Token.RefreshToken) {
			return errors.New("console sent a malformed app token")
		}
		if !grantRe.MatchString(p.Grant.PreauthKey) || !nodeIDRe.MatchString(p.Grant.NodeID) {
			return errors.New("console sent a malformed enrolment grant")
		}
		return nil
	}
	return fmt.Errorf("console sent an unknown sign-in status %q", p.Status)
}

// Console is the console's public sign-in surface.
type Console interface {
	// Start asks for a code. key is the installation key, which proves possession at the console.
	Start(ctx context.Context, req StartRequest, key *crypto.Keypair) (*DeviceCode, error)
	// SignOut ends the app's session at the console, which also removes its node there.
	SignOut(ctx context.Context, accessToken string) error
	// VerifyURL turns the console's verification path into the address to show a person, and refuses
	// anything that is not a path on the console itself.
	VerifyURL(path string) (string, error)
	Poll(ctx context.Context, deviceCode string) (*PollResult, error)
	Refresh(ctx context.Context, refreshToken string, key ed25519.PrivateKey) (*AppToken, error)
}

// HTTPConsole talks to a console over HTTPS (or HTTP for a loopback or test address).
type HTTPConsole struct {
	base *url.URL
	http *http.Client
	ctl  *control.Client
}

// NewHTTPConsole builds a client for a console base URL. caPEM, when given, is the only
// trust root, as for the node agent; without it the system roots apply. Plain http is
// accepted only for a loopback host, so a token is never sent in clear across a network.
func NewHTTPConsole(baseURL string, caPEM []byte) (*HTTPConsole, error) {
	u, err := url.Parse(strings.TrimRight(baseURL, "/"))
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return nil, errors.New("console address is not a usable URL")
	}
	switch u.Scheme {
	case "https":
	case "http":
		if !isLoopbackHost(u.Hostname()) {
			return nil, errors.New("console address must be https unless it is this machine")
		}
	default:
		return nil, errors.New("console address must be https")
	}
	tr := &http.Transport{TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS12}, DisableKeepAlives: true}
	if len(caPEM) > 0 {
		pool := x509.NewCertPool()
		if !pool.AppendCertsFromPEM(caPEM) {
			return nil, errors.New("console CA is not valid PEM")
		}
		tr.TLSClientConfig.RootCAs = pool
	}
	var ctl *control.Client
	if len(caPEM) > 0 {
		ctl, err = control.NewClientWithCA(u.String(), caPEM)
		if err != nil {
			return nil, err
		}
	} else {
		ctl = control.NewClient(u.String())
	}
	return &HTTPConsole{base: u, ctl: ctl, http: &http.Client{Transport: tr, Timeout: 15 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}, nil
}

func isLoopbackHost(h string) bool {
	return h == "localhost" || h == "127.0.0.1" || h == "::1"
}

func (c *HTTPConsole) post(ctx context.Context, path string, in, out any) error {
	return c.do(ctx, http.MethodPost, path, "", in, out)
}

func (c *HTTPConsole) do(ctx context.Context, method, path, bearer string, in, out any) error {
	var rdr io.Reader
	if in != nil {
		body, err := json.Marshal(in)
		if err != nil {
			return err
		}
		rdr = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.base.String()+path, rdr)
	if err != nil {
		return err
	}
	if in != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("console unreachable: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes+1))
	if err != nil {
		return err
	}
	if len(raw) > maxResponseBytes {
		return errors.New("console answer too large")
	}
	if resp.StatusCode == http.StatusTooManyRequests {
		return ErrRateLimited
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		var e struct {
			Code string `json:"code"`
		}
		_ = json.Unmarshal(raw, &e)
		return &ConsoleError{Status: resp.StatusCode, Code: e.Code}
	}
	if out == nil {
		return nil
	}
	return json.NewDecoder(bytes.NewReader(raw)).Decode(out)
}

// SignOut ends the app's session. A session the console no longer knows (401, 404) is already
// ended, which is the outcome asked for.
func (c *HTTPConsole) SignOut(ctx context.Context, accessToken string) error {
	if !accessRe.MatchString(accessToken) {
		return errors.New("malformed app token")
	}
	err := c.do(ctx, http.MethodDelete, "/api/app-auth/app/session", accessToken, nil, nil)
	var ce *ConsoleError
	if errors.As(err, &ce) && (ce.Status == http.StatusUnauthorized || ce.Status == http.StatusNotFound) {
		return nil
	}
	return err
}

// VerifyURL is the address a person opens to approve this app: the console's own origin and the
// console's path, with the code in the fragment. Anything that could lead elsewhere is refused.
func (c *HTTPConsole) VerifyURL(path string) (string, error) {
	if !strings.HasPrefix(path, "/") || strings.HasPrefix(path, "//") || strings.ContainsAny(path, "?\\ \r\n\t") {
		return "", errors.New("verification address is not a plain path on the console")
	}
	u, err := url.Parse(c.base.String() + path)
	if err != nil || u.Host != c.base.Host || u.Scheme != c.base.Scheme || u.User != nil {
		return "", errors.New("verification address leaves the console")
	}
	return u.String(), nil
}

// ErrRateLimited is returned when the console asks the app to slow down.
var ErrRateLimited = errors.New("console is rate limiting this app")

// ConsoleError is a refusal by the console. Its text carries no body, only the status and code.
type ConsoleError struct {
	Status int
	Code   string
}

func (e *ConsoleError) Error() string {
	if e.Code != "" {
		return fmt.Sprintf("console refused (%d %s)", e.Status, e.Code)
	}
	return fmt.Sprintf("console refused (%d)", e.Status)
}

// Start asks for a device code.
func (c *HTTPConsole) Start(ctx context.Context, req StartRequest, key *crypto.Keypair) (*DeviceCode, error) {
	if err := req.Validate(); err != nil {
		return nil, err
	}
	if key == nil || req.PublicKeyHex != hex.EncodeToString(key.PublicKey[:]) {
		return nil, errors.New("the key pair is not the installation key the request names")
	}
	nonce, proof, err := c.ctl.ProveKey(ctx, key.PrivateKey, key.PublicKey, "APP_SIGNIN")
	if err != nil {
		return nil, err
	}
	req.Nonce, req.Proof = nonce, proof
	var d DeviceCode
	if err := c.post(ctx, "/api/app-auth/device/start", req, &d); err != nil {
		return nil, err
	}
	if err := d.validate(); err != nil {
		return nil, err
	}
	return &d, nil
}

// Poll asks whether the person approved.
func (c *HTTPConsole) Poll(ctx context.Context, deviceCode string) (*PollResult, error) {
	if !hex64.MatchString(deviceCode) {
		return nil, errors.New("malformed device code")
	}
	var p PollResult
	err := c.post(ctx, "/api/app-auth/device/poll", map[string]string{"device_code": deviceCode}, &p)
	if err != nil {
		return nil, err
	}
	if err := p.validate(); err != nil {
		return nil, err
	}
	return &p, nil
}

// RefreshMessage is exactly what an installation signs to refresh: the method, the path, the
// hash of the refresh token (never the token), the time and a random nonce.
func RefreshMessage(refreshToken string, timestamp int64, nonce string) []byte {
	sum := sha256.Sum256([]byte(refreshToken))
	return []byte(strings.Join([]string{
		"NERONET-APP-REFRESH-V1", "POST", "/api/app-auth/token/refresh",
		hex.EncodeToString(sum[:]), fmt.Sprint(timestamp), nonce,
	}, "\n"))
}

// Refresh rotates the app token with a request signed by the installation's key. The refresh
// token sent is spent whatever the outcome unless the answer never arrives, in which case the
// console accepts one signed retry within a minute; any other reuse signs the app out.
func (c *HTTPConsole) Refresh(ctx context.Context, refreshToken string, key ed25519.PrivateKey) (*AppToken, error) {
	if !refreshRe.MatchString(refreshToken) || len(key) != ed25519.PrivateKeySize {
		return nil, errors.New("malformed refresh request")
	}
	nb := make([]byte, 16)
	if _, err := rand.Read(nb); err != nil {
		return nil, err
	}
	nonce := hex.EncodeToString(nb)
	ts := time.Now().Unix()
	sig := ed25519.Sign(key, RefreshMessage(refreshToken, ts, nonce))
	var t struct {
		AppToken
		TokenType string `json:"token_type"`
	}
	req := map[string]any{"refresh_token": refreshToken, "timestamp": ts, "nonce": nonce, "signature": hex.EncodeToString(sig)}
	if err := c.post(ctx, "/api/app-auth/token/refresh", req, &t); err != nil {
		return nil, err
	}
	if !accessRe.MatchString(t.AccessToken) || !refreshRe.MatchString(t.RefreshToken) {
		return nil, errors.New("console sent a malformed app token")
	}
	tok := t.AppToken
	return &tok, nil
}

// WaitApproved polls until the person decides, honouring the console's interval and
// slow_down answers, until the code expires or ctx ends. sleep is
// replaceable so tests need not wait; nil means a real, cancellable sleep.
func WaitApproved(ctx context.Context, c Console, dc *DeviceCode, sleep func(context.Context, time.Duration) error) (*PollResult, error) {
	if sleep == nil {
		sleep = sleepCtx
	}
	interval := time.Duration(dc.Interval) * time.Second
	deadline := time.Now().Add(time.Duration(dc.ExpiresIn) * time.Second)
	for {
		if err := sleep(ctx, interval); err != nil {
			return nil, err
		}
		if time.Now().After(deadline) {
			return nil, ErrExpired
		}
		res, err := c.Poll(ctx, dc.DeviceCode)
		if err != nil {
			if errors.Is(err, ErrRateLimited) {
				interval += 5 * time.Second
				continue
			}
			return nil, err
		}
		switch res.Status {
		case "approved":
			return res, nil
		case "denied":
			return nil, ErrDenied
		case "expired":
			return nil, ErrExpired
		case "slow_down":
			if res.Interval > 0 && res.Interval <= 60 {
				interval = time.Duration(res.Interval) * time.Second
			} else {
				interval += 5 * time.Second
			}
		}
	}
}

func sleepCtx(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}
