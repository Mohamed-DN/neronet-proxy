package drop

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	DefaultMaxBytes   int64 = 256 << 20
	DefaultQuotaBytes int64 = 2 << 30
	DefaultMaxTTL           = 7 * 24 * time.Hour
	// staleAfter is how long an unfinished upload may sit before the sweep removes it.
	staleAfter = time.Hour
)

var validID = regexp.MustCompile(`^[0-9a-f]{32}$`)

// Config is the mailbox's configuration. Dir, Key and NodeID are required.
type Config struct {
	Dir        string                 // where ciphertext is kept (a persistent volume)
	MaxBytes   int64                  // largest transfer accepted, in ciphertext bytes
	QuotaBytes int64                  // all stored transfers together
	MaxTTL     time.Duration          // longest a transfer is kept, whatever the ticket says
	Key        func() ([]byte, error) // the ticket key (TicketKey); an error answers 503
	NodeID     func() string          // this gateway's node id, as the console knows it
	Now        func() time.Time
}

// Server answers PUT and GET under PathPrefix. It is an http.Handler.
type Server struct {
	cfg  Config
	mu   sync.Mutex
	used int64 // bytes of stored and reserved transfers
}

type meta struct {
	Size     int64 `json:"size"`
	DeleteAt int64 `json:"delete_at"`
	Once     bool  `json:"once"`
}

// NewServer prepares the directory and counts what is already stored there, so the
// quota holds across restarts.
func NewServer(cfg Config) (*Server, error) {
	if cfg.Dir == "" {
		return nil, errors.New("drop: no directory configured")
	}
	if cfg.Key == nil || cfg.NodeID == nil {
		return nil, errors.New("drop: a ticket key source and a node id are required")
	}
	if cfg.MaxBytes <= 0 {
		cfg.MaxBytes = DefaultMaxBytes
	}
	if cfg.QuotaBytes <= 0 {
		cfg.QuotaBytes = DefaultQuotaBytes
	}
	if cfg.MaxTTL <= 0 {
		cfg.MaxTTL = DefaultMaxTTL
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	if err := os.MkdirAll(cfg.Dir, 0o700); err != nil {
		return nil, err
	}
	s := &Server{cfg: cfg}
	entries, err := os.ReadDir(cfg.Dir)
	if err != nil {
		return nil, err
	}
	for _, e := range entries {
		if m, ok := s.readMeta(strings.TrimSuffix(e.Name(), metaSuffix)); ok && strings.HasSuffix(e.Name(), metaSuffix) {
			s.used += m.Size
		}
	}
	return s, nil
}

func (s *Server) path(id, suffix string) string { return filepath.Join(s.cfg.Dir, id+suffix) }

func (s *Server) readMeta(id string) (meta, bool) {
	if !validID.MatchString(id) {
		return meta{}, false
	}
	raw, err := os.ReadFile(s.path(id, metaSuffix))
	if err != nil {
		return meta{}, false
	}
	var m meta
	if json.Unmarshal(raw, &m) != nil || m.Size < 0 {
		return meta{}, false
	}
	return m, true
}

func fail(w http.ResponseWriter, code int) {
	w.Header().Set("Cache-Control", "no-store")
	http.Error(w, http.StatusText(code), code)
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	id, ok := strings.CutPrefix(r.URL.Path, PathPrefix)
	if !ok || !validID.MatchString(id) {
		fail(w, http.StatusNotFound)
		return
	}
	switch r.Method {
	case http.MethodPut:
		s.put(w, r, id)
	case http.MethodGet:
		s.get(w, r, id)
	default:
		w.Header().Set("Allow", "GET, PUT")
		fail(w, http.StatusMethodNotAllowed)
	}
}

// authorize answers the ticket when it is signed by the console, for this gateway, this
// transfer and this operation, and not expired. Any failure is 401 with no detail, and
// is decided before the store is looked at, so a caller without a ticket cannot even
// learn whether a transfer exists.
func (s *Server) authorize(w http.ResponseWriter, r *http.Request, op, id string) (Ticket, bool) {
	scheme, token, _ := strings.Cut(r.Header.Get("Authorization"), " ")
	if scheme != AuthScheme || token == "" {
		fail(w, http.StatusUnauthorized)
		return Ticket{}, false
	}
	key, err := s.cfg.Key()
	if err != nil {
		log.Printf("[DROP] ticket key unavailable: %v", err)
		fail(w, http.StatusServiceUnavailable)
		return Ticket{}, false
	}
	tk, err := ParseTicket(token, key)
	if err != nil || tk.V != 1 || tk.Op != op || tk.ID != id || tk.Gateway == "" ||
		tk.Gateway != s.cfg.NodeID() || tk.Exp <= s.cfg.Now().Unix() {
		fail(w, http.StatusUnauthorized)
		return Ticket{}, false
	}
	return tk, true
}

func (s *Server) reserve(n int64) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.used+n > s.cfg.QuotaBytes {
		return false
	}
	s.used += n
	return true
}

func (s *Server) release(n int64) {
	s.mu.Lock()
	s.used -= n
	s.mu.Unlock()
}

