//go:build !linux

package keystore

import "errors"

type TPMKeyStore struct{}

func NewTPMKeyStore(dir string) (*TPMKeyStore, error) {
	return nil, errors.New("TPM 2.0 is only supported on Linux")
}

func (t *TPMKeyStore) BackendType() string {
	return "linux_tpm2"
}

func (t *TPMKeyStore) StoreKey(alias string, key []byte) error {
	return errors.New("TPM 2.0 is only supported on Linux")
}

func (t *TPMKeyStore) LoadKey(alias string) ([]byte, error) {
	return nil, errors.New("TPM 2.0 is only supported on Linux")
}

func (t *TPMKeyStore) DeleteKey(alias string) error {
	return errors.New("TPM 2.0 is only supported on Linux")
}
