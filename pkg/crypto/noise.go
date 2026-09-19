package crypto

import (
	"crypto/hmac"
	"crypto/rand"
	"encoding/binary"
	"errors"
	"fmt"
	"hash"
	"io"
	"time"

	"golang.org/x/crypto/blake2s"
)

const (
	NoiseProtocolName = "Noise_IKpsk2_25519_ChaChaPoly_BLAKE2s"
	PrologueString    = "SovereignMesh-v4"
)

var (
	ErrInvalidHandshakeMessage = errors.New("invalid noise handshake message format")
	ErrHandshakeExpired        = errors.New("handshake timestamp expired or drifted beyond limit")
	ErrAuthFailed              = errors.New("noise authentication verification failed")
)

// TransportCipherState contains the established symmetric keys for bidirectional communication
type TransportCipherState struct {
	SendKey         [KeySize]byte
	RecvKey         [KeySize]byte
	SendNonce       uint64
	RecvNonce       uint64
	LocalSessionID  uint32
	RemoteSessionID uint32
	PeerStaticPub   [KeySize]byte
	CreatedAt       time.Time
	AntiReplay      *AntiReplayWindow
}

// InitiatorHandshakeState holds state between Act 1 and Act 2 on the initiator
type InitiatorHandshakeState struct {
	EphemeralPriv   [KeySize]byte
	EphemeralPub    [KeySize]byte
	InitiatorStatic *Keypair
	ResponderStatic [KeySize]byte
	PSK             [KeySize]byte
	SenderSessionID uint32
	CK              [KeySize]byte
	H               [KeySize]byte
	CreatedAt       time.Time
}

// HandshakeAct1Packet represents the wire format of Act 1
type HandshakeAct1Packet struct {
	SenderSessionID  uint32
	EphemeralPub     [KeySize]byte
	EncryptedStatic  [48]byte // 32 bytes pubkey + 16 bytes Poly1305 tag
	EncryptedPayload []byte   // 0-RTT payload + 16 bytes Poly1305 tag
}

// HandshakeAct2Packet represents the wire format of Act 2
type HandshakeAct2Packet struct {
	SenderSessionID   uint32
	ReceiverSessionID uint32
	EphemeralPub      [KeySize]byte
	EncryptedPayload  []byte // Response payload + 16 bytes Poly1305 tag
}

// blake2sHash computes 32-byte BLAKE2s-256 digest of input slices
func blake2sHash(data ...[]byte) [KeySize]byte {
	h, _ := blake2s.New256(nil)
	for _, d := range data {
		h.Write(d)
	}
	var out [KeySize]byte
	copy(out[:], h.Sum(nil))
	return out
}

// hmacBlake2s computes HMAC using BLAKE2s-256
func hmacBlake2s(key []byte, data []byte) [KeySize]byte {
	mac := hmac.New(func() hash.Hash {
		h, _ := blake2s.New256(nil)
		return h
	}, key)
	mac.Write(data)
	var out [KeySize]byte
	copy(out[:], mac.Sum(nil))
	return out
}

// hkdf2 derives two 32-byte keys from chaining key and input
func hkdf2(ck [KeySize]byte, input []byte) ([KeySize]byte, [KeySize]byte) {
	tempKey := hmacBlake2s(ck[:], input)
	out1 := hmacBlake2s(tempKey[:], []byte{0x01})
	out2 := hmacBlake2s(tempKey[:], append(out1[:], 0x02))
	return out1, out2
}

// hkdf3 derives three 32-byte keys from chaining key and input
func hkdf3(ck [KeySize]byte, input []byte) ([KeySize]byte, [KeySize]byte, [KeySize]byte) {
	tempKey := hmacBlake2s(ck[:], input)
	out1 := hmacBlake2s(tempKey[:], []byte{0x01})
	out2 := hmacBlake2s(tempKey[:], append(out1[:], 0x02))
	out3 := hmacBlake2s(tempKey[:], append(out2[:], 0x03))
	return out1, out2, out3
}

// generateSessionID generates a random 32-bit non-zero session ID
func generateSessionID() (uint32, error) {
	var b [4]byte
	for {
		if _, err := io.ReadFull(rand.Reader, b[:]); err != nil {
			return 0, err
		}
		id := binary.BigEndian.Uint32(b[:])
		if id != 0 {
			return id, nil
		}
	}
}

