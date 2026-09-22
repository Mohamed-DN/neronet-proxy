//go:build windows

package keystore

import (
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"syscall"
	"unsafe"
)

var (
	modcrypt32             = syscall.NewLazyDLL("crypt32.dll")
	procCryptProtectData   = modcrypt32.NewProc("CryptProtectData")
	procCryptUnprotectData = modcrypt32.NewProc("CryptUnprotectData")
)

type dataBlob struct {
	cbData uint32
	pbData *byte
}

const (
	cryptProtectUIForbidden = 0x1
	backendDPAPI            = "windows_dpapi"
)

// DPAPIKeyStore uses Windows Data Protection API (DPAPI) to encrypt keys bound to the local user.
type DPAPIKeyStore struct {
	dir string
	mu  sync.RWMutex
}

// NewDPAPIKeyStore initializes a DPAPI-backed keystore.
func NewDPAPIKeyStore(dir string) (*DPAPIKeyStore, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("creating keystore dir: %w", err)
	}
	return &DPAPIKeyStore{dir: dir}, nil
}

func (d *DPAPIKeyStore) BackendType() string {
	return backendDPAPI
}

func (d *DPAPIKeyStore) keyPath(alias string) string {
	return filepath.Join(d.dir, alias+".dpapi")
}

func (d *DPAPIKeyStore) StoreKey(alias string, key []byte) error {
	d.mu.Lock()
	defer d.mu.Unlock()

	if len(key) == 0 {
		return fmt.Errorf("cannot store empty key")
	}

	var inBlob dataBlob
	inBlob.cbData = uint32(len(key))
	inBlob.pbData = &key[0]

	var outBlob dataBlob
	r1, _, err := procCryptProtectData.Call(
		uintptr(unsafe.Pointer(&inBlob)),
		0, // no description
		0, // optional entropy
		0, // reserved
		0, // prompt struct
		cryptProtectUIForbidden,
		uintptr(unsafe.Pointer(&outBlob)),
	)
	if r1 == 0 {
		return fmt.Errorf("CryptProtectData failed: %w", err)
	}
	defer syscall.LocalFree(syscall.Handle(unsafe.Pointer(outBlob.pbData)))

	encrypted := unsafe.Slice(outBlob.pbData, outBlob.cbData)
	target := d.keyPath(alias)
	return os.WriteFile(target, encrypted, 0o600)
}

func (d *DPAPIKeyStore) LoadKey(alias string) ([]byte, error) {
	d.mu.RLock()
	defer d.mu.RUnlock()

	target := d.keyPath(alias)
	data, err := os.ReadFile(target)
	if os.IsNotExist(err) {
		return nil, ErrKeyNotFound
	}
	if err != nil {
		return nil, err
	}

	if len(data) == 0 {
		return nil, ErrTamperedKey
	}

	var inBlob dataBlob
	inBlob.cbData = uint32(len(data))
	inBlob.pbData = &data[0]

	var outBlob dataBlob
	r1, _, err := procCryptUnprotectData.Call(
		uintptr(unsafe.Pointer(&inBlob)),
		0,
		0,
		0,
		0,
		cryptProtectUIForbidden,
		uintptr(unsafe.Pointer(&outBlob)),
	)
	if r1 == 0 {
		return nil, ErrTamperedKey
	}
	defer syscall.LocalFree(syscall.Handle(unsafe.Pointer(outBlob.pbData)))

	decrypted := make([]byte, outBlob.cbData)
	copy(decrypted, unsafe.Slice(outBlob.pbData, outBlob.cbData))
	return decrypted, nil
}

func (d *DPAPIKeyStore) DeleteKey(alias string) error {
	d.mu.Lock()
	defer d.mu.Unlock()

	target := d.keyPath(alias)
	if _, err := os.Stat(target); os.IsNotExist(err) {
		return nil
	}
	_ = os.WriteFile(target, make([]byte, 64), 0o600)
	return os.Remove(target)
}
