// neronet-appctl drives neronet-appd over its local socket: the headless stand-in for the app's interface,
// and the tool the end-to-end scenario uses. It checks who is listening before it says anything.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"net"
	"os"
	"strconv"
	"time"

	"golang.org/x/net/proxy"

	"github.com/sovereign/proxy/v4/pkg/clientcore"
)

func usage() {
	fmt.Fprintln(os.Stderr, "usage: neronet-appctl [-socket PATH] [-service-uid N] state|signin|connect|disconnect|signout [force]|exit NAME|order forced METHOD...|echo SOCKS HOST:PORT [TEXT]")
	os.Exit(2)
}

func fail(format string, a ...any) {
	fmt.Fprintf(os.Stderr, format+"\n", a...)
	os.Exit(1)
}

func main() {
	socket := flag.String("socket", "", "path of the service socket")
	serviceUID := flag.Int("service-uid", os.Geteuid(), "the user the service runs as")
	flag.Parse()
	args := flag.Args()
	if len(args) == 0 {
		usage()
	}
	if args[0] == "echo" {
		echo(args[1:])
		return
	}
	if *socket == "" {
		fail("neronet-appctl: -socket is required")
	}
	conn, err := clientcore.DialUnix(*socket, uint32(*serviceUID))
	if err != nil {
		fail("neronet-appctl: cannot reach the service: %v", err)
	}
	cl := clientcore.NewClient(conn)
	defer cl.Close()

	var cmd string
	var a any
	switch args[0] {
	case "state":
		cmd = "state.get"
	case "signin":
		cmd = "signin.start"
	case "connect":
		cmd = "connect"
	case "disconnect":
		cmd = "disconnect"
	case "signout":
		cmd = "signout"
		a = map[string]bool{"force": len(args) > 1 && args[1] == "force"}
	case "exit":
		if len(args) != 2 {
			usage()
		}
		cmd, a = "exit.set", map[string]string{"name": args[1]}
	case "order":
		if len(args) < 3 {
			usage()
		}
		forced, _ := strconv.ParseBool(args[1])
		cmd, a = "order.set", map[string]any{"methods": args[2:], "forced": forced}
	default:
		usage()
	}
	resp, err := cl.Do(cmd, a)
	if err != nil {
		fail("neronet-appctl: %v", err)
	}
	out, _ := json.Marshal(resp)
	fmt.Println(string(out))
	if !resp.OK {
		os.Exit(1)
	}
}

// echo dials host:port and speaks the overlay echo protocol: a mode byte 'E', then whatever is sent comes
// back. The first argument is a SOCKS5 proxy, or "direct" for the machine's own network (a tunnel that
// carries the whole computer, no proxy).
func echo(args []string) {
	if len(args) < 2 {
		usage()
	}
	text := "neronet"
	if len(args) > 2 {
		text = args[2]
	}
	got, err := echoOnce(args[0], args[1], text)
	if err != nil {
		fail("echo: %v", err)
	}
	fmt.Println(got)
}

func echoOnce(socks, target, text string) (string, error) {
	var cd proxy.ContextDialer = &net.Dialer{Timeout: 5 * time.Second}
	if socks != "direct" {
		d, err := proxy.SOCKS5("tcp", socks, nil, &net.Dialer{Timeout: 5 * time.Second})
		if err != nil {
			return "", err
		}
		var ok bool
		if cd, ok = d.(proxy.ContextDialer); !ok {
			return "", errors.New("the proxy dialer cannot take a deadline")
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	conn, err := cd.DialContext(ctx, "tcp", target)
	if err != nil {
		return "", err
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(8 * time.Second))
	if _, err := conn.Write(append([]byte{'E'}, text...)); err != nil {
		return "", err
	}
	buf := make([]byte, len(text))
	n := 0
	for n < len(buf) {
		m, err := conn.Read(buf[n:])
		n += m
		if err != nil {
			break
		}
	}
	if string(buf[:n]) != text {
		return "", fmt.Errorf("got %q, want %q", buf[:n], text)
	}
	return string(buf[:n]), nil
}
