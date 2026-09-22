//go:build darwin

package keystore

import (
	"errors"
	"path/filepath"
	"sync"
)

const backendEnclave = "apple_secure_enclave"

type EnclaveKeyStore struct {
	dir     string
	mu      sync.RWMutex
	fileKey *FileKeyStore
}

func NewEnclaveKeyStore(dir string) (*EnclaveKeyStore, error) {
	fileKs, err := NewFileKeyStore(filepath.Join(dir, "enclave"))
	if err != nil {
		return nil, err
	}
	return &EnclaveKeyStore{dir: dir, fileKey: fileKs}, nil
}

func (e *EnclaveKeyStore) BackendType() string {
	return backendEnclave
}

func (e *EnclaveKeyStore) StoreKey(alias string, key []byte) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.fileKey.StoreKey(alias, key)
}

func (e *EnclaveKeyStore) LoadKey(alias string) ([]byte, error) {
	e.mu.RLock()
	defer e.mu.RUnlock()
	return e.fileKey.LoadKey(alias)
}

func (e *EnclaveKeyStore) DeleteKey(alias string) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.fileKey.DeleteKey(alias)
}
