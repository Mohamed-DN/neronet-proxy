package dataplane

import (
	"errors"
	"fmt"
	"net"
	"syscall"

	"golang.zx2c4.com/wireguard/conn"
)

// On a host without IPv6 (a kernel built without it, or booted with
// ipv6.disable=1), wireguard-go's StdNetBind opens the IPv4 socket, fails the IPv6
// one with EAFNOSUPPORT, carries on -- and reports port 0, because the failed IPv6
// attempt overwrites the port the IPv4 socket got. The device then shows no listen
// port, and the node has nothing to advertise as its endpoint: it runs, and no peer
// can reach it.

// ipv6Available reports whether this host can open an IPv6 UDP socket at all.
func ipv6Available() bool {
	c, err := net.ListenUDP("udp6", &net.UDPAddr{IP: net.IPv6loopback})
	if err != nil {
		return !errors.Is(err, syscall.EAFNOSUPPORT)
	}
	_ = c.Close()
	return true
}

// freeUDP4Port asks the kernel for an unused IPv4 UDP port. There is a window in
// which another process could take it; it is used only when the configuration asks
// for any port, on a host where the bind cannot report the one it got.
func freeUDP4Port() (uint16, error) {
	c, err := net.ListenUDP("udp4", &net.UDPAddr{})
	if err != nil {
		return 0, fmt.Errorf("dataplane: choosing a UDP port: %w", err)
	}
	defer c.Close()
	return uint16(c.LocalAddr().(*net.UDPAddr).Port), nil
}

// ipv4PortBind reports the port it was asked to open when the bind underneath
// reports 0 for a socket that is in fact open.
type ipv4PortBind struct {
	conn.Bind
}

func (b ipv4PortBind) Open(port uint16) ([]conn.ReceiveFunc, uint16, error) {
	fns, actual, err := b.Bind.Open(port)
	if err == nil && actual == 0 && port != 0 {
		actual = port
	}
	return fns, actual, err
}

// portedBind returns the bind to use and the listen port to configure, so that the
// port the device reports is the port it listens on.
func portedBind(listenPort uint16) (conn.Bind, uint16, error) {
	bind := conn.NewDefaultBind()
	if ipv6Available() {
		return bind, listenPort, nil
	}
	if listenPort == 0 {
		p, err := freeUDP4Port()
		if err != nil {
			return nil, 0, err
		}
		listenPort = p
	}
	return ipv4PortBind{Bind: bind}, listenPort, nil
}
