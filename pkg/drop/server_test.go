package drop

import (
	"bytes"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

var testKey = bytes.Repeat([]byte{0x42}, 32)

const testGateway = "node-gw-1"

// sign makes a ticket the way the console does (base64url JSON, HMAC-SHA-256 over the
// domain label and the payload).
func sign(t *testing.T, key []byte, tk Ticket) string {
	t.Helper()
	raw, err := json.Marshal(tk)
	if err != nil {
		t.Fatal(err)
	}
	p := base64.RawURLEncoding.EncodeToString(raw)
	m := hmac.New(sha256.New, key)
	m.Write([]byte(ticketDomain + p))
	return p + "." + base64.RawURLEncoding.EncodeToString(m.Sum(nil))
}

type clock struct {
	mu  sync.Mutex
	now time.Time
}

func (c *clock) Now() time.Time { c.mu.Lock(); defer c.mu.Unlock(); return c.now }
func (c *clock) Add(d time.Duration) {
	c.mu.Lock()
	c.now = c.now.Add(d)
	c.mu.Unlock()
}

type fixture struct {
	t     *testing.T
	dir   string
	clock *clock
	srv   *Server
	http  *httptest.Server
}

func newFixture(t *testing.T, mutate func(*Config)) *fixture {
	t.Helper()
	f := &fixture{t: t, dir: t.TempDir(), clock: &clock{now: time.Unix(1_900_000_000, 0)}}
	cfg := Config{
		Dir:        f.dir,
		MaxBytes:   1 << 20,
		QuotaBytes: 3 << 20,
		MaxTTL:     7 * 24 * time.Hour,
		Key:        func() ([]byte, error) { return testKey, nil },
		NodeID:     func() string { return testGateway },
		Now:        f.clock.Now,
	}
	if mutate != nil {
		mutate(&cfg)
	}
	srv, err := NewServer(cfg)
	if err != nil {
		t.Fatal(err)
	}
	f.srv = srv
	f.http = httptest.NewServer(srv)
	t.Cleanup(f.http.Close)
	return f
}

func newID(t *testing.T) string {
	t.Helper()
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		t.Fatal(err)
	}
	const hexdigits = "0123456789abcdef"
	out := make([]byte, 32)
	for i, v := range b {
		out[2*i], out[2*i+1] = hexdigits[v>>4], hexdigits[v&15]
	}
	return string(out)
}

func (f *fixture) ticket(op, id string, size int64, mutate func(*Ticket)) string {
	now := f.clock.Now().Unix()
	tk := Ticket{V: 1, Op: op, ID: id, Gateway: testGateway, Size: size, Exp: now + 600, DeleteAt: now + 86400}
	if mutate != nil {
		mutate(&tk)
	}
	return sign(f.t, testKey, tk)
}

func (f *fixture) do(method, id, ticket string, body []byte) (*http.Response, []byte) {
	f.t.Helper()
	var r io.Reader
	if body != nil {
		r = bytes.NewReader(body)
	}
	req, err := http.NewRequest(method, f.http.URL+PathPrefix+id, r)
	if err != nil {
		f.t.Fatal(err)
	}
	if ticket != "" {
		req.Header.Set("Authorization", AuthScheme+" "+ticket)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		f.t.Fatal(err)
	}
	defer res.Body.Close()
	out, _ := io.ReadAll(res.Body)
	return res, out
}

func (f *fixture) put(id string, body []byte, mutate func(*Ticket)) int {
	f.t.Helper()
	res, _ := f.do(http.MethodPut, id, f.ticket(OpPut, id, int64(len(body)), mutate), body)
	return res.StatusCode
}

func (f *fixture) files() []string {
	f.t.Helper()
	entries, err := os.ReadDir(f.dir)
	if err != nil {
		f.t.Fatal(err)
	}
	var names []string
	for _, e := range entries {
		names = append(names, e.Name())
	}
	return names
}

func randomBytes(t *testing.T, n int) []byte {
	t.Helper()
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		t.Fatal(err)
	}
	return b
}

func TestUploadThenDownloadWithTickets(t *testing.T) {
	f := newFixture(t, nil)
	id := newID(t)
	body := randomBytes(t, 300_000)
	if code := f.put(id, body, nil); code != http.StatusCreated {
		t.Fatalf("upload: %d", code)
	}
	res, got := f.do(http.MethodGet, id, f.ticket(OpGet, id, int64(len(body)), nil), nil)
	if res.StatusCode != http.StatusOK || !bytes.Equal(got, body) {
		t.Fatalf("download: %d, %d bytes, equal=%v", res.StatusCode, len(got), bytes.Equal(got, body))
	}
	if cc := res.Header.Get("Cache-Control"); cc != "no-store" {
		t.Errorf("Cache-Control %q", cc)
	}
	if ct := res.Header.Get("Content-Type"); ct != "application/octet-stream" {
		t.Errorf("Content-Type %q", ct)
	}
}

