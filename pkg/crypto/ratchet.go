package crypto

import (
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"time"
)

const (
	RekeyPacketThreshold uint64        = 1048576           // 2^20 packets
	RekeyTimeThreshold   time.Duration = 180 * time.Second // 180 seconds
	DualKeyGracePeriod   time.Duration = 15 * time.Second  // 15 seconds dual-key receive window
)

var (
	ErrSessionClosed     = errors.New("session is closed")
	ErrReplayDetected    = errors.New("packet sequence number replayed or out of sliding window")
	ErrRekeyRequired     = errors.New("session requires immediate rekey")
	ErrInvalidCiphertext = errors.New("failed to decrypt ciphertext with active or fallback keys")
)

// SessionRatchetManager maintains the active and transition session keys for a peer connection.
type SessionRatchetManager struct {
	mu            sync.RWMutex
	activeState   *TransportCipherState
	previousState *TransportCipherState
	closed        bool
	isInitiator   bool
	staticKeypair *Keypair
	peerStaticPub [KeySize]byte
	psk           [KeySize]byte
}

// NewSessionRatchetManager initializes a new ratchet manager around an established TransportCipherState.
func NewSessionRatchetManager(
	initialState *TransportCipherState,
	isInitiator bool,
	staticKeypair *Keypair,
	peerStaticPub [KeySize]byte,
	psk [KeySize]byte,
) *SessionRatchetManager {
	return &SessionRatchetManager{
		activeState:   initialState,
		isInitiator:   isInitiator,
		staticKeypair: staticKeypair,
		peerStaticPub: peerStaticPub,
		psk:           psk,
	}
}

// NeedsRekey checks if current session exceeded packet or duration thresholds.
func (m *SessionRatchetManager) NeedsRekey() bool {
	m.mu.RLock()
	defer m.mu.RUnlock()

	if m.activeState == nil {
		return false
	}

	sendNonce := atomic.LoadUint64(&m.activeState.SendNonce)
	if sendNonce >= RekeyPacketThreshold {
		return true
	}

	if time.Since(m.activeState.CreatedAt) >= RekeyTimeThreshold {
		return true
	}

	return false
}

// EncryptPacket encrypts plaintext and frames it into a DirectFrame using current send key and counter.
func (m *SessionRatchetManager) EncryptPacket(msgType uint8, plaintext []byte) ([]byte, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if m.closed || m.activeState == nil {
		return nil, ErrSessionClosed
	}

	seq := m.activeState.SendNonce
	m.activeState.SendNonce++

	nonce := ConstructNonce(seq)
	// Additional data is the header context: SenderID + ReceiverID + Seq
	var ad [16]byte
	copy(ad[0:4], encodeUint32(m.activeState.LocalSessionID))
	copy(ad[4:8], encodeUint32(m.activeState.RemoteSessionID))
	copy(ad[8:16], encodeUint64(seq))

	sealed, err := ChaCha20Poly1305Seal(m.activeState.SendKey, nonce, plaintext, ad[:])
	if err != nil {
		return nil, fmt.Errorf("failed to seal packet: %w", err)
	}

	// The Poly1305 tag is the last 16 bytes of sealed ciphertext
	tagOffset := len(sealed) - Poly1305TagSize
	ciphertext := sealed[:tagOffset]
	var tag [Poly1305TagSize]byte
	copy(tag[:], sealed[tagOffset:])

	frame := &DirectFrame{
		Magic:             DirectFrameMagic,
		Version:           CurrentWireVersion,
		MsgType:           msgType,
		SenderSessionID:   m.activeState.LocalSessionID,
		ReceiverSessionID: m.activeState.RemoteSessionID,
		SequenceCounter:   seq,
		Ciphertext:        ciphertext,
		AuthTag:           tag,
	}

	return EncodeDirectFrame(frame), nil
}

// DecryptPacket parses a DirectFrame, verifies replay sliding window, and decrypts the payload.
// Uses dual-key window to decrypt with previous key if within the 15-second grace period.
func (m *SessionRatchetManager) DecryptPacket(rawFrame []byte) ([]byte, uint8, error) {
	frame, err := DecodeDirectFrame(rawFrame)
	if err != nil {
		return nil, 0, err
	}

	m.mu.RLock()
	defer m.mu.RUnlock()

	if m.closed || m.activeState == nil {
		return nil, 0, ErrSessionClosed
	}

	// Reconstruct sealed buffer [ciphertext || tag]
	sealed := make([]byte, len(frame.Ciphertext)+Poly1305TagSize)
	copy(sealed, frame.Ciphertext)
	copy(sealed[len(frame.Ciphertext):], frame.AuthTag[:])

	var ad [16]byte
	copy(ad[0:4], encodeUint32(frame.SenderSessionID))
	copy(ad[4:8], encodeUint32(frame.ReceiverSessionID))
	copy(ad[8:16], encodeUint64(frame.SequenceCounter))

	nonce := ConstructNonce(frame.SequenceCounter)

	// Route to correct state based on ReceiverSessionID
	var targetState *TransportCipherState
	if m.activeState != nil && frame.ReceiverSessionID == m.activeState.LocalSessionID {
		targetState = m.activeState
	} else if m.previousState != nil && frame.ReceiverSessionID == m.previousState.LocalSessionID && time.Since(m.activeState.CreatedAt) <= DualKeyGracePeriod {
		targetState = m.previousState
	}

	if targetState == nil {
		return nil, 0, ErrInvalidCiphertext
	}

	if !targetState.AntiReplay.Check(frame.SequenceCounter) {
		return nil, 0, ErrReplayDetected
	}

	plaintext, err := ChaCha20Poly1305Open(targetState.RecvKey, nonce, sealed, ad[:])
	if err != nil {
		return nil, 0, ErrInvalidCiphertext
	}

	if !targetState.AntiReplay.CheckAndAdd(frame.SequenceCounter) {
		return nil, 0, ErrReplayDetected
	}

	return plaintext, frame.MsgType, nil
}

// RotateKeys establishes a newly negotiated TransportCipherState, moving current state to previous.
func (m *SessionRatchetManager) RotateKeys(newState *TransportCipherState) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if m.previousState != nil {
		Wipe(m.previousState.SendKey[:])
		Wipe(m.previousState.RecvKey[:])
	}

	m.previousState = m.activeState
	m.activeState = newState
}

// Close wipes all cryptographic keys and marks session closed.
func (m *SessionRatchetManager) Close() {
	m.mu.Lock()
	defer m.mu.Unlock()

	m.closed = true
	if m.activeState != nil {
		Wipe(m.activeState.SendKey[:])
		Wipe(m.activeState.RecvKey[:])
		m.activeState = nil
	}
	if m.previousState != nil {
		Wipe(m.previousState.SendKey[:])
		Wipe(m.previousState.RecvKey[:])
		m.previousState = nil
	}
}

func encodeUint32(v uint32) []byte {
	var b [4]byte
	b[0] = byte(v >> 24)
	b[1] = byte(v >> 16)
	b[2] = byte(v >> 8)
	b[3] = byte(v)
	return b[:]
}

func encodeUint64(v uint64) []byte {
	var b [8]byte
	b[0] = byte(v >> 56)
	b[1] = byte(v >> 48)
	b[2] = byte(v >> 40)
	b[3] = byte(v >> 32)
	b[4] = byte(v >> 24)
	b[5] = byte(v >> 16)
	b[6] = byte(v >> 8)
	b[7] = byte(v)
	return b[:]
}
