package keystore

import (
	"fmt"
	"runtime"
)

// NewDefaultKeyStore initializes the strongest available hardware/OS keystore,
// automatically falling back to FileKeyStore with strict 0600 permissions.
func NewDefaultKeyStore(dir string) (KeyStore, error) {
	switch runtime.GOOS {
	case "windows":
		ks, err := NewDPAPIKeyStore(dir)
		if err == nil {
			return ks, nil
		}
	case "linux":
		ks, err := NewTPMKeyStore(dir)
		if err == nil {
			return ks, nil
		}
	case "darwin":
		ks, err := NewEnclaveKeyStore(dir)
		if err == nil {
			return ks, nil
		}
	}

	// High-security fallback: AES-256-GCM encrypted file with 0600 permissions
	return NewFileKeyStore(dir)
}

// NewKeyStoreByBackend creates a keystore with the explicitly requested backend type.
func NewKeyStoreByBackend(backend string, dir string) (KeyStore, error) {
	switch backend {
	case "windows_dpapi":
		return NewDPAPIKeyStore(dir)
	case "linux_tpm2":
		return NewTPMKeyStore(dir)
	case "apple_secure_enclave":
		return NewEnclaveKeyStore(dir)
	case "secure_file_0600", "file":
		return NewFileKeyStore(dir)
	default:
		return nil, fmt.Errorf("unknown keystore backend: %s", backend)
	}
}
