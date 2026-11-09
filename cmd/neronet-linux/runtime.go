package main

// `neronet up`: bring the tunnel up in this process, stay in the foreground, and tear
// everything down on SIGINT or SIGTERM (or when the device stops).

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/netip"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/jsimonetti/rtnetlink"
	"golang.zx2c4.com/wireguard/conn"
	"golang.zx2c4.com/wireguard/device"
	"golang.zx2c4.com/wireguard/ipc"
	"golang.zx2c4.com/wireguard/tun"

	"github.com/sovereign/proxy/v4/pkg/profile"
)

// uapiSocketPath is where wireguard-go's IPC socket for the interface lives.
func uapiSocketPath(iface string) string {
	return filepath.Join("/var/run/wireguard", iface+".sock")
}

// runtime is one tunnel: the live handles, plus the state teardown works from. A handle that
// was never created is nil, and teardown copes with that, so it also serves `neronet down`
// after a crash, when only the state file is left.
type runtime struct {
	dir  string
	st   *state
	nl   *rtnetlink.Conn
	dev  *device.Device
	uapi net.Listener
}

// runUp implements `neronet up`.
func runUp(ua upArgs, dir string, stdout, stderr io.Writer) error {
	if os.Geteuid() != 0 {
		return errors.New("needs root (CAP_NET_ADMIN and /dev/net/tun): run it with sudo")
	}
	if err := clearStale(dir, stderr); err != nil {
		return err
	}

	f, err := os.Open(ua.ProfilePath)
	if err != nil {
		return err
	}
	defer f.Close()
	if fi, err := f.Stat(); err == nil && fi.Mode().Perm()&0o077 != 0 {
		fmt.Fprintf(stderr, "neronet: warning: %s is readable by other users, and it holds the private key; chmod 600 it\n", ua.ProfilePath)
	}
	p, err := profile.Parse(f)
	if err != nil {
		return fmt.Errorf("%s: %w", ua.ProfilePath, err)
	}
	if ua.KillSwitch {
		if _, err := exec.LookPath("nft"); err != nil {
			return errors.New("--kill-switch needs nft (nftables) on PATH")
		}
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	uapiEndpoints, endpoints, err := resolveEndpoints(ctx, p)
	if err != nil {
		return err
	}

	r := &runtime{dir: dir, st: newState(p, os.Getpid(), time.Now())}
	if err := r.start(p, uapiEndpoints, endpoints, ua.KillSwitch, stderr); err != nil {
		if terr := r.teardown(); terr != nil {
			fmt.Fprintf(stderr, "neronet: cleanup after a failed start: %v\n", terr)
		}
		return err
	}

	fmt.Fprintf(stdout, "neronet: %s is up: %s\n", tunName, p.String())
	fmt.Fprintln(stdout, "neronet: Ctrl-C or `neronet down` stops it")
	select {
	case <-ctx.Done():
	case <-r.dev.Wait():
		fmt.Fprintln(stderr, "neronet: the WireGuard device stopped")
	}
	fmt.Fprintln(stdout, "neronet: tearing down")
	return r.teardown()
}

// newState builds the state for a profile that is about to come up.
func newState(p *profile.Profile, pid int, now time.Time) *state {
	st := &state{
		PID:        pid,
		Interface:  tunName,
		Started:    now,
		Summary:    p.String(),
		ConsoleURL: p.ConsoleURL,
		DeviceID:   p.DeviceID,
	}
	for _, a := range p.Addresses {
		st.Addresses = append(st.Addresses, a.String())
	}
	return st
}

// clearStale tears down what a crashed instance left behind. A live instance is an error.
func clearStale(dir string, stderr io.Writer) error {
	st, err := loadState(dir)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if processAlive(st.PID) {
		return fmt.Errorf("already running (pid %d): run `neronet down` first", st.PID)
	}
	fmt.Fprintf(stderr, "neronet: removing what pid %d left behind\n", st.PID)
	return (&runtime{dir: dir, st: st}).teardown()
}

// start brings the tunnel up. Each step is recorded in the state file as it is done, so a
// failure, or a crash, leaves a record that teardown can clear.
func (r *runtime) start(p *profile.Profile, uapiEndpoints []string, endpoints []netip.AddrPort, killSwitch bool, stderr io.Writer) error {
	if err := r.st.save(r.dir); err != nil {
		return err
	}

	mtu := p.MTU
	if mtu == 0 {
		mtu = device.DefaultMTU
	}
	tunDev, err := tun.CreateTUN(tunName, mtu)
	if err != nil {
		return fmt.Errorf("creating %s (needs /dev/net/tun): %w", tunName, err)
	}
	r.dev = device.NewDevice(tunDev, conn.NewDefaultBind(), device.NewLogger(device.LogLevelError, "neronet: "))
	if err := r.dev.IpcSet(p.UAPI(uapiEndpoints...)); err != nil {
		return fmt.Errorf("configuring the WireGuard device: %w", err)
	}
	if err := r.dev.Up(); err != nil {
		return fmt.Errorf("starting the WireGuard device: %w", err)
	}
	if err := r.serveUAPI(); err != nil {
		return err
	}

	nl, err := rtnetlink.Dial(nil)
	if err != nil {
		return fmt.Errorf("opening netlink: %w", err)
	}
	r.nl = nl
	idx, err := linkIndex(tunName)
	if err != nil {
		return fmt.Errorf("finding %s: %w", tunName, err)
	}
	for _, a := range p.Addresses {
		if err := addAddress(nl, idx, a); err != nil {
			return err
		}
	}
	if err := linkUp(nl, idx, mtu); err != nil {
		return err
	}

	// Peer endpoints must stay reachable outside the tunnel, or the handshake would be sent
	// into the tunnel itself. Host routes along today's path are added before anything that
	// could capture them (the AllowedIPs routes, including a default route).
	routes, err := listRoutes(nl)
	if err != nil {
		return err
	}
	seen := make(map[netip.Prefix]bool)
	for _, ep := range endpoints {
		pfx := netip.PrefixFrom(ep.Addr(), ep.Addr().BitLen())
		if seen[pfx] {
			continue
		}
		seen[pfx] = true
		hop, ok := bypassFor(ep.Addr(), routes, idx)
		if !ok {
			return fmt.Errorf("no route to peer endpoint %s", ep)
		}
		dev, err := linkName(hop.OutIf)
		if err != nil {
			return err
		}
		spec := routeSpec{Prefix: pfx.String(), Dev: dev}
		if hop.Gateway.IsValid() {
			spec.Via = hop.Gateway.String()
		}
		if err := addRoute(nl, pfx, hop.Gateway, hop.OutIf); err != nil {
			return err
		}
		r.st.Bypass = append(r.st.Bypass, spec)
		if err := r.st.save(r.dir); err != nil {
			return err
		}
	}

	if killSwitch {
		if err := applyKillSwitch(tunName, endpoints); err != nil {
			return err
		}
		r.st.KillSwitch = true
		if err := r.st.save(r.dir); err != nil {
			return err
		}
	}

	for _, pfx := range tunnelRoutes(p) {
		if err := addRoute(nl, pfx, netip.Addr{}, idx); err != nil {
			return err
		}
		r.st.Routes = append(r.st.Routes, routeSpec{Prefix: pfx.String(), Dev: tunName})
		if err := r.st.save(r.dir); err != nil {
			return err
		}
	}

	for _, d := range p.DNS {
		r.st.DNS = append(r.st.DNS, d.String())
	}
	if len(p.DNS) > 0 {
		set, err := applyDNS(tunName, p.DNS)
		switch {
		case err != nil:
			fmt.Fprintf(stderr, "neronet: DNS was not set: %v\n", err)
		case !set:
			fmt.Fprintf(stderr, "neronet: DNS was not set: resolvectl is not installed; use these servers by hand: %s\n", strings.Join(r.st.DNS, ", "))
		default:
			r.st.DNSSet = true
			if err := r.st.save(r.dir); err != nil {
				return err
			}
		}
	}
	return r.st.save(r.dir)
}

// serveUAPI exposes the device on wireguard-go's IPC socket, which `neronet status` reads.
func (r *runtime) serveUAPI() error {
	f, err := ipc.UAPIOpen(tunName)
	if err != nil {
		return fmt.Errorf("opening the UAPI socket: %w", err)
	}
	ln, err := ipc.UAPIListen(tunName, f)
	if err != nil {
		_ = f.Close()
		return fmt.Errorf("listening on the UAPI socket: %w", err)
	}
	r.uapi = ln
	dev := r.dev
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go dev.IpcHandle(c)
		}
	}()
	return nil
}

