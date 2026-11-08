package derpwire

import (
	"context"
	"crypto/tls"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sync"
	"time"
)

// AdmissionSnapshot is service-only control-plane data. Its expiry is absolute:
// repeatedly failing to refresh cannot prolong the cached authority.
type AdmissionSnapshot struct {
	Keys                []string `json:"keys"`
	GeneratedAtUnix     int64    `json:"generated_at_unix"`
	MaxStalenessSeconds int64    `json:"max_staleness_seconds"`
}

type AdmissionCache struct {
	mu              sync.RWMutex
	endpoint, token string
	client          *http.Client
	keys            map[[32]byte]bool
	expires         time.Time
	invalidated     bool
	onInvalidate    func()
}

func NewAdmissionCache(endpoint, token string, roots *tls.Config, onInvalidate func()) (*AdmissionCache, error) {
	u, err := url.Parse(endpoint)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || token == "" {
		return nil, errors.New("DERP: HTTPS admission endpoint and service credential required")
	}
	if roots != nil && roots.InsecureSkipVerify {
		return nil, errors.New("DERP: admission TLS verification required")
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	if roots != nil {
		transport.TLSClientConfig = roots.Clone()
	}
	return &AdmissionCache{endpoint: endpoint, token: token, client: &http.Client{Transport: transport, Timeout: 5 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}, keys: map[[32]byte]bool{}, onInvalidate: onInvalidate}, nil
}

func (c *AdmissionCache) Allows(k [32]byte) bool {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return time.Now().Before(c.expires) && c.keys[k]
}

func (c *AdmissionCache) Refresh(ctx context.Context) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.endpoint, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	resp, err := c.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("DERP admission: HTTP %d", resp.StatusCode)
	}
	var snapshot AdmissionSnapshot
	if err := json.NewDecoder(io.LimitReader(resp.Body, 8<<20)).Decode(&snapshot); err != nil {
		return err
	}
	now := time.Now()
	generated := time.Unix(snapshot.GeneratedAtUnix, 0)
	if snapshot.MaxStalenessSeconds <= 0 || snapshot.MaxStalenessSeconds > 86400 || generated.After(now.Add(30*time.Second)) {
		return errors.New("DERP admission: invalid authority lifetime")
	}
	expires := generated.Add(time.Duration(snapshot.MaxStalenessSeconds) * time.Second)
	if !expires.After(now) {
		return errors.New("DERP admission: expired snapshot")
	}
	keys := make(map[[32]byte]bool, len(snapshot.Keys))
	for _, s := range snapshot.Keys {
		raw, err := hex.DecodeString(s)
		if err != nil || len(raw) != 32 {
			return errors.New("DERP admission: invalid key")
		}
		var k [32]byte
		copy(k[:], raw)
		keys[k] = true
	}
	c.mu.Lock()
	revoked := false
	for k := range c.keys {
		if !keys[k] {
			revoked = true
			break
		}
	}
	c.keys = keys
	c.expires = expires
	c.invalidated = false
	c.mu.Unlock()
	if revoked && c.onInvalidate != nil {
		c.onInvalidate()
	}
	return nil
}

func (c *AdmissionCache) Expire() {
	c.mu.Lock()
	expired := !c.invalidated && !c.expires.IsZero() && !time.Now().Before(c.expires)
	if expired {
		c.invalidated = true
		c.keys = map[[32]byte]bool{}
	}
	c.mu.Unlock()
	if expired && c.onInvalidate != nil {
		c.onInvalidate()
	}
}

// Run refreshes in the background and independently expires sessions while a
// refresh is blocked by an unavailable control plane.
func (c *AdmissionCache) Run(ctx context.Context, interval time.Duration) {
	if interval <= 0 {
		interval = 15 * time.Second
	}
	go func() {
		ticker := time.NewTicker(100 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				c.Expire()
			}
		}
	}()
	for {
		_ = c.Refresh(ctx)
		select {
		case <-ctx.Done():
			return
		case <-time.After(interval):
		}
	}
}
