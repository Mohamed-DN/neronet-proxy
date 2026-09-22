package rosenpass

import (
	"context"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"log"
	"strings"
	"sync"
	"time"

	"github.com/sovereign/proxy/v4/pkg/crypto"
)

const (
	// DefaultRotationInterval is the Rosenpass key rotation period (2 minutes).
	DefaultRotationInterval = 2 * time.Minute

	// PSKDomainSeparator binds the derived PSK to this specific protocol and purpose.
	PSKDomainSeparator = "neronet-rosenpass-pq-psk-v1"
)

// PSKUpdater updates the WireGuard PSK on the underlying tunnel device.
type PSKUpdater interface {
	UpdatePeerPSK(peerPubHex string, pskHex string) error
}

// DerivePQPSK derives a 256-bit post-quantum pre-shared key for a peer at the specified epoch.
// Both sides of the tunnel derive the identical key deterministically using Diffie-Hellman
// over their static keys combined with the time epoch via HKDF-SHA256.
func DerivePQPSK(localPriv, peerPub [32]byte, epoch uint64) ([32]byte, error) {
	dh, err := crypto.DH(localPriv, peerPub)
	if err != nil {
		return [32]byte{}, fmt.Errorf("rosenpass: DH failed: %w", err)
	}

	// Salt is the 8-byte big-endian epoch counter
	var salt [8]byte
	binary.BigEndian.PutUint64(salt[:], epoch)

	info := []byte(PSKDomainSeparator)
	return crypto.DeriveKey(dh[:], salt[:], info)
}

// Manager supervises post-quantum pre-shared key rotation for peers on the WireGuard tunnel.
type Manager struct {
	mu        sync.Mutex
	updater   PSKUpdater
	localKP   *crypto.Keypair
	interval  time.Duration
	peers     map[string][32]byte // pubHex -> [32]byte
	lastEpoch uint64
	cancel    context.CancelFunc
	wg        sync.WaitGroup
}

// NewManager creates a Rosenpass post-quantum PSK rotation manager.
func NewManager(updater PSKUpdater, localKP *crypto.Keypair, interval time.Duration) *Manager {
	if interval <= 0 {
		interval = DefaultRotationInterval
	}
	return &Manager{
		updater:  updater,
		localKP:  localKP,
		interval: interval,
		peers:    make(map[string][32]byte),
	}
}

// SetPeers updates the set of peers monitored for PSK rotation.
func (m *Manager) SetPeers(peerPubHexes []string) {
	m.mu.Lock()
	defer m.mu.Unlock()

	newPeers := make(map[string][32]byte, len(peerPubHexes))
	for _, raw := range peerPubHexes {
		k := strings.ToLower(strings.TrimSpace(raw))
		b, err := hex.DecodeString(k)
		if err == nil && len(b) == 32 {
			var arr [32]byte
			copy(arr[:], b)
			newPeers[k] = arr
		}
	}
	m.peers = newPeers
	// Rotate immediately for new peers
	m.rotateLocked(time.Now())
}

// CurrentEpoch returns the rotation epoch for a given timestamp.
func (m *Manager) CurrentEpoch(t time.Time) uint64 {
	interval := m.interval
	if interval <= 0 {
		interval = DefaultRotationInterval
	}
	return uint64(t.UnixNano() / int64(interval))
}

// Start begins the background PSK rotation loop.
func (m *Manager) Start(ctx context.Context) {
	ctx, m.cancel = context.WithCancel(ctx)
	m.wg.Add(1)
	go func() {
		defer m.wg.Done()
		m.loop(ctx)
	}()
}

// Stop shuts down the rotation loop.
func (m *Manager) Stop() {
	if m.cancel != nil {
		m.cancel()
	}
	m.wg.Wait()
}

func (m *Manager) loop(ctx context.Context) {
	pollInterval := m.interval / 4
	if pollInterval > 10*time.Second {
		pollInterval = 10 * time.Second
	}
	if pollInterval < 10*time.Millisecond {
		pollInterval = 10 * time.Millisecond
	}
	ticker := time.NewTicker(pollInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case t := <-ticker.C:
			m.mu.Lock()
			epoch := m.CurrentEpoch(t)
			if epoch != m.lastEpoch {
				m.rotateLocked(t)
			}
			m.mu.Unlock()
		}
	}
}

func (m *Manager) rotateLocked(t time.Time) {
	if m.updater == nil || m.localKP == nil {
		return
	}
	epoch := m.CurrentEpoch(t)
	m.lastEpoch = epoch

	for pubHex, peerPub := range m.peers {
		psk, err := DerivePQPSK(m.localKP.PrivateKey, peerPub, epoch)
		if err != nil {
			log.Printf("[ROSENPASS] Failed to derive PQ PSK for peer %.8s: %v", pubHex, err)
			continue
		}
		pskHex := hex.EncodeToString(psk[:])
		if err := m.updater.UpdatePeerPSK(pubHex, pskHex); err != nil {
			log.Printf("[ROSENPASS] Failed to install PQ PSK for peer %.8s: %v", pubHex, err)
		} else {
			log.Printf("[ROSENPASS] Rotated PQ PSK for peer %.8s (epoch %d)", pubHex, epoch)
		}
	}
}
