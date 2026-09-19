// Command spike-identity creates a node identity key file and prints its public
// key, so the WP-201 spike documents can be written before the nodes start.
//
// It exists because a spike peer document has to name the peer's public key, and
// the node only learns its own after it has started. WP-202 removes the need for
// it: the control plane already stores every node's public key and will serve the
// netmap containing them.
package main

import (
	"encoding/hex"
	"flag"
	"fmt"
	"os"
	"path/filepath"

	"github.com/sovereign/proxy/v4/pkg/crypto"
)

func main() {
	path := flag.String("out", "", "Path of the identity key file to read or create")
	flag.Parse()

	if *path == "" {
		fmt.Fprintln(os.Stderr, "spike-identity: -out is required")
		os.Exit(2)
	}

	pub, err := loadOrCreate(*path)
	if err != nil {
		fmt.Fprintf(os.Stderr, "spike-identity: %v\n", err)
		os.Exit(1)
	}

	fmt.Println(hex.EncodeToString(pub[:]))
}

// loadOrCreate returns the public key of the identity at path, generating the
// identity only when the file is absent. Overwriting an existing key would change
// the node's identity, which is what the node itself is careful not to do.
func loadOrCreate(path string) ([crypto.KeySize]byte, error) {
	var empty [crypto.KeySize]byte

	raw, err := os.ReadFile(path)
	if err == nil {
		if len(raw) != crypto.KeySize {
			return empty, fmt.Errorf("identity at %s is %d bytes, expected %d", path, len(raw), crypto.KeySize)
		}
		var priv [crypto.KeySize]byte
		copy(priv[:], raw)
		return crypto.DH(priv, [crypto.KeySize]byte{9})
	}
	if !os.IsNotExist(err) {
		return empty, fmt.Errorf("cannot read %s: %w", path, err)
	}

	kp, err := crypto.GenerateKeypair()
	if err != nil {
		return empty, err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return empty, err
	}
	if err := os.WriteFile(path, kp.PrivateKey[:], 0o600); err != nil {
		return empty, err
	}
	return kp.PublicKey, nil
}