func (s *Server) put(w http.ResponseWriter, r *http.Request, id string) {
	tk, ok := s.authorize(w, r, OpPut, id)
	if !ok {
		return
	}
	now := s.cfg.Now()
	n := tk.Size
	switch {
	case n < 0 || tk.DeleteAt <= now.Unix():
		fail(w, http.StatusBadRequest)
		return
	case n > s.cfg.MaxBytes:
		fail(w, http.StatusRequestEntityTooLarge)
		return
	case r.ContentLength >= 0 && r.ContentLength != n:
		fail(w, http.StatusBadRequest)
		return
	}
	if _, err := os.Stat(s.path(id, metaSuffix)); err == nil {
		fail(w, http.StatusConflict)
		return
	}
	part, err := os.OpenFile(s.path(id, partSuffix), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		fail(w, http.StatusConflict) // another upload of the same transfer is running
		return
	}
	partPath := part.Name()
	if !s.reserve(n) {
		_ = part.Close()
		_ = os.Remove(partPath)
		fail(w, http.StatusInsufficientStorage)
		return
	}
	abort := func(code int) {
		_ = part.Close()
		_ = os.Remove(partPath)
		s.release(n)
		fail(w, code)
	}
	written, err := io.Copy(part, io.LimitReader(r.Body, n+1))
	if err != nil || written != n {
		abort(http.StatusBadRequest)
		return
	}
	if err := part.Sync(); err != nil {
		abort(http.StatusInternalServerError)
		return
	}
	if err := part.Close(); err != nil {
		abort(http.StatusInternalServerError)
		return
	}
	deleteAt := tk.DeleteAt
	if limit := now.Add(s.cfg.MaxTTL).Unix(); deleteAt > limit {
		deleteAt = limit
	}
	raw, _ := json.Marshal(meta{Size: n, DeleteAt: deleteAt, Once: tk.Once})
	if err := os.WriteFile(s.path(id, metaSuffix), raw, 0o600); err != nil {
		abort(http.StatusInternalServerError)
		return
	}
	if err := os.Rename(partPath, s.path(id, blobSuffix)); err != nil {
		_ = os.Remove(s.path(id, metaSuffix))
		abort(http.StatusInternalServerError)
		return
	}
	log.Printf("[DROP] stored %s (%d bytes)", id, n)
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusCreated)
}

func (s *Server) get(w http.ResponseWriter, r *http.Request, id string) {
	if _, ok := s.authorize(w, r, OpGet, id); !ok {
		return
	}
	m, ok := s.readMeta(id)
	if !ok || m.DeleteAt <= s.cfg.Now().Unix() {
		fail(w, http.StatusNotFound)
		return
	}
	blob := s.path(id, blobSuffix)
	if m.Once {
		// Claim it: a second request for a one-time transfer finds nothing while the
		// first is being served, and gets it back only if that one did not finish.
		claimed := blob + servingTag
		if err := os.Rename(blob, claimed); err != nil {
			fail(w, http.StatusNotFound)
			return
		}
		blob = claimed
	}
	f, err := os.Open(blob)
	if err != nil {
		fail(w, http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Length", strconv.FormatInt(m.Size, 10))
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(http.StatusOK)
	sent, _ := io.Copy(w, f)
	_ = f.Close()
	if !m.Once {
		return
	}
	if sent == m.Size {
		s.remove(id)
		log.Printf("[DROP] %s downloaded once and deleted", id)
		return
	}
	_ = os.Rename(blob, s.path(id, blobSuffix))
}

// remove deletes a transfer and returns its bytes to the quota.
func (s *Server) remove(id string) {
	m, ok := s.readMeta(id)
	for _, suffix := range []string{blobSuffix, blobSuffix + servingTag, metaSuffix} {
		_ = os.Remove(s.path(id, suffix))
	}
	if ok {
		s.release(m.Size)
	}
}

// Sweep deletes expired transfers, ciphertext without a description, and uploads that
// stopped part-way. It answers how many expired transfers it removed.
func (s *Server) Sweep() int {
	entries, err := os.ReadDir(s.cfg.Dir)
	if err != nil {
		log.Printf("[DROP] sweep: %v", err)
		return 0
	}
	now := s.cfg.Now()
	removed := 0
	for _, e := range entries {
		name := e.Name()
		switch {
		case strings.HasSuffix(name, metaSuffix):
			id := strings.TrimSuffix(name, metaSuffix)
			m, ok := s.readMeta(id)
			if !ok || m.DeleteAt <= now.Unix() {
				s.remove(id)
				if ok {
					removed++
				}
			}
		case strings.HasSuffix(name, partSuffix), strings.HasSuffix(name, blobSuffix):
			id := strings.TrimSuffix(strings.TrimSuffix(name, partSuffix), blobSuffix)
			if _, ok := s.readMeta(id); ok && strings.HasSuffix(name, blobSuffix) {
				continue
			}
			if info, err := e.Info(); err == nil && now.Sub(info.ModTime()) > staleAfter {
				_ = os.Remove(filepath.Join(s.cfg.Dir, name))
			}
		}
	}
	if removed > 0 {
		log.Printf("[DROP] sweep removed %d expired transfers", removed)
	}
	return removed
}

// Run sweeps every interval until ctx ends.
func (s *Server) Run(ctx context.Context, interval time.Duration) {
	s.Sweep()
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			s.Sweep()
		}
	}
}
