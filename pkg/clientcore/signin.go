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
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
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
	Platform     string   `json:"platform"`
	DeviceName   string   `json:"device_name"`
	PublicKeyHex string   `json:"public_key_hex"`
	Scopes       []string `json:"scopes,omitempty"`
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

// PollResult is one answer to a poll. Token and Grant are set only when Status is approved.
type PollResult struct {
	Status   string    `json:"status"`
	Interval int       `json:"interval,omitempty"`
	Token    *AppToken `json:"app_token,omitempty"`
	Grant    *Grant    `json:"enrolment,omitempty"`
}

func (p PollResult) validate() error {
	switch p.Status {
	case "pending", "slow_down", "denied", "expired":
		return nil
	case "approved":
		if p.Token == nil || p.Grant == nil {
			return errors.New("console approved without a token and a grant")
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
	Start(ctx context.Context, req StartRequest) (*DeviceCode, error)
	Poll(ctx context.Context, deviceCode string) (*PollResult, error)
	Refresh(ctx context.Context, refreshToken, publicKeyHex string) (*AppToken, error)
}

// HTTPConsole talks to a console over HTTPS (or HTTP for a loopback or test address).
type HTTPConsole struct {
	base *url.URL
	http *http.Client
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
	return &HTTPConsole{base: u, http: &http.Client{Transport: tr, Timeout: 15 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}, nil
}

func isLoopbackHost(h string) bool {
	return h == "localhost" || h == "127.0.0.1" || h == "::1"
}

func (c *HTTPConsole) post(ctx context.Context, path string, in, out any) error {
	body, err := json.Marshal(in)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.base.String()+path, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
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
	dec := json.NewDecoder(bytes.NewReader(raw))
	return dec.Decode(out)
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
func (c *HTTPConsole) Start(ctx context.Context, req StartRequest) (*DeviceCode, error) {
	if err := req.Validate(); err != nil {
		return nil, err
	}
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

// Refresh rotates the app token. The refresh token sent is spent whatever the outcome:
// a failed call must be followed by a new sign-in, not a retry with the same token.
func (c *HTTPConsole) Refresh(ctx context.Context, refreshToken, publicKeyHex string) (*AppToken, error) {
	if !refreshRe.MatchString(refreshToken) || !hex64.MatchString(publicKeyHex) {
		return nil, errors.New("malformed refresh request")
	}
	var t struct {
		AppToken
		TokenType string `json:"token_type"`
	}
	if err := c.post(ctx, "/api/app-auth/token/refresh", map[string]string{"refresh_token": refreshToken, "public_key_hex": publicKeyHex}, &t); err != nil {
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
