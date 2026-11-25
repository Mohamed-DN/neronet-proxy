//go:build linux

package clientcore

import (
	"context"
	"errors"
	"fmt"
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
	errc := make(chan error, 1)
	go func() { errc <- srv.Serve(ctx); close(done) }()
	t.Cleanup(func() { cancel(); <-done })
	for i := 0; i < 300; i++ {
		select {
		case err := <-errc:
			t.Fatalf("server stopped: %v", err)
		default:
		}
		if _, err := os.Stat(tr.SocketPath()); err == nil {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("socket never appeared")
}

// runDir is a directory the service may use: owned by the user running the test, 0755, in a
// temporary directory of its own.
func runDir(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("", "ncore")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	if err := os.Chmod(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	real, err := filepath.EvalSymlinks(dir)
	if err != nil {
		t.Fatal(err)
	}
	run := filepath.Join(real, "run")
	if err := os.Mkdir(run, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(run, 0o755); err != nil {
		t.Fatal(err)
	}
	return run
}

func me() uint32 { return uint32(os.Geteuid()) }

func TestUnixSocketLivesInAPrivateDirectoryOfItsOwner(t *testing.T) {
	run := runDir(t)
	tr := UnixTransport{RunDir: run, OwnerUID: me()}
	serveUnix(t, tr)
	inst := filepath.Dir(tr.SocketPath())
	di, err := os.Lstat(inst)
	if err != nil {
		t.Fatal(err)
	}
	if di.Mode().Perm()&0o077 != 0 {
		t.Errorf("the owner's directory is %v, it must admit nobody else", di.Mode().Perm())
	}
	if st := di.Sys().(*syscall.Stat_t); st.Uid != me() {
		t.Errorf("the owner's directory belongs to uid %d", st.Uid)
	}
	conn, err := DialUnix(tr.SocketPath(), me())
	if err != nil {
		t.Fatal(err)
	}
	cl := NewClient(conn)
	defer cl.Close()
	if r, err := cl.Do("state.get", nil); err != nil || !r.OK {
		t.Errorf("the owner was refused: %+v %v", r, err)
	}
}

func TestListenRefusesAnUnsafeRunDirectory(t *testing.T) {
	// Writable by everybody: another user could swap the owner's directory for their own.
	open := runDir(t)
	if err := os.Chmod(open, 0o777); err != nil {
		t.Fatal(err)
	}
	if _, err := (UnixTransport{RunDir: open, OwnerUID: me()}).Listen(); err == nil {
		t.Error("a 0777 run directory was accepted")
	}
	group := runDir(t)
	if err := os.Chmod(group, 0o775); err != nil {
		t.Fatal(err)
	}
	if _, err := (UnixTransport{RunDir: group, OwnerUID: me()}).Listen(); err == nil {
		t.Error("a group-writable run directory was accepted")
	}
	if _, err := (UnixTransport{RunDir: "relative/run", OwnerUID: me()}).Listen(); err == nil {
		t.Error("a relative run directory was accepted")
	}
	if _, err := (UnixTransport{RunDir: filepath.Join(runDir(t), "missing"), OwnerUID: me()}).Listen(); err == nil {
		t.Error("a missing run directory was created on the fly instead of refused")
	}
	// A run directory that is itself reached through a symlink.
	real := runDir(t)
	link := filepath.Join(filepath.Dir(real), "link")
	if err := os.Symlink(real, link); err != nil {
		t.Fatal(err)
	}
	if _, err := (UnixTransport{RunDir: link, OwnerUID: me()}).Listen(); err == nil {
		t.Error("a symlinked run directory was accepted")
	}
}

func TestASymlinkInPlaceOfTheOwnersDirectoryLeavesItsTargetUntouched(t *testing.T) {
	run := runDir(t)
	victim := filepath.Join(filepath.Dir(run), "victim")
	if err := os.Mkdir(victim, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(victim, 0o755); err != nil {
		t.Fatal(err)
	}
	before, _ := os.Stat(victim)
	if err := os.Symlink(victim, filepath.Join(run, fmt.Sprint(me()))); err != nil {
		t.Fatal(err)
	}
	if _, err := (UnixTransport{RunDir: run, OwnerUID: me()}).Listen(); err == nil {
		t.Error("listened through a symlink planted where the owner's directory belongs")
	}
	after, _ := os.Stat(victim)
	if after.Mode() != before.Mode() {
		t.Errorf("the symlink target's mode changed from %v to %v", before.Mode(), after.Mode())
	}
	entries, _ := os.ReadDir(victim)
	if len(entries) != 0 {
		t.Errorf("something was created in the symlink target: %v", entries)
	}
	// A directory of the owner's that is not private is refused, not repaired by chmod.
	run2 := runDir(t)
	inst := filepath.Join(run2, fmt.Sprint(me()))
	if err := os.Mkdir(inst, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(inst, 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := (UnixTransport{RunDir: run2, OwnerUID: me()}).Listen(); err == nil {
		t.Error("an owner directory open to others was accepted")
	}
	if fi, _ := os.Stat(inst); fi.Mode().Perm() != 0o755 {
		t.Errorf("the directory was chmod-ed to %v instead of refused", fi.Mode().Perm())
	}
}

func TestListenRefusesToReplaceAFileThatIsNotASocket(t *testing.T) {
	run := runDir(t)
	tr := UnixTransport{RunDir: run, OwnerUID: me()}
	inst := filepath.Dir(tr.SocketPath())
	if err := os.Mkdir(inst, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(tr.SocketPath(), []byte("precious"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := tr.Listen(); err == nil {
		t.Error("listened over a regular file")
	}
	if b, _ := os.ReadFile(tr.SocketPath()); string(b) != "precious" {
		t.Error("the file was damaged")
	}
}

// A socket that somebody else bound at the path is not the service. The client says so before
// it sends anything.
func TestClientRefusesASquattedSocket(t *testing.T) {
	run := runDir(t)
	tr := UnixTransport{RunDir: run, OwnerUID: me()}
	serveUnix(t, tr)
	// The server on that socket runs as this user; a client that expects the service user to be
	// somebody else must refuse to talk to it, and must say nothing to it.
	if _, err := DialUnix(tr.SocketPath(), me()+1); err == nil {
		t.Error("the client talked to a server that is not the expected user")
	} else if !strings.Contains(err.Error(), "not the expected") {
		t.Errorf("unexpected error: %v", err)
	}
	if conn, err := DialUnix(tr.SocketPath(), me()); err != nil {
		t.Errorf("the real service was refused: %v", err)
	} else {
		_ = conn.Close()
	}
}

// The negative proof: another local user cannot use the socket. Two independent defences are
// shown separately. With the default directory the kernel refuses another user at the door. With
// the directory and socket deliberately opened to everyone (a misconfiguration, or a descriptor
// passed on), the peer credential check alone refuses the connection before any command is read.
func TestAnotherLocalUserCannotUseTheSocket(t *testing.T) {
	if os.Getuid() == 0 {
		t.Run("private directory, as another user", func(t *testing.T) {
			run := runDir(t)
			tr := UnixTransport{RunDir: run, OwnerUID: 0}
			serveUnix(t, tr)
			out := runAs(t, otherUID, tr.SocketPath())
			if !strings.Contains(out, "REFUSED-AT-CONNECT") {
				t.Errorf("another user connected to the owner's private directory: %s", out)
			}
		})
		t.Run("open directory, peer credentials alone refuse", func(t *testing.T) {
			run := runDir(t)
			tr := UnixTransport{RunDir: run, OwnerUID: 0, testOpen: true}
			serveUnix(t, tr)
			out := runAs(t, otherUID, tr.SocketPath())
			if !strings.Contains(out, "CONNECTED-THEN-REFUSED") {
				t.Errorf("another user was served over an open socket: %s", out)
			}
			if strings.Contains(out, "SERVED") {
				t.Errorf("another user got an answer: %s", out)
			}
		})
		return
	}
	// Without root a service cannot hand the directory to somebody else, so it must refuse to start for
	// them rather than serve from a directory they do not own. The peer-credential refusal itself needs
	// two users and is the root case above.
	t.Run("an unprivileged service refuses to start for another user", func(t *testing.T) {
		tr := UnixTransport{RunDir: runDir(t), OwnerUID: me() + 1, testOpen: true}
		ln, err := tr.Listen()
		if err == nil {
			_ = ln.Close()
			t.Fatal("it listened for a user it cannot hand the directory to")
		}
		if !errors.Is(err, os.ErrPermission) {
			t.Errorf("unexpected error: %v", err)
		}
		if _, err := os.Lstat(tr.SocketPath()); err == nil {
			t.Error("a socket was left behind")
		}
	})
}

// Ownership is per installation: root is not the owner and is not admitted unless asked.
func TestRootIsNotAdmittedToAnotherUsersInstallation(t *testing.T) {
	if os.Getuid() != 0 {
		t.Skip("needs root to be the connecting user")
	}
	run := runDir(t)
	tr := UnixTransport{RunDir: run, OwnerUID: otherUID, testOpen: true}
	serveUnix(t, tr)
	conn, err := net.Dial("unix", tr.SocketPath())
	if err != nil {
		t.Fatal(err)
	}
	cl := NewClient(conn)
	defer cl.Close()
	if r, err := cl.Do("state.get", nil); err == nil {
		t.Errorf("root controlled another user's installation: %+v", r)
	}
	run2 := runDir(t)
	tr2 := UnixTransport{RunDir: run2, OwnerUID: otherUID, AdmitRoot: true}
	serveUnix(t, tr2)
	conn2, err := DialUnix(tr2.SocketPath(), 0)
	if err != nil {
		t.Fatal(err)
	}
	cl2 := NewClient(conn2)
	defer cl2.Close()
	if r, err := cl2.Do("state.get", nil); err != nil || !r.OK {
		t.Errorf("root was refused although admitted explicitly: %+v %v", r, err)
	}
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
	exe := filepath.Join(filepath.Dir(filepath.Dir(filepath.Dir(path))), "helper.test")
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

// What the owner reaches is a socket the service made without opening it to everybody: owned by the
// owner, no write for anyone else.
func TestSocketIsHandedToItsOwnerNotOpenedToEveryone(t *testing.T) {
	if os.Getuid() != 0 {
		t.Skip("handing a socket to another user needs root")
	}
	run := runDir(t)
	tr := UnixTransport{RunDir: run, OwnerUID: otherUID}
	serveUnix(t, tr)
	fi, err := os.Lstat(tr.SocketPath())
	if err != nil {
		t.Fatal(err)
	}
	if st := fi.Sys().(*syscall.Stat_t); st.Uid != otherUID {
		t.Errorf("the socket belongs to uid %d, not its owner", st.Uid)
	}
	if fi.Mode().Perm()&0o002 != 0 {
		t.Errorf("the socket is writable by everybody: %v", fi.Mode().Perm())
	}
}

// A crash between making the owner's directory and handing it over leaves a directory of the service.
// The next start finishes the job instead of refusing for ever, but only for a plain, empty, private one.
func TestAHalfMadeOwnerDirectoryIsCompletedSafely(t *testing.T) {
	if os.Getuid() != 0 {
		t.Skip("handing a directory to another user needs root")
	}
	run := runDir(t)
	inst := filepath.Join(run, fmt.Sprint(otherUID))
	if err := os.Mkdir(inst, 0o700); err != nil {
		t.Fatal(err)
	}
	tr := UnixTransport{RunDir: run, OwnerUID: otherUID}
	serveUnix(t, tr)
	if st := statOfPath(t, inst); st.Uid != otherUID {
		t.Errorf("the half-made directory was not handed to its owner: uid %d", st.Uid)
	}
	// One that holds something is not completed: it is somebody's.
	run2 := runDir(t)
	inst2 := filepath.Join(run2, fmt.Sprint(otherUID))
	if err := os.Mkdir(inst2, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(inst2, "secret"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := (UnixTransport{RunDir: run2, OwnerUID: otherUID}).Listen(); err == nil {
		t.Error("a directory that holds files was taken over")
	}
	if st := statOfPath(t, inst2); st.Uid == otherUID {
		t.Error("a directory that holds files was chowned")
	}
}

func statOfPath(t *testing.T, p string) *syscall.Stat_t {
	t.Helper()
	fi, err := os.Lstat(p)
	if err != nil {
		t.Fatal(err)
	}
	return fi.Sys().(*syscall.Stat_t)
}

// The service runs as root. A symlink planted where the socket belongs must not make it change the
// owner or the mode of whatever the link points at.
func TestASymlinkAtTheSocketPathLeavesItsTargetUntouched(t *testing.T) {
	run := runDir(t)
	tr := UnixTransport{RunDir: run, OwnerUID: me()}
	inst := filepath.Dir(tr.SocketPath())
	if err := os.Mkdir(inst, 0o700); err != nil {
		t.Fatal(err)
	}
	victim := filepath.Join(filepath.Dir(run), "victim")
	if err := os.WriteFile(victim, []byte("precious"), 0o640); err != nil {
		t.Fatal(err)
	}
	before := statOfPath(t, victim)
	if err := os.Symlink(victim, tr.SocketPath()); err != nil {
		t.Fatal(err)
	}
	if _, err := tr.Listen(); err == nil {
		t.Error("listened over a symlink")
	}
	after := statOfPath(t, victim)
	if after.Uid != before.Uid || after.Mode != before.Mode {
		t.Errorf("the target of the symlink was changed: %o/%d -> %o/%d", before.Mode, before.Uid, after.Mode, after.Uid)
	}
	if b, _ := os.ReadFile(victim); string(b) != "precious" {
		t.Error("the target was damaged")
	}
}