func TestNothingIsServedOrStoredWithoutAValidTicket(t *testing.T) {
	f := newFixture(t, nil)
	id := newID(t)
	body := randomBytes(t, 1000)
	if code := f.put(id, body, nil); code != http.StatusCreated {
		t.Fatalf("setup upload: %d", code)
	}
	other := newID(t)
	now := f.clock.Now().Unix()
	cases := map[string]struct {
		method, id, ticket string
		body               []byte
	}{
		"get, no ticket":            {http.MethodGet, id, "", nil},
		"get unknown id, no ticket": {http.MethodGet, other, "", nil},
		"put, no ticket":            {http.MethodPut, other, "", body},
		"get, garbage":              {http.MethodGet, id, "not-a-ticket", nil},
		"get, other key":            {http.MethodGet, id, sign(t, bytes.Repeat([]byte{1}, 32), Ticket{V: 1, Op: OpGet, ID: id, Gateway: testGateway, Exp: now + 60}), nil},
		"get, expired":              {http.MethodGet, id, f.ticket(OpGet, id, 0, func(tk *Ticket) { tk.Exp = now - 1 }), nil},
		"get, other gateway":        {http.MethodGet, id, f.ticket(OpGet, id, 0, func(tk *Ticket) { tk.Gateway = "node-gw-2" }), nil},
		"get, other transfer":       {http.MethodGet, id, f.ticket(OpGet, other, 0, nil), nil},
		"get with an upload ticket": {http.MethodGet, id, f.ticket(OpPut, id, 1000, nil), nil},
		"put with a download one":   {http.MethodPut, other, f.ticket(OpGet, other, 1000, nil), body},
		"get, version 2":            {http.MethodGet, id, f.ticket(OpGet, id, 0, func(tk *Ticket) { tk.V = 2 }), nil},
	}
	for name, c := range cases {
		res, out := f.do(c.method, c.id, c.ticket, c.body)
		if res.StatusCode != http.StatusUnauthorized {
			t.Errorf("%s: status %d", name, res.StatusCode)
		}
		if bytes.Contains(out, body[:16]) {
			t.Errorf("%s: answer carries stored bytes", name)
		}
	}
	if _, err := os.Stat(filepath.Join(f.dir, other+blobSuffix)); !os.IsNotExist(err) {
		t.Fatalf("a refused upload left a file: %v", err)
	}
}

