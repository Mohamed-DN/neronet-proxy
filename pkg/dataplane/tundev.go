package dataplane

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"os"
	"os/exec"
	"path/filepath"
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

	// A TUN device made by this process vanishes with it, addresses and routes included, so
	// nothing is left behind by a crash or a kill. The one thing that can be there is a persistent
	// device of the same name made by something else (an earlier tool, a failed script): it is
	// removed if it is a TUN device and refused if it is anything else.
	if err := clearStaleTUN("/sys", cfg.InterfaceName, func(n string) error { return run("ip", "link", "del", "dev", n) }); err != nil {
		return nil, err
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
	return 0, fmt.Errorf("%w: %s mode; the kernel interface answers the host's own ping", ErrPingUnsupported, ModeTUN)
}

func (b *tunBackend) wake(dst netip.AddrPort, payload []byte) error {
	c, err := net.DialUDP("udp", nil, net.UDPAddrFromAddrPort(dst))
	if err != nil {
		return err
	}
	defer c.Close()
	_, err = c.Write(payload)
	return err
}

func (b *tunBackend) close() error {
	return b.dev.Close()
}

// InterfaceName reports the name the kernel gave the interface, which is not always
// the one requested.
func (b *tunBackend) InterfaceName() string { return b.name }

// clearStaleTUN removes an interface called name when it is a TUN device left over from before, and
// does nothing when there is none. An interface of that name that is not a TUN device is somebody
// else's: it is an error, never deleted. sysRoot is "/sys" (a directory of the same shape in tests).
func clearStaleTUN(sysRoot, name string, del func(string) error) error {
	dir := filepath.Join(sysRoot, "class", "net", name)
	if _, err := os.Stat(dir); err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return fmt.Errorf("dataplane: looking at interface %s: %w", name, err)
	}
	if _, err := os.Stat(filepath.Join(dir, "tun_flags")); err != nil {
		return fmt.Errorf("dataplane: an interface named %s exists and is not a TUN device; it is not removed", name)
	}
	if err := del(name); err != nil {
		return fmt.Errorf("dataplane: removing the leftover TUN device %s: %w", name, err)
	}
	return nil
}