// teardown removes what the state records, in reverse order of creation: kill switch, DNS,
// routes, device, interface. It is idempotent: a step that is already done is skipped. The
// state file is removed only when everything succeeded, so a failed teardown can be retried.
func (r *runtime) teardown() error {
	var errs []error

	if r.st.KillSwitch {
		if err := removeKillSwitch(); err != nil {
			errs = append(errs, err)
		} else {
			r.st.KillSwitch = false
		}
	}
	if r.st.DNSSet {
		if _, err := linkIndex(tunName); err != nil {
			// The interface is gone, and resolved dropped its settings with it.
			r.st.DNSSet = false
		} else if err := revertDNS(tunName); err != nil {
			errs = append(errs, err)
		} else {
			r.st.DNSSet = false
		}
	}

	nl := r.nl
	if nl == nil {
		c, err := rtnetlink.Dial(nil)
		if err != nil {
			errs = append(errs, fmt.Errorf("opening netlink: %w", err))
		} else {
			nl = c
		}
	}
	if nl != nil {
		defer nl.Close()
		errs = append(errs, deleteRoutes(nl, &r.st.Routes)...)
		errs = append(errs, deleteRoutes(nl, &r.st.Bypass)...)
	}

	// Closing the device closes the TUN, and the kernel drops the interface with it.
	if r.dev != nil {
		r.dev.Close()
		r.dev = nil
	}
	if r.uapi != nil {
		_ = r.uapi.Close() // also unlinks the socket
		r.uapi = nil
	}
	_ = os.Remove(uapiSocketPath(tunName))

	if nl != nil {
		if idx, err := linkIndex(tunName); err == nil {
			if err := deleteLink(nl, idx); err != nil {
				errs = append(errs, err)
			}
		}
	}

	if len(errs) > 0 {
		_ = r.st.save(r.dir)
		return errors.Join(errs...)
	}
	return removeState(r.dir)
}

// deleteRoutes removes the recorded routes, newest first, and clears the list.
func deleteRoutes(nl *rtnetlink.Conn, specs *[]routeSpec) []error {
	var errs []error
	for i := len(*specs) - 1; i >= 0; i-- {
		if err := deleteRouteSpec(nl, (*specs)[i]); err != nil {
			errs = append(errs, err)
		}
	}
	*specs = nil
	return errs
}

func deleteRouteSpec(nl *rtnetlink.Conn, s routeSpec) error {
	pfx, err := netip.ParsePrefix(s.Prefix)
	if err != nil {
		return fmt.Errorf("state: route %q: %w", s.Prefix, err)
	}
	var via netip.Addr
	if s.Via != "" {
		if via, err = netip.ParseAddr(s.Via); err != nil {
			return fmt.Errorf("state: gateway %q: %w", s.Via, err)
		}
	}
	idx, err := linkIndex(s.Dev)
	if err != nil {
		return nil // the interface is gone, and so are its routes
	}
	return delRoute(nl, pfx, via, idx)
}