func TestAWrongPathOrMethodIsNotFound(t *testing.T) {
	f := newFixture(t, nil)
	for _, path := range []string{"/", PathPrefix, PathPrefix + "../etc/passwd", PathPrefix + "ABCDEF0123456789abcdef0123456789", "/other/" + newID(t)} {
		res, err := http.Get(f.http.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		if res.StatusCode != http.StatusNotFound {
			t.Errorf("%s: %d", path, res.StatusCode)
		}
	}
	id := newID(t)
	res, _ := f.do(http.MethodPost, id, f.ticket(OpPut, id, 1, nil), []byte{1})
	if res.StatusCode != http.StatusMethodNotAllowed {
		t.Errorf("POST: %d", res.StatusCode)
	}
}

func TestUploadMustBeExactlyTheTicketedSize(t *testing.T) {
	f := newFixture(t, nil)
	id := newID(t)
	body := randomBytes(t, 5000)
	for name, n := range map[string]int64{"short": 5001, "long": 4999} {
		res, _ := f.do(http.MethodPut, id, f.ticket(OpPut, id, n, nil), body)
		if res.StatusCode != http.StatusBadRequest {
			t.Errorf("%s: %d", name, res.StatusCode)
		}
	}
	if left := f.files(); len(left) != 0 {
		t.Fatalf("a refused upload left %v", left)
	}
}

func TestATransferIsWrittenOnce(t *testing.T) {
	f := newFixture(t, nil)
	id := newID(t)
	if code := f.put(id, randomBytes(t, 10), nil); code != http.StatusCreated {
		t.Fatal(code)
	}
	if code := f.put(id, randomBytes(t, 10), nil); code != http.StatusConflict {
		t.Fatalf("second upload: %d", code)
	}
}

func TestSizeLimitAndQuota(t *testing.T) {
	f := newFixture(t, nil) // 1 MiB per transfer, 3 MiB in all
	if code := f.put(newID(t), randomBytes(t, 1<<20+1), nil); code != http.StatusRequestEntityTooLarge {
		t.Fatalf("over the per-transfer limit: %d", code)
	}
	for i := 0; i < 3; i++ {
		if code := f.put(newID(t), randomBytes(t, 1<<20), nil); code != http.StatusCreated {
			t.Fatalf("upload %d within quota: %d", i, code)
		}
	}
	if code := f.put(newID(t), randomBytes(t, 1), nil); code != http.StatusInsufficientStorage {
		t.Fatalf("over quota: %d", code)
	}
}

func TestOneTimeTransferIsDeletedAfterACompleteDownload(t *testing.T) {
	f := newFixture(t, nil)
	id := newID(t)
	body := randomBytes(t, 4096)
	if code := f.put(id, body, func(tk *Ticket) { tk.Once = true }); code != http.StatusCreated {
		t.Fatal(code)
	}
	get := f.ticket(OpGet, id, int64(len(body)), nil)
	res, got := f.do(http.MethodGet, id, get, nil)
	if res.StatusCode != http.StatusOK || !bytes.Equal(got, body) {
		t.Fatalf("first download: %d", res.StatusCode)
	}
	// The handler deletes after the last byte is written, which the client may read
	// first: wait for it rather than race it.
	deadline := time.Now().Add(2 * time.Second)
	for len(f.files()) != 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if left := f.files(); len(left) != 0 {
		t.Fatalf("after a one-time download the mailbox still holds %v", left)
	}
	if res, _ := f.do(http.MethodGet, id, get, nil); res.StatusCode != http.StatusNotFound {
		t.Fatalf("second download: %d", res.StatusCode)
	}
}

func TestAReusableTransferStaysUntilItExpires(t *testing.T) {
	f := newFixture(t, nil)
	id := newID(t)
	body := randomBytes(t, 2048)
	if code := f.put(id, body, nil); code != http.StatusCreated {
		t.Fatal(code)
	}
	for i := 0; i < 2; i++ {
		res, got := f.do(http.MethodGet, id, f.ticket(OpGet, id, 0, nil), nil)
		if res.StatusCode != http.StatusOK || !bytes.Equal(got, body) {
			t.Fatalf("download %d: %d", i, res.StatusCode)
		}
	}
	f.clock.Add(24*time.Hour + time.Second)
	// Expired but not yet swept: never served.
	if res, _ := f.do(http.MethodGet, id, f.ticket(OpGet, id, 0, nil), nil); res.StatusCode != http.StatusNotFound {
		t.Fatalf("expired transfer served: %d", res.StatusCode)
	}
	if removed := f.srv.Sweep(); removed != 1 {
		t.Fatalf("sweep removed %d", removed)
	}
	if left := f.files(); len(left) != 0 {
		t.Fatalf("after expiry the mailbox still holds %v", left)
	}
}

func TestTheGatewayCapsTheLifetime(t *testing.T) {
	f := newFixture(t, func(c *Config) { c.MaxTTL = time.Hour })
	id := newID(t)
	if code := f.put(id, randomBytes(t, 10), func(tk *Ticket) { tk.DeleteAt = f.clock.Now().Unix() + 30*86400 }); code != http.StatusCreated {
		t.Fatal(code)
	}
	f.clock.Add(time.Hour + time.Second)
	if removed := f.srv.Sweep(); removed != 1 {
		t.Fatalf("a transfer asking for 30 days outlived the gateway's 1 h cap (removed %d)", removed)
	}
}

func TestADeleteAtInThePastIsRefused(t *testing.T) {
	f := newFixture(t, nil)
	if code := f.put(newID(t), randomBytes(t, 10), func(tk *Ticket) { tk.DeleteAt = f.clock.Now().Unix() - 1 }); code != http.StatusBadRequest {
		t.Fatalf("status %d", code)
	}
}

func TestSweepRemovesLeftoverPartialUploads(t *testing.T) {
	f := newFixture(t, nil)
	partial := filepath.Join(f.dir, newID(t)+partSuffix)
	if err := os.WriteFile(partial, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	old := f.clock.Now().Add(-2 * time.Hour)
	if err := os.Chtimes(partial, old, old); err != nil {
		t.Fatal(err)
	}
	f.srv.Sweep()
	if _, err := os.Stat(partial); !os.IsNotExist(err) {
		t.Fatalf("a stale partial upload survived the sweep: %v", err)
	}
}

func TestQuotaCountsWhatIsAlreadyOnDiskAtStart(t *testing.T) {
	f := newFixture(t, nil)
	for i := 0; i < 3; i++ {
		if code := f.put(newID(t), randomBytes(t, 1<<20), nil); code != http.StatusCreated {
			t.Fatal(code)
		}
	}
	// A restart: a new server on the same directory.
	again, err := NewServer(f.srv.cfg)
	if err != nil {
		t.Fatal(err)
	}
	h := httptest.NewServer(again)
	defer h.Close()
	id := newID(t)
	req, _ := http.NewRequest(http.MethodPut, h.URL+PathPrefix+id, strings.NewReader("x"))
	req.Header.Set("Authorization", AuthScheme+" "+f.ticket(OpPut, id, 1, nil))
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusInsufficientStorage {
		t.Fatalf("after a restart the quota forgot the stored transfers: %d", res.StatusCode)
	}
}

func TestNewServerNeedsADirectoryAndAKey(t *testing.T) {
	if _, err := NewServer(Config{Key: func() ([]byte, error) { return testKey, nil }, NodeID: func() string { return "x" }}); err == nil {
		t.Error("no directory accepted")
	}
	if _, err := NewServer(Config{Dir: t.TempDir(), NodeID: func() string { return "x" }}); err == nil {
		t.Error("no key source accepted")
	}
}
