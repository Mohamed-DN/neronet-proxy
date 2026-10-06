package derp

import (
	"context"
	"fmt"
	"testing"
	"time"
)

func TestFallbackUsesReachableSecondary(t *testing.T) {
	s := NewServer(ServerConfig{ListenAddr: "127.0.0.1:0"})
	if err := s.Start(); err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	self, peer := [32]byte{1}, [32]byte{2}
	m := NewFallbackManager([]string{"ws://127.0.0.1:1/ws/v4/relay", fmt.Sprintf("ws://%s/ws/v4/relay", s.Addr())}, self, nil)
	defer m.Stop()
	p := m.ensurePath(peer)
	p.lastDirect = time.Now().Add(-2 * directPathTimeout)
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	m.checkPeer(ctx, p, m.relayURLs)
	if !m.RelayActive(peer) {
		t.Fatal("reachable secondary was never tried after primary refused TCP")
	}
}

type replacementSession struct {
	key      [32]byte
	received int
}

func (s *replacementSession) PublicKey() [32]byte    { return s.key }
func (s *replacementSession) Close() error           { return nil }
func (s *replacementSession) SendFrame(*Frame) error { s.received++; return nil }

func TestOldSessionUnregisterKeepsReplacement(t *testing.T) {
	r := NewRouter()
	old := &replacementSession{key: [32]byte{2}}
	next := &replacementSession{key: old.key}
	r.Register(old)
	r.Register(next)
	// The old reader exits after its replacement was registered.
	r.UnregisterSession(old)
	if err := r.RouteForward([32]byte{1}, next.key, []byte("ciphertext")); err != nil {
		t.Fatal(err)
	}
	if next.received != 1 {
		t.Fatal("replacement did not receive the actual routed frame")
	}
}
