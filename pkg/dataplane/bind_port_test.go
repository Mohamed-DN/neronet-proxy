package dataplane

import (
	"testing"

	"golang.zx2c4.com/wireguard/conn"
)

// zeroPortBind stands for StdNetBind on a host without IPv6: the IPv4 socket is
// open, and the port it reports is 0.
type zeroPortBind struct{ conn.Bind }

func (zeroPortBind) Open(uint16) ([]conn.ReceiveFunc, uint16, error) { return nil, 0, nil }

func TestIPv4PortBindReportsTheRequestedPort(t *testing.T) {
	_, got, err := ipv4PortBind{Bind: zeroPortBind{}}.Open(51820)
	if err != nil {
		t.Fatal(err)
	}
	if got != 51820 {
		t.Fatalf("reported port %d, want 51820: the device would show no listen port", got)
	}
}

func TestPortedBindAlwaysYieldsAListenPort(t *testing.T) {
	_, port, err := portedBind(0)
	if err != nil {
		t.Fatal(err)
	}
	if !ipv6Available() && port == 0 {
		t.Fatal("on a host without IPv6 a port must be chosen up front, or the device reports none")
	}
}
