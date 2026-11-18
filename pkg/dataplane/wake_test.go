package dataplane

import (
	"sync/atomic"
	"testing"
	"time"
)

// A wake races the device being closed: the netstack can close the channel the wake's
// datagram is handed over on while the wake is writing, and a send on a closed channel
// panics. Seen in CI on 6b38d78 (pkg/dataplane, "panic: send on closed channel" from
// netTun.WriteNotify under filteredTUN.wakeIfDirect). A panic in that goroutine took the
// whole process down, so a reconfiguring node or gateway could crash.
func TestWakeThatPanicsDuringCloseDoesNotCrashTheProcess(t *testing.T) {
	f := newFilteredTUN(newFakeTUN(), nil)
	done := make(chan struct{})
	f.wake = func() {
		defer close(done)
		panic("send on closed channel")
	}
	f.wakeIfDirect()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("the wake never ran")
	}
	// Reaching this line means the panic was contained in the wake goroutine.
	time.Sleep(20 * time.Millisecond)
}

func TestNoWakeStartsOnceTheDeviceIsClosing(t *testing.T) {
	f := newFilteredTUN(newFakeTUN(), nil)
	var calls atomic.Int32
	f.wake = func() { calls.Add(1) }
	_ = f.Close()
	f.lastWake.Store(0)
	f.wakeIfDirect()
	time.Sleep(50 * time.Millisecond)
	if n := calls.Load(); n != 0 {
		t.Fatalf("a wake ran %d time(s) after Close", n)
	}
}
