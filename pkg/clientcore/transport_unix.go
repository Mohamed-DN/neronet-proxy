//go:build linux

package clientcore

import (
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"syscall"
)

// UnixTransport serves the local API on a unix socket and admits only the peers it names.
//
// Two checks, so that a mistake in one is not the whole defence: the socket file is 0600
// and owned by the installation's user, and every accepted connection's peer credentials
// (SO_PEERCRED, set by the kernel and not forgeable by the peer) must be that user or root.
// A listener on a TCP port would be reachable by every user and every web page on the
// machine, so there is none.
type UnixTransport struct {
	// Path of the socket. Its directory is created 0700 if missing.
	Path string
	// OwnerUID is the user of the installation. root (0) is always admitted too.
	OwnerUID uint32
	// FileMode overrides the socket mode; tests set it open to prove the peer check alone refuses.
	FileMode os.FileMode
}

// Listen creates the socket.
func (t UnixTransport) Listen() (net.Listener, error) {
	if t.Path == "" || !filepath.IsAbs(t.Path) {
		return nil, errors.New("clientcore: socket path must be absolute")
	}
	if err := os.MkdirAll(filepath.Dir(t.Path), 0o700); err != nil {
		return nil, err
	}
	// Remove a stale socket, and only a socket: never a file somebody put there.
	if fi, err := os.Lstat(t.Path); err == nil {
		if fi.Mode()&os.ModeSocket == 0 {
			return nil, fmt.Errorf("clientcore: %s exists and is not a socket", t.Path)
		}
		if err := os.Remove(t.Path); err != nil {
			return nil, err
		}
	}
	old := syscall.Umask(0o177)
	ln, err := net.Listen("unix", t.Path)
	syscall.Umask(old)
	if err != nil {
		return nil, err
	}
	mode := t.FileMode
	if mode == 0 {
		mode = 0o600
	}
	if err := os.Chmod(t.Path, mode); err != nil {
		_ = ln.Close()
		return nil, err
	}
	if os.Geteuid() == 0 && t.OwnerUID != 0 {
		if err := os.Chown(t.Path, int(t.OwnerUID), -1); err != nil {
			_ = ln.Close()
			return nil, err
		}
	}
	return ln, nil
}

// Authorize reads the kernel's record of who is on the other end.
func (t UnixTransport) Authorize(conn net.Conn) (Peer, error) {
	uc, ok := conn.(*net.UnixConn)
	if !ok {
		return Peer{}, errors.New("clientcore: not a unix connection")
	}
	raw, err := uc.SyscallConn()
	if err != nil {
		return Peer{}, err
	}
	var cred *syscall.Ucred
	var cerr error
	if err := raw.Control(func(fd uintptr) {
		cred, cerr = syscall.GetsockoptUcred(int(fd), syscall.SOL_SOCKET, syscall.SO_PEERCRED)
	}); err != nil {
		return Peer{}, err
	}
	if cerr != nil {
		return Peer{}, cerr
	}
	p := Peer{UID: cred.Uid, GID: cred.Gid, PID: cred.Pid}
	if p.UID != 0 && p.UID != t.OwnerUID {
		return p, errors.New("clientcore: peer is not the installation's user")
	}
	return p, nil
}
