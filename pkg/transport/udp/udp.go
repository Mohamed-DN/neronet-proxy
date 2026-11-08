package udp

import (
	"net"

	"github.com/sovereign/proxy/v4/pkg/transport"
	"golang.zx2c4.com/wireguard/conn"
)

type bind struct{ conn.Bind }

func (b *bind) Open(port uint16) ([]conn.ReceiveFunc, uint16, error) {
	// StdNetBind can report zero on IPv4-only kernels when its IPv6 socket fails.
	// Choose a concrete port first so the actual IPv4 socket remains reportable.
	if port == 0 {
		c, err := net.ListenUDP("udp4", &net.UDPAddr{})
		if err != nil {
			return nil, 0, err
		}
		port = uint16(c.LocalAddr().(*net.UDPAddr).Port)
		_ = c.Close()
	}
	fns, actual, err := b.Bind.Open(port)
	if actual == 0 && err == nil {
		actual = port
	}
	return fns, actual, err
}

func init() {
	transport.Register(transport.Spec{Name: transport.UDP, New: func(transport.Config) (transport.Transport, error) { return &bind{conn.NewDefaultBind()}, nil }, ParseEndpoint: func(s string) (conn.Endpoint, error) { return conn.NewDefaultBind().ParseEndpoint(s) }, BatchSize: conn.NewDefaultBind().BatchSize()})
}
