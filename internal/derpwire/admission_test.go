package derpwire

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

func TestAdmissionServiceCredentialRevocationAndAbsoluteExpiry(t *testing.T) {
	identity := [32]byte{1}
	var deny, revoked atomic.Bool
	var invalidations atomic.Uint32
	s := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer distinct-service-credential" || deny.Load() {
			w.WriteHeader(401)
			return
		}
		keys := []string{hex.EncodeToString(identity[:])}
		if revoked.Load() {
			keys = nil
		}
		_ = json.NewEncoder(w).Encode(AdmissionSnapshot{keys, time.Now().Unix(), 2})
	}))
	defer s.Close()
	roots := x509.NewCertPool()
	roots.AddCert(s.Certificate())
	c, err := NewAdmissionCache(s.URL, "distinct-service-credential", &tls.Config{RootCAs: roots}, func() { invalidations.Add(1) })
	if err != nil {
		t.Fatal(err)
	}
	if c.Allows(identity) {
		t.Fatal("uninitialised cache allowed identity")
	}
	if err := c.Refresh(context.Background()); err != nil {
		t.Fatal(err)
	}
	if !c.Allows(identity) {
		t.Fatal("authenticated snapshot was not applied")
	}
	revoked.Store(true)
	if err := c.Refresh(context.Background()); err != nil {
		t.Fatal(err)
	}
	if c.Allows(identity) || invalidations.Load() != 1 {
		t.Fatal("revocation did not invalidate existing sessions")
	}
	revoked.Store(false)
	if err := c.Refresh(context.Background()); err != nil {
		t.Fatal(err)
	}
	deny.Store(true)
	if err := c.Refresh(context.Background()); err == nil {
		t.Fatal("wrong service authority was accepted")
	}
	eventually(t, func() bool { c.Expire(); return !c.Allows(identity) })
	if invalidations.Load() != 2 {
		t.Fatal("expiry failed to close sessions")
	}
	c.Expire()
	if invalidations.Load() != 2 {
		t.Fatal("expired cache repeatedly invalidated sessions")
	}
}
