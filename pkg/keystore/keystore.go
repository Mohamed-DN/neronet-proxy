package keystore

import (
	"errors"
)

var (
	// ErrKeyNotFound indicates the requested key alias does not exist.
	ErrKeyNotFound = errors.New("keystore: key not found")

	// ErrTamperedKey indicates the stored key has been corrupted or tampered with.
	ErrTamperedKey = errors.New("keystore: key integrity check failed (tampered or corrupted)")

	// ErrPermissionDenied indicates file permissions are too open or inaccessible.
	ErrPermissionDenied = errors.New("keystore: insecure permissions (must be 0600)")
)

// KeyStore provides an abstraction for hardware-backed or secure file-backed key storage.
type KeyStore interface {
	// StoreKey saves a private key under the specified alias.
	StoreKey(alias string, key []byte) error

	// LoadKey retrieves a private key by alias.
	LoadKey(alias string) ([]byte, error)

	// DeleteKey securely removes a private key by alias.
	DeleteKey(alias string) error

	// BackendType returns a human-readable identifier of the keystore provider
	// (e.g. "windows_dpapi", "linux_tpm2", "apple_secure_enclave", "secure_file_0600").
	BackendType() string
}
