//go:build linux

package clientcore

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

// otherUID is a user that is neither root nor the user running the test.
const otherUID = 41234

func serveUnix(t *testing.T, tr UnixTransport) {
	t.Helper()
	core := apiCore(t)
	ctx, cancel := context.WithCancel(context.Background())
	srv := NewServer(core, tr)
	done := make(chan struct{})
	go func() { _ = srv.Serve(ctx); close(done) }()
	t.Cleanup(func() { cancel(); <-done })
	for i := 0; i < 200; i++ {
		if _, err := os.Stat(tr.Path); err == nil {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("socket never appeared")
}

func socketPath(t *testing.T) string {
	dir, err := os.MkdirTemp("", "ncore")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	if err := os.Chmod(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	return filepath.Join(dir, "api", "core.sock")
}

func TestUnixSocketIsPrivateAndOwnerOnly(t *testing.T) {
	p := socketPath(t)
	serveUnix(t, UnixTransport{Path: p, OwnerUID: uint32(os.Getuid())})
	fi, err := os.Stat(p)
	if err != nil {
		t.Fatal(err)
	}
	if fi.Mode().Perm() != 0o600 {
		t.Errorf("socket mode is %v, want 0600", fi.Mode().Perm())
	}
	di, _ := os.Stat(filepath.Dir(p))
	if di.Mode().Perm() != 0o700 {
		t.Errorf("socket directory mode is %v, want 0700", di.Mode().Perm())
	}
	conn, err := net.Dial("unix", p)
	if err != nil {
		t.Fatal(err)
	}
	cl := NewClient(conn)
	defer cl.Close()
	if r, err := cl.Do("state.get", nil); err != nil || !r.OK {
		t.Errorf("the owner was refused: %+v %v", r, err)
	}
}

func TestUnixListenRefusesToReplaceAFileThatIsNotASocket(t *testing.T) {
	p := socketPath(t)
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte("precious"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := (UnixTransport{Path: p}).Listen(); err == nil {
		t.Error("listened over a regular file")
	}
	if b, _ := os.ReadFile(p); string(b) != "precious" {
		t.Error("the file was damaged")
	}
	if _, err := (UnixTransport{Path: "relative/sock"}).Listen(); err == nil {
		t.Error("relative path accepted")
	}
}

// The negative proof: another local user cannot use the socket. Two independent defences are
// shown separately. With the file mode left at 0600 the kernel refuses the connection. With the
// file mode deliberately opened to everyone (a misconfiguration, or a descriptor passed on),
// the peer credential check alone refuses the connection before any command is read.
func TestAnotherLocalUserCannotUseTheSocket(t *testing.T) {
	if os.Getuid() == 0 {
		t.Run("0600 file mode, as another user", func(t *testing.T) {
			p := socketPath(t)
			serveUnix(t, UnixTransport{Path: p, OwnerUID: 0})
			// The socket's directory is 0700 root; open it for traversal only to show the file itself refuses.
			if err := os.Chmod(filepath.Dir(p), 0o755); err != nil {
				t.Fatal(err)
			}
			out := runAs(t, otherUID, p)
			if !strings.Contains(out, "REFUSED-AT-CONNECT") {
				t.Errorf("another user connected to a 0600 socket: %s", out)
			}
		})
		t.Run("open file mode, peer credentials alone refuse", func(t *testing.T) {
			p := socketPath(t)
			serveUnix(t, UnixTransport{Path: p, OwnerUID: 0, FileMode: 0o666})
			if err := os.Chmod(filepath.Dir(p), 0o755); err != nil {
				t.Fatal(err)
			}
			out := runAs(t, otherUID, p)
			if !strings.Contains(out, "CONNECTED-THEN-REFUSED") {
				t.Errorf("another user was served over an open socket: %s", out)
			}
			if strings.Contains(out, `"ok":true`) {
				t.Errorf("another user got an answer: %s", out)
			}
		})
		return
	}
	// Not root: the owner named is somebody else, so this user is "another local user".
	t.Run("peer credentials refuse a user who is not the owner", func(t *testing.T) {
		p := socketPath(t)
		serveUnix(t, UnixTransport{Path: p, OwnerUID: uint32(os.Getuid()) + 1, FileMode: 0o666})
		conn, err := net.Dial("unix", p)
		if err != nil {
			t.Fatal(err)
		}
		cl := NewClient(conn)
		defer cl.Close()
		if r, err := cl.Do("state.get", nil); err == nil {
			t.Errorf("a user who is not the owner was served: %+v", r)
		} else if !errors.Is(err, io.EOF) && !strings.Contains(err.Error(), "reset") {
			t.Errorf("unexpected error: %v", err)
		}
	})
}

// runAs re-executes this test binary as another uid to behave as a client of the socket.
func runAs(t *testing.T, uid uint32, path string) string {
	t.Helper()
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	// A private copy of the binary in a directory the other user can enter; nothing outside
	// the test's own temp directory has its permissions touched.
	exe := filepath.Join(filepath.Dir(filepath.Dir(path)), "helper.test")
	data, err := os.ReadFile(self)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(exe, data, 0o755); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(exe, "-test.run=^TestHelperClient$")
	cmd.Env = append(os.Environ(), "CLIENTCORE_HELPER_SOCKET="+path)
	cmd.SysProcAttr = &syscall.SysProcAttr{Credential: &syscall.Credential{Uid: uid, Gid: uid}}
	out, err := cmd.CombinedOutput()
	if err != nil && !strings.Contains(string(out), "REFUSED") && !strings.Contains(string(out), "CONNECTED") {
		t.Skipf("cannot run a helper as uid %d here (%v: %s); the non-root path of this test covers the peer check", uid, err, out)
	}
	return string(out)
}

// TestHelperClient is the other user's side; it does nothing unless re-executed by runAs.
func TestHelperClient(t *testing.T) {
	path := os.Getenv("CLIENTCORE_HELPER_SOCKET")
	if path == "" {
		t.Skip("helper only")
	}
	conn, err := net.Dial("unix", path)
	if err != nil {
		fmt.Println("REFUSED-AT-CONNECT", err)
		return
	}
	cl := NewClient(conn)
	defer cl.Close()
	r, err := cl.Do("state.get", nil)
	if err != nil {
		fmt.Println("CONNECTED-THEN-REFUSED", err)
		return
	}
	fmt.Printf("SERVED {\"ok\":%v}\n", r.OK)
}
