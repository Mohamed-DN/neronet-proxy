//go:build linux

package clientcore

import (
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"syscall"
)

// UnixTransport serves the local API on a unix socket that only its installation's owner can reach.
//
// The service usually runs as root, so everything it does to the file system is done as if an
// attacker were racing it. Three layers, none of which relies on the others:
//
//   - RunDir (for example /run/neronet) must already exist, be the service user's, be reached
//     without a symlink, and not be writable by group or other, nor any directory above it unless
//     that is a sticky directory like /tmp. It is never created or repaired here.
//   - Inside it, one directory per owner (RunDir/<uid>), mode 0700 and owned by that user. A directory
//     that exists is checked, not fixed: a symlink, another owner or a wider mode is refused. A new
//     one is made 0700 and handed to the owner with Lchown, inside a parent nobody else can write.
//     The socket is created inside it with no chmod or chown by path afterwards, so there is no
//     moment at which a path the attacker controls is followed by a privileged call.
//   - Every connection's peer credentials (SO_PEERCRED, set by the kernel and not forgeable by the
//     peer) must be the owner (root only with AdmitRoot).
//
// A listener on a TCP port would be reachable by every user and every web page on the machine, so
// there is none.
type UnixTransport struct {
	// RunDir is the existing, verified directory that holds one directory per owner.
	RunDir string
	// OwnerUID is the user the installation belongs to. Each installation (profile) is owned by one
	// local user and only that user may control it, as with NetBird 0.83's per-profile ownership.
	OwnerUID uint32
	// AdmitRoot also admits uid 0. Off by default: root can read the owner's files anyway, but the
	// API does not hand it control implicitly, and a service tool that needs it says so.
	AdmitRoot bool
	// testOpen widens directory and socket access so that tests can show the peer check alone refusing.
	testOpen bool
}

const socketName = "core.sock"

// SocketPath is where the owner's socket is.
func (t UnixTransport) SocketPath() string {
	return filepath.Join(t.RunDir, strconv.FormatUint(uint64(t.OwnerUID), 10), socketName)
}

func statOf(fi os.FileInfo) *syscall.Stat_t {
	st, _ := fi.Sys().(*syscall.Stat_t)
	return st
}

// verifyRunDir refuses a run directory somebody else could have changed.
func verifyRunDir(dir string) error {
	if dir == "" || !filepath.IsAbs(dir) || filepath.Clean(dir) != dir {
		return errors.New("clientcore: run directory must be a clean absolute path")
	}
	real, err := filepath.EvalSymlinks(dir)
	if err != nil {
		return fmt.Errorf("clientcore: run directory unusable: %w", err)
	}
	if real != dir {
		return errors.New("clientcore: run directory is reached through a symlink")
	}
	euid := uint32(os.Geteuid())
	fi, err := os.Lstat(dir)
	if err != nil {
		return err
	}
	st := statOf(fi)
	if !fi.IsDir() || st == nil || st.Uid != euid {
		return errors.New("clientcore: run directory must be a directory owned by the service user")
	}
	if fi.Mode().Perm()&0o022 != 0 {
		return errors.New("clientcore: run directory is writable by group or others")
	}
	for p := filepath.Dir(dir); ; p = filepath.Dir(p) {
		ai, err := os.Lstat(p)
		if err != nil {
			return err
		}
		ast := statOf(ai)
		if !ai.IsDir() || ast == nil || (ast.Uid != 0 && ast.Uid != euid) {
			return fmt.Errorf("clientcore: %s above the run directory is not a directory of root or the service user", p)
		}
		if ai.Mode().Perm()&0o022 != 0 && ai.Mode()&os.ModeSticky == 0 {
			return fmt.Errorf("clientcore: %s above the run directory is writable by group or others", p)
		}
		if p == "/" {
			return nil
		}
	}
}

// Listen creates the socket.
func (t UnixTransport) Listen() (net.Listener, error) {
	if err := verifyRunDir(t.RunDir); err != nil {
		return nil, err
	}
	euid := uint32(os.Geteuid())
	if !t.testOpen && t.OwnerUID != euid && euid != 0 {
		return nil, errors.New("clientcore: only root can serve another user's installation")
	}
	inst := filepath.Dir(t.SocketPath())
	fi, err := os.Lstat(inst)
	switch {
	case os.IsNotExist(err):
		if err := os.Mkdir(inst, 0o700); err != nil {
			return nil, err
		}
		if t.testOpen {
			if err := os.Chmod(inst, 0o755); err != nil {
				return nil, err
			}
		}
		if t.OwnerUID != euid {
			if err := os.Lchown(inst, int(t.OwnerUID), -1); err != nil {
				return nil, err
			}
		}
	case err != nil:
		return nil, err
	default:
		st := statOf(fi)
		if fi.Mode()&os.ModeSymlink != 0 || !fi.IsDir() || st == nil {
			return nil, fmt.Errorf("clientcore: %s is not a plain directory", inst)
		}
		if !t.testOpen && (st.Uid != t.OwnerUID || fi.Mode().Perm()&0o077 != 0) {
			return nil, fmt.Errorf("clientcore: %s must belong to the owner and be private (mode 0700); it is not repaired automatically", inst)
		}
	}
	sock := t.SocketPath()
	if fi, err := os.Lstat(sock); err == nil {
		if fi.Mode()&os.ModeSocket == 0 {
			return nil, fmt.Errorf("clientcore: %s exists and is not a socket", sock)
		}
		if err := os.Remove(sock); err != nil {
			return nil, err
		}
	}
	// Created fully open: the owner's private directory is what keeps everyone else out, and there
	// is no chmod or chown by path afterwards for a racer to redirect.
	old := syscall.Umask(0)
	ln, err := net.Listen("unix", sock)
	syscall.Umask(old)
	if err != nil {
		return nil, err
	}
	return ln, nil
}

func peerOf(conn net.Conn) (Peer, error) {
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
	return Peer{UID: cred.Uid, GID: cred.Gid, PID: cred.Pid}, nil
}

// Authorize reads the kernel's record of who is on the other end.
func (t UnixTransport) Authorize(conn net.Conn) (Peer, error) {
	p, err := peerOf(conn)
	if err != nil {
		return Peer{}, err
	}
	if p.UID != t.OwnerUID && !(t.AdmitRoot && p.UID == 0) {
		return p, errors.New("clientcore: peer is not the installation's user")
	}
	return p, nil
}

// DialUnix connects to the service's socket and checks who is listening before anything is sent: a
// socket that another user bound at that path is not the service, and a client that spoke to it
// would hand it the person's commands. wantUID is the user the service runs as (0 for a system service).
func DialUnix(path string, wantUID uint32) (net.Conn, error) {
	conn, err := net.Dial("unix", path)
	if err != nil {
		return nil, err
	}
	p, err := peerOf(conn)
	if err != nil {
		_ = conn.Close()
		return nil, err
	}
	if p.UID != wantUID {
		_ = conn.Close()
		return nil, fmt.Errorf("clientcore: the socket's server is uid %d, not the expected service user", p.UID)
	}
	return conn, nil
}
