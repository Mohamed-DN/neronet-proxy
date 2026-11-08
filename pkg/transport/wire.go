package transport

import (
	"encoding/binary"

	"golang.org/x/crypto/blake2s"
)

// The only thing the Mux knows about WireGuard's wire format: the sizes and type tags of
// the three handshake messages, which it reads (never alters) to race an initiation over
// several transports and to learn which one answered. The values are fixed by the
// protocol (WireGuard whitepaper, section 5.4); wireguard-go's own constants are
// unexported.
const (
	msgInitiation = 1
	msgResponse   = 2
	msgCookie     = 3

	sizeInitiation = 148
	sizeResponse   = 92
	sizeCookie     = 64

	// Offsets inside an initiation.
	initSenderOffset = 4
	initMAC1Offset   = 116
	initMAC1Size     = 16
)

// isInitiation reports whether a packet is a handshake initiation. Anything else,
// including a data packet that happens to be 148 bytes long, differs in its type tag.
func isInitiation(b []byte) bool {
	return len(b) == sizeInitiation && binary.LittleEndian.Uint32(b) == msgInitiation
}

// initiationIndex is the sender index of an initiation, which the answering response
// repeats as its receiver index.
func initiationIndex(b []byte) uint32 {
	return binary.LittleEndian.Uint32(b[initSenderOffset:])
}

// answerIndex returns the index a handshake answer refers to. Both a response (type 2,
// receiver index at byte 8) and a cookie reply (type 3, receiver index at byte 4) prove
// that the peer received the initiation and that the return path works on the transport
// they arrived on.
func answerIndex(b []byte) (uint32, bool) {
	if len(b) < 12 {
		return 0, false
	}
	switch binary.LittleEndian.Uint32(b) {
	case msgResponse:
		if len(b) == sizeResponse {
			return binary.LittleEndian.Uint32(b[8:]), true
		}
	case msgCookie:
		if len(b) == sizeCookie {
			return binary.LittleEndian.Uint32(b[4:]), true
		}
	}
	return 0, false
}

// mac1Key is the key WireGuard uses to authenticate an initiation to a given responder:
// HASH("mac1----" || responder static public key). An initiation carries no plaintext
// identifier of its target, so this is how the Mux finds which configured peer an
// initiation is for without depending on what the endpoint object remembers.
func mac1Key(responderPub [32]byte) [32]byte {
	h, _ := blake2s.New256(nil)
	h.Write([]byte("mac1----"))
	h.Write(responderPub[:])
	var key [32]byte
	h.Sum(key[:0])
	return key
}

// initiationIsFor reports whether an initiation's MAC1 verifies under the key derived
// from the given responder public key.
func initiationIsFor(init []byte, key [32]byte) bool {
	h, err := blake2s.New128(key[:])
	if err != nil {
		return false
	}
	h.Write(init[:initMAC1Offset])
	var sum [16]byte
	h.Sum(sum[:0])

	var diff byte
	for i := 0; i < initMAC1Size; i++ {
		diff |= sum[i] ^ init[initMAC1Offset+i]
	}
	return diff == 0
}
