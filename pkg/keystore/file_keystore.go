package keystore

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"sync"

	"golang.org/x/crypto/hkdf"
)

const (
	saltFileName = ".keystore_salt"
	backendFile  = "secure_file_0600"
)

// FileKeyStore implements KeyStore using AES-256-GCM encrypted files with strict 0600 permissions.
type FileKeyStore struct {
	dir    string
	mu     sync.RWMutex
	encKey []byte
}

// NewFileKeyStore initializes a secure file-based keystore in the specified directory.
func NewFileKeyStore(dir string) (*FileKeyStore, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("creating keystore directory: %w", err)
	}

	// Read or generate machine salt
	saltPath := filepath.Join(dir, saltFileName)
	salt, err := os.ReadFile(saltPath)
	if os.IsNotExist(err) {
		salt = make([]byte, 32)
		if _, err := rand.Read(salt); err != nil {
			return nil, fmt.Errorf("generating keystore salt: %w", err)
		}
		if err := os.WriteFile(saltPath, salt, 0o600); err != nil {
			return nil, fmt.Errorf("persisting keystore salt: %w", err)
		}
	} else if err != nil {
		return nil, fmt.Errorf("reading keystore salt: %w", err)
	}

	// Derive AES-256-GCM encryption key via HKDF-SHA256
	secret := getMachineSecret()
	h := hkdf.New(sha256.New, secret, salt, []byte("NeroNet-Keystore-v4-Binding"))
	encKey := make([]byte, 32)
	if _, err := io.ReadFull(h, encKey); err != nil {
		return nil, fmt.Errorf("deriving keystore key: %w", err)
	}

	return &FileKeyStore{
		dir:    dir,
		encKey: encKey,
	}, nil
}

func (fs *FileKeyStore) BackendType() string {
	return backendFile
}

func (fs *FileKeyStore) keyPath(alias string) string {
	hasher := sha256.Sum256([]byte(alias))
	filename := fmt.Sprintf("%x.key", hasher[:16])
	return filepath.Join(fs.dir, filename)
}

// StoreKey encrypts and atomically writes the key with 0600 permissions.
func (fs *FileKeyStore) StoreKey(alias string, key []byte) error {
	fs.mu.Lock()
	defer fs.mu.Unlock()

	block, err := aes.NewCipher(fs.encKey)
	if err != nil {
		return err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return err
	}

	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return err
	}

	// Additional data binds ciphertext to alias
	ad := []byte(alias)
	ciphertext := gcm.Seal(nonce, nonce, key, ad)

	targetPath := fs.keyPath(alias)
	tmpPath := fmt.Sprintf("%s.tmp.%d", targetPath, randInt())

	f, err := os.OpenFile(tmpPath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}

	if _, err := f.Write(ciphertext); err != nil {
		_ = f.Close()
		_ = os.Remove(tmpPath)
		return err
	}
	if err := f.Sync(); err != nil {
		_ = f.Close()
		_ = os.Remove(tmpPath)
		return err
	}
	if err := f.Close(); err != nil {
		_ = os.Remove(tmpPath)
		return err
	}

	return os.Rename(tmpPath, targetPath)
}

// LoadKey reads and decrypts the key, verifying its integrity and permissions.
func (fs *FileKeyStore) LoadKey(alias string) ([]byte, error) {
	fs.mu.RLock()
	defer fs.mu.RUnlock()

	targetPath := fs.keyPath(alias)
	info, err := os.Stat(targetPath)
	if os.IsNotExist(err) {
		return nil, ErrKeyNotFound
	}
	if err != nil {
		return nil, err
	}

	// Enforce strict file permissions on POSIX systems
	if runtime.GOOS != "windows" {
		mode := info.Mode().Perm()
		if mode&0o077 != 0 {
			return nil, fmt.Errorf("%w: current mode %04o exceeds 0600", ErrPermissionDenied, mode)
		}
	}

	data, err := os.ReadFile(targetPath)
	if err != nil {
		return nil, err
	}

	block, err := aes.NewCipher(fs.encKey)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}

	nonceSize := gcm.NonceSize()
	if len(data) < nonceSize {
		return nil, ErrTamperedKey
	}

	nonce, ciphertext := data[:nonceSize], data[nonceSize:]
	ad := []byte(alias)
	plaintext, err := gcm.Open(nil, nonce, ciphertext, ad)
	if err != nil {
		return nil, ErrTamperedKey
	}

	return plaintext, nil
}

// DeleteKey zeroes out the key file before removing it (crypto-shredding).
func (fs *FileKeyStore) DeleteKey(alias string) error {
	fs.mu.Lock()
	defer fs.mu.Unlock()

	targetPath := fs.keyPath(alias)
	info, err := os.Stat(targetPath)
	if os.IsNotExist(err) {
		return nil // idempotent deletion
	}
	if err != nil {
		return err
	}

	// Overwrite with random bytes
	zeroes := make([]byte, info.Size())
	_ = os.WriteFile(targetPath, zeroes, 0o600)

	return os.Remove(targetPath)
}

func getMachineSecret() []byte {
	// 1. Try Linux /etc/machine-id
	for _, p := range []string{"/etc/machine-id", "/var/lib/dbus/machine-id"} {
		if data, err := os.ReadFile(p); err == nil && len(data) > 0 {
			return data
		}
	}
	// 2. Fallback to host info
	hostname, _ := os.Hostname()
	return []byte(hostname + runtime.GOOS + runtime.GOARCH)
}

func randInt() int64 {
	var b [8]byte
	_, _ = rand.Read(b[:])
	var val int64
	for i := 0; i < 8; i++ {
		val = (val << 8) | int64(b[i])
	}
	if val < 0 {
		return -val
	}
	return val
}
