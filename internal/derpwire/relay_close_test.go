package derpwire

import (
	"net"
	"testing"
	"time"
)

// A relay that is asked to close must stop at once, even when the derp server's
// verify-client transport has opened a loopback connection to the admission
// listener that has not sent a request yet (it dials ahead of need). net/http's
// Shutdown waits up to five seconds for such a new connection before treating it as
// idle, so a graceful drain of the admission listener held a closing relay for 5s.
func TestRelayCloseDoesNotWaitForAnIdleAdmissionConnection(t *testing.T) {
	r, err := NewRelay([32]byte{1}, func([32]byte) bool { return true }, nil)
	if err != nil {
		t.Fatal(err)
	}
	conn, err := net.Dial("tcp", r.listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	// Give the server's accept loop time to register the connection as new.
	time.Sleep(100 * time.Millisecond)

	done := make(chan struct{})
	go func() { _ = r.Close(); close(done) }()
	select {
	case <-done:
	case <-time.After(1 * time.Second):
		t.Fatal("Close did not return within 1s with an idle admission connection open")
	}
}
