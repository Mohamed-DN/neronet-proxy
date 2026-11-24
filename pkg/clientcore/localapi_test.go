package clientcore

import (
	"context"
	"errors"
	"io"
	"net"
	"strings"
	"testing"
	"time"
)

// memTransport serves the API over in-memory connections, so the command handling is tested
// on every platform. The transport's own security is tested in transport_unix_test.go.
type memTransport struct {
	conns chan net.Conn
	deny  bool
}

func (m *memTransport) Listen() (net.Listener, error) { return &memListener{m: m}, nil }
func (m *memTransport) Authorize(net.Conn) (Peer, error) {
	if m.deny {
		return Peer{}, errors.New("no")
	}
	return Peer{}, nil
}

type memListener struct{ m *memTransport }

func (l *memListener) Accept() (net.Conn, error) {
	c, ok := <-l.m.conns
	if !ok {
		return nil, net.ErrClosed
	}
	return c, nil
}
func (l *memListener) Close() error   { return nil }
func (l *memListener) Addr() net.Addr { return &net.UnixAddr{Name: "mem", Net: "unix"} }

func startServer(t *testing.T, core *Core, tr *memTransport) (connect func() *Client) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	srv := NewServer(core, tr)
	go func() { _ = srv.Serve(ctx); close(done) }()
	t.Cleanup(func() {
		cancel()
		close(tr.conns)
		<-done
	})
	return func() *Client {
		a, b := net.Pipe()
		tr.conns <- b
		return NewClient(a)
	}
}

func apiCore(t *testing.T) *Core {
	core, _ := signedInCore(t, &fakeTunnel{})
	return core
}

func TestAPIVersionedCommandsWork(t *testing.T) {
	tr := &memTransport{conns: make(chan net.Conn, 4)}
	cl := startServer(t, apiCore(t), tr)()
	defer cl.Close()

	r, err := cl.Do("state.get", nil)
	if err != nil || !r.OK || r.State.Version != APIVersion || r.State.Phase != PhaseDisconnected {
		t.Fatalf("%+v %v", r, err)
	}
	if r, _ := cl.Do("exit.set", map[string]string{"name": "milano"}); !r.OK || r.State.Exit != "milano" {
		t.Errorf("exit.set: %+v", r)
	}
	if r, _ := cl.Do("order.set", Order{Methods: []Method{MethodWireGuardWSS}, Forced: true}); !r.OK || !r.State.Order.Forced {
		t.Errorf("order.set: %+v", r)
	}
	if r, _ := cl.Do("connect", nil); !r.OK || r.State.Phase != PhaseConnected {
		t.Errorf("connect: %+v", r)
	}
	if r, _ := cl.Do("disconnect", nil); !r.OK || r.State.Phase != PhaseDisconnected {
		t.Errorf("disconnect: %+v", r)
	}
	if r, _ := cl.Do("signout", nil); !r.OK || r.State.Phase != PhaseSignedOut {
		t.Errorf("signout: %+v", r)
	}
}

func TestAPIRefusesEveryKindOfBadInputAndChangesNothing(t *testing.T) {
	core := apiCore(t)
	before := core.State()
	tr := &memTransport{conns: make(chan net.Conn, 8)}
	connect := startServer(t, core, tr)

	raw := map[string]string{
		"not json":        "hello\n",
		"unknown field":   `{"v":1,"id":"1","cmd":"state.get","admin":true}` + "\n",
		"wrong version":   `{"v":2,"id":"1","cmd":"state.get"}` + "\n",
		"no version":      `{"id":"1","cmd":"state.get"}` + "\n",
		"trailing data":   `{"v":1,"id":"1","cmd":"state.get"} {"v":1}` + "\n",
		"long id":         `{"v":1,"id":"` + strings.Repeat("a", 65) + `","cmd":"state.get"}` + "\n",
		"unknown command": `{"v":1,"id":"1","cmd":"shell.exec","args":{"cmd":"id"}}` + "\n",
		"extra arg":       `{"v":1,"id":"1","cmd":"exit.set","args":{"name":"x","also":"y"}}` + "\n",
		"bad exit":        `{"v":1,"id":"1","cmd":"exit.set","args":{"name":"../etc"}}` + "\n",
		"bad order":       `{"v":1,"id":"1","cmd":"order.set","args":{"methods":["tor"]}}` + "\n",
		"args on connect": `{"v":1,"id":"1","cmd":"connect","args":{"force":true}}` + "\n",
	}
	for name, line := range raw {
		cl := connect()
		r, err := cl.Raw([]byte(line))
		cl.Close()
		if err != nil {
			t.Errorf("%s: no answer: %v", name, err)
			continue
		}
		if r.OK || r.Code == "" {
			t.Errorf("%s: accepted: %+v", name, r)
		}
	}
	// An oversize line is refused and the connection is closed.
	cl := connect()
	r, err := cl.Raw([]byte(strings.Repeat("a", maxLine+10) + "\n"))
	if err != nil || r.OK || r.Code != "too_long" {
		t.Errorf("oversize: %+v %v", r, err)
	}
	cl.Close()
	after := core.State()
	if after.Phase != before.Phase || after.Exit != before.Exit || after.Order.Forced != before.Order.Forced || after.Seq != before.Seq {
		t.Errorf("rejected input changed the state: %+v -> %+v", before, after)
	}
}

func TestAPIRefusesAPeerTheTransportRefuses(t *testing.T) {
	tr := &memTransport{conns: make(chan net.Conn, 2), deny: true}
	cl := startServer(t, apiCore(t), tr)()
	defer cl.Close()
	_, err := cl.Do("state.get", nil)
	if err == nil {
		t.Fatal("a refused peer got an answer")
	}
	if !errors.Is(err, io.EOF) && !strings.Contains(err.Error(), "closed") {
		t.Errorf("expected the connection to be closed, got %v", err)
	}
}

func TestAPIWatchStreamsStateChanges(t *testing.T) {
	core := apiCore(t)
	tr := &memTransport{conns: make(chan net.Conn, 2)}
	cl := startServer(t, core, tr)()
	defer cl.Close()
	r, err := cl.Do("state.watch", nil)
	if err != nil || r.State.Phase != PhaseDisconnected {
		t.Fatalf("first frame: %+v %v", r, err)
	}
	go func() { time.Sleep(50 * time.Millisecond); _ = core.SetExit("roma") }()
	next, err := cl.read()
	if err != nil || next.State.Exit != "roma" {
		t.Fatalf("second frame: %+v %v", next, err)
	}
}