// InitHandshakeAct1 creates the Act 1 initiation message and returns the initiator state
func InitHandshakeAct1(
	initiatorStatic *Keypair,
	responderStaticPub [KeySize]byte,
	psk [KeySize]byte,
	payload0RTT []byte,
) (*HandshakeAct1Packet, *InitiatorHandshakeState, error) {
	eph, err := GenerateKeypair()
	if err != nil {
		return nil, nil, fmt.Errorf("failed to generate ephemeral keypair: %w", err)
	}

	sessionID, err := generateSessionID()
	if err != nil {
		return nil, nil, fmt.Errorf("failed to generate session ID: %w", err)
	}

	// 1. Initial State
	h0 := blake2sHash([]byte(NoiseProtocolName))
	ck0 := h0
	h1 := blake2sHash(h0[:], []byte(PrologueString))
	h2 := blake2sHash(h1[:], responderStaticPub[:])

	// 2. MixHash(E_a)
	h3 := blake2sHash(h2[:], eph.PublicKey[:])

	// 3. MixKey(DH(e_a, S_b))
	dh1, err := DH(eph.PrivateKey, responderStaticPub)
	if err != nil {
		return nil, nil, err
	}
	ck1, k1 := hkdf2(ck0, dh1[:])

	// 4. EncryptAndHash(S_a)
	nonce0 := ConstructNonce(0)
	msgS, err := ChaCha20Poly1305Seal(k1, nonce0, initiatorStatic.PublicKey[:], h3[:])
	if err != nil {
		return nil, nil, fmt.Errorf("failed to encrypt static key: %w", err)
	}
	var msgSArr [48]byte
	copy(msgSArr[:], msgS)
	h4 := blake2sHash(h3[:], msgS)

	// 5. MixKey(DH(s_a, S_b))
	dh2, err := DH(initiatorStatic.PrivateKey, responderStaticPub)
	if err != nil {
		return nil, nil, err
	}
	ck2, _ := hkdf2(ck1, dh2[:])

	// 6. MixKeyAndHash(PSK)
	ck3, tempH, k3 := hkdf3(ck2, psk[:])
	h5 := blake2sHash(h4[:], tempH[:])

	// 7. EncryptAndHash(Payload_0RTT)
	msgPayload, err := ChaCha20Poly1305Seal(k3, nonce0, payload0RTT, h5[:])
	if err != nil {
		return nil, nil, fmt.Errorf("failed to encrypt 0-RTT payload: %w", err)
	}
	h6 := blake2sHash(h5[:], msgPayload)

	packet := &HandshakeAct1Packet{
		SenderSessionID:  sessionID,
		EphemeralPub:     eph.PublicKey,
		EncryptedStatic:  msgSArr,
		EncryptedPayload: msgPayload,
	}

	state := &InitiatorHandshakeState{
		EphemeralPriv:   eph.PrivateKey,
		EphemeralPub:    eph.PublicKey,
		InitiatorStatic: initiatorStatic,
		ResponderStatic: responderStaticPub,
		PSK:             psk,
		SenderSessionID: sessionID,
		CK:              ck3,
		H:               h6,
		CreatedAt:       time.Now(),
	}

	return packet, state, nil
}

