//go:build !darwin

package keystore

import "errors"

type EnclaveKeyStore struct{}

func NewEnclaveKeyStore(dir string) (*EnclaveKeyStore, error) {
	return nil, errors.New("Secure Enclave is only supported on macOS/Darwin")
}

func (e *EnclaveKeyStore) BackendType() string {
	return "apple_secure_enclave"
}

func (e *EnclaveKeyStore) StoreKey(alias string, key []byte) error {
	return errors.New("Secure Enclave is only supported on macOS/Darwin")
}

func (e *EnclaveKeyStore) LoadKey(alias string) ([]byte, error) {
	return nil, errors.New("Secure Enclave is only supported on macOS/Darwin")
}

func (e *EnclaveKeyStore) DeleteKey(alias string) error {
	return errors.New("Secure Enclave is only supported on macOS/Darwin")
}
