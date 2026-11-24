//go:build !linux

package clientcore

import (
	"errors"
	"net"
	"os"
)

// ErrNoTransport is returned on platforms whose local transport is not built yet: the
// Windows named pipe with an ACL for the interactive user and administrators is phase 1,
// and macOS reuses the unix socket with LOCAL_PEERCRED when its phase starts. Until then
// the core refuses to listen rather than listening somewhere weaker.
var ErrNoTransport = errors.New("clientcore: no secure local transport on this platform yet")

// UnixTransport is not available here.
type UnixTransport struct {
	Path     string
	OwnerUID uint32
	FileMode os.FileMode
}

// Listen always refuses.
func (UnixTransport) Listen() (net.Listener, error) { return nil, ErrNoTransport }

// Authorize always refuses.
func (UnixTransport) Authorize(net.Conn) (Peer, error) { return Peer{}, ErrNoTransport }
