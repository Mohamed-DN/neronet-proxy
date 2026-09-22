//go:build !windows

package keystore

import "errors"

// DPAPIKeyStore is a stub on non-Windows platforms.
type DPAPIKeyStore struct{}

func NewDPAPIKeyStore(dir string) (*DPAPIKeyStore, error) {
	return nil, errors.New("DPAPI is only supported on Windows")
}

func (d *DPAPIKeyStore) BackendType() string {
	return "windows_dpapi"
}

func (d *DPAPIKeyStore) StoreKey(alias string, key []byte) error {
	return errors.New("DPAPI is only supported on Windows")
}

func (d *DPAPIKeyStore) LoadKey(alias string) ([]byte, error) {
	return nil, errors.New("DPAPI is only supported on Windows")
}

func (d *DPAPIKeyStore) DeleteKey(alias string) error {
	return errors.New("DPAPI is only supported on Windows")
}
