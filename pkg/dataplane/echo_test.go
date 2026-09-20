package dataplane

import (
	"context"
	"encoding/binary"
	"io"
	"testing"
	"time"
)

// TestResponderDrainReportsWhatItReceived checks the measurement protocol the
// spike numbers come from. A throughput figure is only worth reporting if the side
// that counted it is the side that received the bytes.
func TestResponderDrainReportsWhatItReceived(t *testing.T) {
	a, b := pair(t, nil, nil)

	responder, err := ListenEcho(b.dev, 9999, nil)
	if err != nil {
		t.Fatalf("starting responder: %v", err)
	}
	defer responder.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	conn, err := dialWithRetry(ctx, a.dev, "100.64.0.2:9999")
	if err != nil {
		t.Fatalf("dialling the responder: %v", err)
	}
	defer conn.Close()

	const window = 300 * time.Millisecond
	request := make([]byte, 9)
	request[0] = ModeByteDrain
	binary.BigEndian.PutUint64(request[1:], uint64(window.Milliseconds()))
	if _, err := conn.Write(request); err != nil {
		t.Fatalf("sending the drain request: %v", err)
	}

	block := make([]byte, 32*1024)
	stop := make(chan struct{})
	go func() {
		for {
			select {
			case <-stop:
				return
			default:
			}
			if _, err := conn.Write(block); err != nil {
				return
			}
		}
	}()

	_ = conn.SetReadDeadline(time.Now().Add(10 * time.Second))
	var report [16]byte
	if _, err := io.ReadFull(conn, report[:]); err != nil {
		close(stop)
		t.Fatalf("reading the report: %v", err)
	}
	close(stop)

	received := binary.BigEndian.Uint64(report[0:8])
	elapsed := time.Duration(binary.BigEndian.Uint64(report[8:16]))

	if received == 0 {
		t.Fatal("the responder counted no bytes although the stream was written for the whole window")
	}
	// The responder times the read from its own clock, which can land a few
	// microseconds under the requested window. A tolerance of a tenth of the window
	// still catches a responder that stops early.
	if elapsed < window-window/10 {
		t.Fatalf("the responder measured %v, less than the %v window it was asked for", elapsed, window)
	}
}

func TestResponderSourceStreams(t *testing.T) {
	a, b := pair(t, nil, nil)

	responder, err := ListenEcho(b.dev, 9999, nil)
	if err != nil {
		t.Fatalf("starting responder: %v", err)
	}
	defer responder.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	conn, err := dialWithRetry(ctx, a.dev, "100.64.0.2:9999")
	if err != nil {
		t.Fatalf("dialling the responder: %v", err)
	}
	defer conn.Close()

	if _, err := conn.Write([]byte{ModeByteSource}); err != nil {
		t.Fatalf("sending the source request: %v", err)
	}

	_ = conn.SetReadDeadline(time.Now().Add(10 * time.Second))
	got := make([]byte, 128*1024)
	if _, err := io.ReadFull(conn, got); err != nil {
		t.Fatalf("reading the stream: %v", err)
	}

	// The pattern is not zeroes on purpose: a stream of zeroes would make any
	// figure measured on it unrepresentative of a real payload.
	for i := range got {
		if got[i] != sourcePattern[i%len(sourcePattern)] {
			t.Fatalf("byte %d of the stream is %#x, want %#x", i, got[i], sourcePattern[i%len(sourcePattern)])
		}
	}
}

func TestListenEchoRefusesADeviceWithoutAddress(t *testing.T) {
	if _, err := ListenEcho(&Device{}, 9999, nil); err != ErrNoAddresses {
		t.Fatalf("ListenEcho on an address-less device returned %v, want ErrNoAddresses", err)
	}
}
