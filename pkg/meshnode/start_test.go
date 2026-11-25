package meshnode

import (
	"context"
	"net"
	"path/filepath"
	"strings"
	"testing"
)

func freeAddr(t *testing.T) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := ln.Addr().String()
	_ = ln.Close()
	return addr
}

// A library that ends the process on a bad setting cannot be embedded. Start returns the error, after
// stopping whatever it had started, where the binary used to call log.Fatalf.
func TestStartReturnsErrorsInsteadOfEndingTheProcess(t *testing.T) {
	dir := t.TempDir()

	// An open proxy beyond loopback without credentials is refused, as the binary always did.
	_, err := Start(context.Background(), Params{
		SocksAddr:    "0.0.0.0:0",
		IdentityPath: filepath.Join(dir, "a.key"),
		ControlURL:   "http://127.0.0.1:1",
	})
	if err == nil || !strings.Contains(err.Error(), "Refusing to start") {
		t.Fatalf("got %v", err)
	}

	// A later failure stops the proxies that were already listening.
	socks := freeAddr(t)
	_, err = Start(context.Background(), Params{
		SocksAddr:    socks,
		IdentityPath: filepath.Join(dir, "b.key"),
		ControlURL:   "http://127.0.0.1:1",
		CountryCode:  "not-a-country",
	})
	if err == nil || !strings.Contains(err.Error(), "Invalid -country") {
		t.Fatalf("got %v", err)
	}
	ln, lerr := net.Listen("tcp", socks)
	if lerr != nil {
		t.Fatalf("the SOCKS5 proxy of a node that failed to start is still listening: %v", lerr)
	}
	_ = ln.Close()
}

// A node can be embedded without the proxies the binary has: empty addresses start none.
func TestEmptyProxyAddressesStartNoProxy(t *testing.T) {
	_, err := Start(context.Background(), Params{
		IdentityPath: filepath.Join(t.TempDir(), "c.key"),
		ControlURL:   "http://127.0.0.1:1",
		CountryCode:  "not-a-country",
	})
	if err == nil || !strings.Contains(err.Error(), "Invalid -country") {
		t.Fatalf("the node failed on something other than the setting under test: %v", err)
	}
}

func TestHandleStopIsIdempotent(t *testing.T) {
	calls := 0
	h := &Handle{closers: []func(){func() { calls++ }}, nodeID: &currentNodeID{}, netmaps: &netmapHolder{}}
	h.Stop()
	h.Stop()
	if calls != 1 {
		t.Errorf("closers ran %d times", calls)
	}
	if h.NodeID() != "" || h.NetmapVersion() != 0 {
		t.Error("a handle with nothing registered reports a node")
	}
}
