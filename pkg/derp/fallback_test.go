package derp

import (
	"context"
	"crypto/rand"
	"testing"
	"time"
)

func TestFallbackManager_DirectPathActive(t *testing.T) {
	var selfPub [PubKeySize]byte
	rand.Read(selfPub[:])

	mgr := NewFallbackManager(nil /* no relay URLs */, selfPub, nil)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	mgr.Start(ctx)
	defer mgr.Stop()

	var peerPub [PubKeySize]byte
	rand.Read(peerPub[:])

	// Record a direct packet — the manager must not engage a relay
	mgr.RecordDirectRecv(peerPub)

	// Give the background loop one tick
	time.Sleep(50 * time.Millisecond)

	if mgr.RelayActive(peerPub) {
		t.Fatal("relay must not be active when direct path is alive")
	}
	if mgr.ActiveRelayCount() != 0 {
		t.Fatalf("expected 0 active relays, got %d", mgr.ActiveRelayCount())
	}
}

func TestFallbackManager_RecordDirectRecv_ResetsTimer(t *testing.T) {
	var selfPub [PubKeySize]byte
	rand.Read(selfPub[:])

	mgr := NewFallbackManager(nil, selfPub, nil)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	mgr.Start(ctx)
	defer mgr.Stop()

	var peerPub [PubKeySize]byte
	rand.Read(peerPub[:])

	// Record direct receives in rapid succession
	for i := 0; i < 5; i++ {
		mgr.RecordDirectRecv(peerPub)
		time.Sleep(5 * time.Millisecond)
	}

	if mgr.RelayActive(peerPub) {
		t.Fatal("relay must not be active when direct path is continuously refreshed")
	}
}

func TestFallbackManager_UpdateRelayURLs(t *testing.T) {
	var selfPub [PubKeySize]byte
	rand.Read(selfPub[:])

	mgr := NewFallbackManager(nil, selfPub, nil)
	mgr.UpdateRelayURLs([]string{"ws://relay-eu.example.com", "ws://relay-us.example.com"})

	mgr.mu.Lock()
	urls := mgr.relayURLs
	mgr.mu.Unlock()

	if len(urls) != 2 {
		t.Fatalf("expected 2 relay URLs, got %d", len(urls))
	}
	if urls[0] != "ws://relay-eu.example.com" {
		t.Fatalf("unexpected first URL: %s", urls[0])
	}
}

func TestFallbackManager_SendViaRelay_NoRelay(t *testing.T) {
	var selfPub [PubKeySize]byte
	rand.Read(selfPub[:])

	mgr := NewFallbackManager(nil, selfPub, nil)

	var peerPub [PubKeySize]byte
	rand.Read(peerPub[:])

	// SendViaRelay with no active relay must be a no-op (not an error)
	err := mgr.SendViaRelay(peerPub, []byte("test packet"))
	if err != nil {
		t.Fatalf("SendViaRelay with no relay must not error, got: %v", err)
	}
}

func TestFallbackManager_StopIdempotent(t *testing.T) {
	var selfPub [PubKeySize]byte
	rand.Read(selfPub[:])

	mgr := NewFallbackManager(nil, selfPub, nil)
	ctx, cancel := context.WithCancel(context.Background())
	mgr.Start(ctx)

	// Cancel context and call Stop — should not panic or deadlock
	cancel()
	mgr.Stop()
	mgr.Stop() // idempotent
}
