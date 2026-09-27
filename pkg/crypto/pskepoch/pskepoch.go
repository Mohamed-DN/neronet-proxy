// Package pskepoch rotates the WireGuard pre-shared key of each peer on a fixed
// epoch.
//
// The key is HKDF-SHA256 over the X25519 shared secret of the two static keys,
// salted with the epoch number. Both ends compute it on their own, so nothing is
// exchanged. It is classical cryptography and adds no post-quantum protection: an
// adversary who can break X25519 recovers the static shared secret, and with it
// every key this package derives. It does not defend against anything WireGuard's
// own handshake does not already defend against.
//
// This package used to be called rosenpass and described itself as post-quantum.
// Rosenpass is a separate protocol with a post-quantum key exchange (Classic
// McEliece and Kyber); running it to supply the pre-shared key is still planned
// (ADR 0020, section 7), and this package is not it.
package pskepoch

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
	// DefaultRotationInterval is the rotation period (2 minutes).
	DefaultRotationInterval = 2 * time.Minute

	// PSKDomainSeparator binds the derived PSK to this purpose. The value is a wire
	// constant: both ends must use the same one, so it keeps its old spelling
	// rather than break tunnels between nodes on either side of an upgrade.
	PSKDomainSeparator = "neronet-rosenpass-pq-psk-v1"
)

// PSKUpdater updates the WireGuard PSK on the underlying tunnel device.
type PSKUpdater interface {
	UpdatePeerPSK(peerPubHex string, pskHex string) error
}

// DeriveEpochPSK derives the 256-bit pre-shared key for a peer at an epoch. Both sides
// derive the same key from the X25519 shared secret of their static keys and the
// epoch, through HKDF-SHA256. Classical: see the package comment.
func DeriveEpochPSK(localPriv, peerPub [32]byte, epoch uint64) ([32]byte, error) {
	dh, err := crypto.DH(localPriv, peerPub)
	if err != nil {
		return [32]byte{}, fmt.Errorf("pskepoch: DH failed: %w", err)
	}

	// Salt is the 8-byte big-endian epoch counter
	var salt [8]byte
	binary.BigEndian.PutUint64(salt[:], epoch)

	info := []byte(PSKDomainSeparator)
	return crypto.DeriveKey(dh[:], salt[:], info)
}

// Manager rotates the pre-shared key of every peer on the WireGuard tunnel.
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

// NewManager creates a PSK rotation manager.
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
		psk, err := DeriveEpochPSK(m.localKP.PrivateKey, peerPub, epoch)
		if err != nil {
			log.Printf("[PSK-EPOCH] Failed to derive PSK for peer %.8s: %v", pubHex, err)
			continue
		}
		pskHex := hex.EncodeToString(psk[:])
		if err := m.updater.UpdatePeerPSK(pubHex, pskHex); err != nil {
			log.Printf("[PSK-EPOCH] Failed to install PSK for peer %.8s: %v", pubHex, err)
		} else {
			log.Printf("[PSK-EPOCH] Rotated PSK for peer %.8s (epoch %d)", pubHex, epoch)
		}
	}
}
