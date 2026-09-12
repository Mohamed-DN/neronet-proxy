package crypto

import (
	"crypto/rand"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"

	"golang.org/x/crypto/chacha20poly1305"
	"golang.org/x/crypto/hkdf"
)

const (
	// XNonceSize is the 24-byte nonce of XChaCha20-Poly1305.
	//
	// The extended nonce is what makes random nonce generation safe. With the
	// 12-byte nonce of plain ChaCha20-Poly1305 a random nonce collides with
	// probability ~2^-33 after 2^32 messages under one key, which is too close
	// for a long-lived circuit. At 24 bytes the same bound is negligible, so
	// callers do not need to carry a synchronised counter across hops.
	XNonceSize = chacha20poly1305.NonceSizeX
)

var (
	// ErrXDecryptionFailed is returned when the Poly1305 tag does not verify.
	ErrXDecryptionFailed = errors.New("xchacha20poly1305 decryption verification failed")

	// ErrShortNonce is returned when a buffer is too small to hold a nonce.
	ErrShortNonce = errors.New("buffer too small to contain a 24-byte nonce")
)

// RandomXNonce returns a fresh 24-byte nonce from the system CSPRNG.
func RandomXNonce() ([XNonceSize]byte, error) {
	var nonce [XNonceSize]byte
	if _, err := io.ReadFull(rand.Reader, nonce[:]); err != nil {
		return nonce, fmt.Errorf("failed to generate random nonce: %w", err)
	}
	return nonce, nil
}

// XChaCha20Poly1305Seal encrypts and authenticates plaintext with a 24-byte nonce.
func XChaCha20Poly1305Seal(key [KeySize]byte, nonce [XNonceSize]byte, plaintext, additionalData []byte) ([]byte, error) {
	aead, err := chacha20poly1305.NewX(key[:])
	if err != nil {
		return nil, fmt.Errorf("failed to initialize XChaCha20-Poly1305: %w", err)
	}

	return aead.Seal(nil, nonce[:], plaintext, additionalData), nil
}

// XChaCha20Poly1305Open decrypts and verifies ciphertext sealed with a 24-byte nonce.
func XChaCha20Poly1305Open(key [KeySize]byte, nonce [XNonceSize]byte, ciphertext, additionalData []byte) ([]byte, error) {
	aead, err := chacha20poly1305.NewX(key[:])
	if err != nil {
		return nil, fmt.Errorf("failed to initialize XChaCha20-Poly1305: %w", err)
	}

	plaintext, err := aead.Open(nil, nonce[:], ciphertext, additionalData)
	if err != nil {
		return nil, ErrXDecryptionFailed
	}

	return plaintext, nil
}

// DeriveKey expands a raw shared secret into a uniformly distributed symmetric key.
//
// The output of X25519 is a curve point, not a uniform bit string, and carries no
// binding to the context it was computed for. Feeding it straight into an AEAD is
// the mistake this function exists to prevent: always derive, and always pass an
// info string that names the exact purpose of the resulting key.
func DeriveKey(secret []byte, salt []byte, info []byte) ([KeySize]byte, error) {
	var out [KeySize]byte

	reader := hkdf.New(sha256.New, secret, salt, info)
	if _, err := io.ReadFull(reader, out[:]); err != nil {
		return out, fmt.Errorf("HKDF key derivation failed: %w", err)
	}

	return out, nil
}
