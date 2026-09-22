package rosenpass

import (
	"context"
	"encoding/hex"
	"sync"
	"testing"
	"time"

	"github.com/sovereign/proxy/v4/pkg/crypto"
)

type mockPSKUpdater struct {
	mu      sync.Mutex
	updates map[string]string // peerPubHex -> pskHex
}

func (m *mockPSKUpdater) UpdatePeerPSK(peerPubHex string, pskHex string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.updates[peerPubHex] = pskHex
	return nil
}

func (m *mockPSKUpdater) getPSK(peerPubHex string) string {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.updates[peerPubHex]
}

func TestDerivePQPSK_Symmetry(t *testing.T) {
	aliceKP, err := crypto.GenerateKeypair()
	if err != nil {
		t.Fatalf("Alice keypair: %v", err)
	}
	bobKP, err := crypto.GenerateKeypair()
	if err != nil {
		t.Fatalf("Bob keypair: %v", err)
	}

	epoch := uint64(100)

	// Alice derives PSK for Bob
	pskAlice, err := DerivePQPSK(aliceKP.PrivateKey, bobKP.PublicKey, epoch)
	if err != nil {
		t.Fatalf("Alice derive: %v", err)
	}

	// Bob derives PSK for Alice
	pskBob, err := DerivePQPSK(bobKP.PrivateKey, aliceKP.PublicKey, epoch)
	if err != nil {
		t.Fatalf("Bob derive: %v", err)
	}

	if pskAlice != pskBob {
		t.Fatalf("Asymmetric PSK derivation! Alice: %x, Bob: %x", pskAlice, pskBob)
	}
}

func TestDerivePQPSK_EpochRotation(t *testing.T) {
	aliceKP, _ := crypto.GenerateKeypair()
	bobKP, _ := crypto.GenerateKeypair()

	pskEpoch1, err := DerivePQPSK(aliceKP.PrivateKey, bobKP.PublicKey, 1)
	if err != nil {
		t.Fatalf("Epoch 1 derive: %v", err)
	}

	pskEpoch2, err := DerivePQPSK(aliceKP.PrivateKey, bobKP.PublicKey, 2)
	if err != nil {
		t.Fatalf("Epoch 2 derive: %v", err)
	}

	if pskEpoch1 == pskEpoch2 {
		t.Fatal("PSK did not change between different epochs!")
	}
}

func TestManager_RotationLifecycle(t *testing.T) {
	aliceKP, _ := crypto.GenerateKeypair()
	bobKP, _ := crypto.GenerateKeypair()

	updater := &mockPSKUpdater{updates: make(map[string]string)}

	mgr := NewManager(updater, aliceKP, 100*time.Millisecond)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	mgr.Start(ctx)
	defer mgr.Stop()

	bobPubHex := hex.EncodeToString(bobKP.PublicKey[:])
	mgr.SetPeers([]string{bobPubHex})

	initialPSK := updater.getPSK(bobPubHex)
	if initialPSK == "" {
		t.Fatal("Initial PSK was not installed immediately upon SetPeers")
	}

	// Wait for at least one rotation interval
	time.Sleep(250 * time.Millisecond)

	rotatedPSK := updater.getPSK(bobPubHex)
	if rotatedPSK == "" {
		t.Fatal("Rotated PSK was empty")
	}
	if rotatedPSK == initialPSK {
		t.Fatal("PSK did not rotate after interval elapsed!")
	}
}
