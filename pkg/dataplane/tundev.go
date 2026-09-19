package dataplane

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"os/exec"
	"runtime"
	"strconv"
	"time"

	"golang.zx2c4.com/wireguard/tun"
)

// ErrTUNUnsupported is returned when the kernel TUN mode cannot run here.
var ErrTUNUnsupported = errors.New("dataplane: kernel TUN mode is only implemented on Linux")

// tunBackend uses a kernel TUN interface. The host stack does the routing, so the
// node dials with the standard library and every process in the network namespace
// sees the overlay, not just this one.
//
// It needs /dev/net/tun and CAP_NET_ADMIN. Interface configuration goes through
// iproute2 rather than raw netlink: the spike needs to learn whether the capability
// is there at all, and a netlink library would be a dependency bought before that
// question is answered.
type tunBackend struct {
	dev  tun.Device
	name string
}

func newTUNBackend(cfg Config) (*tunBackend, error) {
	if runtime.GOOS != "linux" {
		return nil, ErrTUNUnsupported
	}

	dev, err := tun.CreateTUN(cfg.InterfaceName, cfg.MTU)
	if err != nil {
		return nil, fmt.Errorf("dataplane: creating TUN %s (needs /dev/net/tun and CAP_NET_ADMIN): %w", cfg.InterfaceName, err)
	}

	name, err := dev.Name()
	if err != nil {
		_ = dev.Close()
		return nil, fmt.Errorf("dataplane: reading TUN name: %w", err)
	}

	b := &tunBackend{dev: dev, name: name}
	if err := b.configure(cfg); err != nil {
		_ = dev.Close()
		return nil, err
	}
	return b, nil
}

// configure gives the interface its addresses and brings it up.
//
// The address carries the overlay prefix length, not /32, so the connected route it
// creates covers every peer in the range. With a /32 the interface would come up and
// no packet would ever be sent to it, which looks identical to a broken tunnel.
func (b *tunBackend) configure(cfg Config) error {
	if err := run("ip", "link", "set", "dev", b.name, "mtu", strconv.Itoa(cfg.MTU)); err != nil {
		return err
	}
	for _, p := range cfg.Addresses {
		family := "-4"
		if p.Addr().Is6() {
			family = "-6"
		}
		if err := run("ip", family, "addr", "add", p.String(), "dev", b.name); err != nil {
			return err
		}
	}
	return run("ip", "link", "set", "dev", b.name, "up")
}

func run(name string, args ...string) error {
	cmd := exec.Command(name, args...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("dataplane: %s %v failed: %w: %s", name, args, err, string(out))
	}
	return nil
}

func (b *tunBackend) tunDevice() tun.Device { return b.dev }

func (b *tunBackend) dialContext(ctx context.Context, network, address string) (net.Conn, error) {
	// No local address is bound: the connected route created by configure already
	// selects the overlay address as the source for overlay destinations.
	var d net.Dialer
	return d.DialContext(ctx, network, address)
}

func (b *tunBackend) listen(network, address string) (net.Listener, error) {
	return net.Listen(network, address)
}

func (b *tunBackend) ping(ctx context.Context, dst netip.Addr) (time.Duration, error) {
	return 0, fmt.Errorf("dataplane: ping is not implemented in %s mode; the kernel interface answers the host's own ping", ModeTUN)
}

func (b *tunBackend) close() error {
	return b.dev.Close()
}

// InterfaceName reports the name the kernel gave the interface, which is not always
// the one requested.
func (b *tunBackend) InterfaceName() string { return b.name }
