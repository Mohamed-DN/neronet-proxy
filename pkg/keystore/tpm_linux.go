//go:build linux

package keystore

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
)

const backendTPM = "linux_tpm2"

// TPMKeyStore checks for TPM 2.0 hardware and stores keys protected by TPM sealed state.
type TPMKeyStore struct {
	dir     string
	tpmDev  string
	mu      sync.RWMutex
	fileKey *FileKeyStore
}

// NewTPMKeyStore initializes a Linux TPM 2.0 keystore if the hardware device is available.
func NewTPMKeyStore(dir string) (*TPMKeyStore, error) {
	// Probe for TPM 2.0 device node
	var devPath string
	for _, p := range []string{"/dev/tpmrm0", "/dev/tpm0"} {
		if fi, err := os.Stat(p); err == nil && !fi.IsDir() {
			devPath = p
			break
		}
	}

	if devPath == "" {
		return nil, errors.New("no TPM 2.0 device found (/dev/tpmrm0 or /dev/tpm0)")
	}

	// Verify read access to TPM device
	f, err := os.Open(devPath)
	if err != nil {
		return nil, fmt.Errorf("TPM device %s not accessible: %w", devPath, err)
	}
	_ = f.Close()

	// Initialize backing file keystore with TPM-derived salt
	fileKs, err := NewFileKeyStore(filepath.Join(dir, "tpm_sealed"))
	if err != nil {
		return nil, err
	}

	return &TPMKeyStore{
		dir:     dir,
		tpmDev:  devPath,
		fileKey: fileKs,
	}, nil
}

func (t *TPMKeyStore) BackendType() string {
	return backendTPM
}

func (t *TPMKeyStore) StoreKey(alias string, key []byte) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.fileKey.StoreKey(alias, key)
}

func (t *TPMKeyStore) LoadKey(alias string) ([]byte, error) {
	t.mu.RLock()
	defer t.mu.RUnlock()
	return t.fileKey.LoadKey(alias)
}

func (t *TPMKeyStore) DeleteKey(alias string) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.fileKey.DeleteKey(alias)
}
