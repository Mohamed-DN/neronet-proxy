package dataplane

import (
	"os"
	"sync"
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

// handoffTUN hands packets over the way the netstack device does: an unbuffered channel that Read
// receives from and Close closes.
type handoffTUN struct {
	*fakeTUN
	ch   chan []byte
	once sync.Once
}

func (h *handoffTUN) Read(bufs [][]byte, sizes []int, offset int) (int, error) {
	pkt, ok := <-h.ch
	if !ok {
		return 0, os.ErrClosed
	}
	sizes[0] = copy(bufs[0][offset:], pkt)
	return 1, nil
}

func (h *handoffTUN) Close() error {
	h.once.Do(func() { close(h.ch) })
	return nil
}

// CI on 61add06 caught the whole trace: SetEgress starts a wake, and the device is closed while the
// wake is handing its datagram over. Containing the panic was not enough: the close itself raced the
// send. Close must let the wake finish first, also when nobody is reading the device any more.
func TestCloseLetsAWakeInFlightFinish(t *testing.T) {
	for i := 0; i < 50; i++ {
		dev := &handoffTUN{fakeTUN: newFakeTUN(), ch: make(chan []byte)}
		f := newFilteredTUN(dev, nil)
		sending := make(chan struct{})
		finished := make(chan bool, 1)
		f.wake = func() {
			ok := false
			defer func() { finished <- ok }()
			close(sending)
			dev.ch <- []byte("wake")
			ok = true
		}
		f.wakeIfDirect()
		<-sending
		closed := make(chan struct{})
		go func() { _ = f.Close(); close(closed) }()
		select {
		case <-closed:
		case <-time.After(5 * time.Second):
			t.Fatal("Close did not return while a wake was in flight")
		}
		if !<-finished {
			t.Fatal("the device was closed under a wake that was still sending")
		}
	}
}

// A wake that never ends must not hold the shutdown for ever.
func TestCloseGivesUpOnAWakeThatHangs(t *testing.T) {
	f := newFilteredTUN(&handoffTUN{fakeTUN: newFakeTUN(), ch: make(chan []byte)}, nil)
	release := make(chan struct{})
	defer close(release)
	started := make(chan struct{})
	f.wake = func() { close(started); <-release }
	f.wakeIfDirect()
	<-started
	start := time.Now()
	_ = f.Close()
	if d := time.Since(start); d > wakeDrainTimeout+2*time.Second {
		t.Fatalf("Close took %s", d)
	}
}

// Wakes asked for by many goroutines while the device closes: none starts after Close began, and the
// counter never moves after Close waited for it (a WaitGroup misuse panics).
func TestWakesRacingClose(t *testing.T) {
	for i := 0; i < 100; i++ {
		dev := &handoffTUN{fakeTUN: newFakeTUN(), ch: make(chan []byte)}
		f := newFilteredTUN(dev, nil)
		var bad atomic.Int32
		f.wake = func() {
			defer func() {
				if recover() != nil {
					bad.Add(1)
				}
			}()
			dev.ch <- []byte("wake")
		}
		var wg sync.WaitGroup
		for g := 0; g < 8; g++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				for k := 0; k < 20; k++ {
					f.lastWake.Store(0)
					f.wakeIfDirect()
				}
			}()
		}
		_ = f.Close()
		wg.Wait()
		if bad.Load() != 0 {
			t.Fatalf("%d wake(s) sent on the closed device", bad.Load())
		}
	}
}
