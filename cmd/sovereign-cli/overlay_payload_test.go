package main

import (
	"bytes"
	"io"
	"net"
	"testing"
	"time"
)

func TestOverlayProbeTransfersRequestedPayload(t *testing.T) {
	t.Setenv("NERONET_OVERLAY_PAYLOAD_BYTES", "262144")
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	type result struct {
		bytes int
		err   error
	}
	done := make(chan result, 1)
	go func() {
		conn, err := listener.Accept()
		if err != nil {
			done <- result{err: err}
			return
		}
		defer conn.Close()
		_ = conn.SetDeadline(time.Now().Add(3 * time.Second))
		greeting := make([]byte, 3)
		if _, err = io.ReadFull(conn, greeting); err != nil {
			done <- result{err: err}
			return
		}
		_, _ = conn.Write([]byte{5, 0})
		connect := make([]byte, 10)
		if _, err = io.ReadFull(conn, connect); err != nil {
			done <- result{err: err}
			return
		}
		_, _ = conn.Write([]byte{5, 0, 0, 1, 127, 0, 0, 1, 0, 1})
		mode := make([]byte, 1)
		if _, err = io.ReadFull(conn, mode); err != nil {
			done <- result{err: err}
			return
		}
		var received bytes.Buffer
		_, err = io.Copy(io.MultiWriter(conn, &received), conn)
		done <- result{bytes: received.Len(), err: err}
	}()
	if _, err = echoThroughSocks(listener.Addr().String(), "100.64.0.2:9999", 2*time.Second); err != nil {
		t.Fatal(err)
	}
	observed := <-done
	if observed.err != nil || observed.bytes != 262144 {
		t.Fatalf("actually transferred %d bytes, want 262144; error=%v", observed.bytes, observed.err)
	}
}
