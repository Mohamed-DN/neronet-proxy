package main

import (
	"io"
	"net"
	"testing"
)

func echoServer(t *testing.T) string {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { l.Close() })
	go func() {
		for {
			c, err := l.Accept()
			if err != nil {
				return
			}
			go func() {
				defer c.Close()
				mode := make([]byte, 1)
				if _, err := io.ReadFull(c, mode); err != nil || mode[0] != 'E' {
					return
				}
				_, _ = io.Copy(c, c)
			}()
		}
	}()
	return l.Addr().String()
}

func TestEchoDirectUsesTheMachinesOwnNetworkNotAProxy(t *testing.T) {
	got, err := echoOnce("direct", echoServer(t), "hello")
	if err != nil || got != "hello" {
		t.Fatalf("got %q, %v", got, err)
	}
}

func TestEchoThroughAProxyThatIsNotThereFails(t *testing.T) {
	if _, err := echoOnce("127.0.0.1:1", echoServer(t), "hello"); err == nil {
		t.Fatal("no proxy, and it still worked")
	}
}