// ProcessHandshakeAct1 receives Act 1 on the responder and computes Act 2 response
func ProcessHandshakeAct1(
	responderStatic *Keypair,
	psk [KeySize]byte,
	act1 *HandshakeAct1Packet,
	payloadAct2 []byte,
) (*HandshakeAct2Packet, *TransportCipherState, []byte, error) {
	if act1.SenderSessionID == 0 {
		return nil, nil, nil, errors.New("invalid sender session ID 0")
	}

	// 1. Initial State
	h0 := blake2sHash([]byte(NoiseProtocolName))
	ck0 := h0
	h1 := blake2sHash(h0[:], []byte(PrologueString))
	h2 := blake2sHash(h1[:], responderStatic.PublicKey[:])

	// 2. MixHash(E_a)
	h3 := blake2sHash(h2[:], act1.EphemeralPub[:])

	// 3. MixKey(DH(s_b, E_a))
	dh1, err := DH(responderStatic.PrivateKey, act1.EphemeralPub)
	if err != nil {
		return nil, nil, nil, fmt.Errorf("responder DH1 failed: %w", err)
	}
	ck1, k1 := hkdf2(ck0, dh1[:])

	// 4. DecryptAndHash(S_a)
	nonce0 := ConstructNonce(0)
	peerStaticPubBytes, err := ChaCha20Poly1305Open(k1, nonce0, act1.EncryptedStatic[:], h3[:])
	if err != nil {
		return nil, nil, nil, fmt.Errorf("%w: failed to decrypt initiator static key", ErrAuthFailed)
	}
	var peerStaticPub [KeySize]byte
	copy(peerStaticPub[:], peerStaticPubBytes)
	h4 := blake2sHash(h3[:], act1.EncryptedStatic[:])

	// 5. MixKey(DH(s_b, S_a))
	dh2, err := DH(responderStatic.PrivateKey, peerStaticPub)
	if err != nil {
		return nil, nil, nil, fmt.Errorf("responder DH2 failed: %w", err)
	}
	ck2, _ := hkdf2(ck1, dh2[:])

	// 6. MixKeyAndHash(PSK)
	ck3, tempH, k3 := hkdf3(ck2, psk[:])
	h5 := blake2sHash(h4[:], tempH[:])

	// 7. DecryptAndHash(Payload_0RTT)
	payload0RTT, err := ChaCha20Poly1305Open(k3, nonce0, act1.EncryptedPayload, h5[:])
	if err != nil {
		return nil, nil, nil, fmt.Errorf("%w: failed to decrypt 0-RTT payload", ErrAuthFailed)
	}
	h6 := blake2sHash(h5[:], act1.EncryptedPayload)

	// Now construct Act 2:
	respEph, err := GenerateKeypair()
	if err != nil {
		return nil, nil, nil, fmt.Errorf("failed to generate responder ephemeral: %w", err)
	}

	respSessionID, err := generateSessionID()
	if err != nil {
		return nil, nil, nil, fmt.Errorf("failed to generate responder session ID: %w", err)
	}

	// 8. MixHash(E_b)
	h7 := blake2sHash(h6[:], respEph.PublicKey[:])

	// 9. MixKey(DH(e_b, E_a))
	dh3, err := DH(respEph.PrivateKey, act1.EphemeralPub)
	if err != nil {
		return nil, nil, nil, fmt.Errorf("responder DH3 failed: %w", err)
	}
	ck4, _ := hkdf2(ck3, dh3[:])

	// 10. MixKey(DH(e_b, S_a))
	dh4, err := DH(respEph.PrivateKey, peerStaticPub)
	if err != nil {
		return nil, nil, nil, fmt.Errorf("responder DH4 failed: %w", err)
	}
	ck5, k5 := hkdf2(ck4, dh4[:])

	// 11. EncryptAndHash(Payload_Act2)
	msgPayload2, err := ChaCha20Poly1305Seal(k5, nonce0, payloadAct2, h7[:])
	if err != nil {
		return nil, nil, nil, fmt.Errorf("failed to encrypt act2 payload: %w", err)
	}

	// 12. Split CipherStates
	// For responder: sendKey = out2, recvKey = out1
	kRecv, kSend := hkdf2(ck5, nil)

	transport := &TransportCipherState{
		SendKey:         kSend,
		RecvKey:         kRecv,
		SendNonce:       0,
		RecvNonce:       0,
		LocalSessionID:  respSessionID,
		RemoteSessionID: act1.SenderSessionID,
		PeerStaticPub:   peerStaticPub,
		CreatedAt:       time.Now(),
		AntiReplay:      NewAntiReplayWindow(),
	}

	act2Packet := &HandshakeAct2Packet{
		SenderSessionID:   respSessionID,
		ReceiverSessionID: act1.SenderSessionID,
		EphemeralPub:      respEph.PublicKey,
		EncryptedPayload:  msgPayload2,
	}

	return act2Packet, transport, payload0RTT, nil
}

// ProcessHandshakeAct2 finalizes the handshake on the initiator
func ProcessHandshakeAct2(
	state *InitiatorHandshakeState,
	act2 *HandshakeAct2Packet,
) (*TransportCipherState, []byte, error) {
	if act2.ReceiverSessionID != state.SenderSessionID {
		return nil, nil, fmt.Errorf("mismatched receiver session ID: expected %d, got %d", state.SenderSessionID, act2.ReceiverSessionID)
	}

	// 1. MixHash(E_b)
	h7 := blake2sHash(state.H[:], act2.EphemeralPub[:])

	// 2. MixKey(DH(e_a, E_b))
	dh3, err := DH(state.EphemeralPriv, act2.EphemeralPub)
	if err != nil {
		return nil, nil, fmt.Errorf("initiator DH3 failed: %w", err)
	}
	ck4, _ := hkdf2(state.CK, dh3[:])

	// 3. MixKey(DH(s_a, E_b))
	dh4, err := DH(state.InitiatorStatic.PrivateKey, act2.EphemeralPub)
	if err != nil {
		return nil, nil, fmt.Errorf("initiator DH4 failed: %w", err)
	}
	ck5, k5 := hkdf2(ck4, dh4[:])

	// 4. DecryptAndHash(Payload_Act2)
	nonce0 := ConstructNonce(0)
	payloadAct2, err := ChaCha20Poly1305Open(k5, nonce0, act2.EncryptedPayload, h7[:])
	if err != nil {
		return nil, nil, fmt.Errorf("%w: failed to decrypt act2 payload", ErrAuthFailed)
	}

	// 5. Split CipherStates
	// For initiator: sendKey = out1, recvKey = out2
	kSend, kRecv := hkdf2(ck5, nil)

	transport := &TransportCipherState{
		SendKey:         kSend,
		RecvKey:         kRecv,
		SendNonce:       0,
		RecvNonce:       0,
		LocalSessionID:  state.SenderSessionID,
		RemoteSessionID: act2.SenderSessionID,
		PeerStaticPub:   state.ResponderStatic,
		CreatedAt:       time.Now(),
		AntiReplay:      NewAntiReplayWindow(),
	}

	// Clean up ephemeral secrets
	Wipe(state.EphemeralPriv[:])

	return transport, payloadAct2, nil
}
