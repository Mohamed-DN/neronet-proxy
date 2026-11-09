//go:build darwin

package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/netip"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"

	"golang.zx2c4.com/wireguard/conn"
	"golang.zx2c4.com/wireguard/device"
	"golang.zx2c4.com/wireguard/tun"

	"github.com/sovereign/proxy/v4/pkg/profile"
)

// tunnel holds everything runUp changed, so that Close can undo exactly that. Close is
// idempotent: the error paths, the signal path and the device-stopped path can all reach it.
type tunnel struct {
	once      sync.Once
	dev       *device.Device
	name      string
	routes    []netip.Prefix
	resolver  string
	statePath string
}

func (t *tunnel) Close() {
	t.once.Do(func() {
		if t.resolver != "" {
			_ = removeIfExists(t.resolver)
		}
		for _, p := range t.routes {
			// Best effort: the kernel also drops these routes with the interface.
			_ = runCmd(routeDelArgs(p, t.name))
		}
		if t.dev != nil {
			// Closing the device also closes the utun interface and its addresses.
			t.dev.Close()
		}
		_ = removeIfExists(t.statePath)
	})
}

// runUp brings a profile up on a utun interface and blocks until SIGINT or SIGTERM.
// Any failure after the first change undoes the changes made so far.
func runUp(profilePath string, stdout io.Writer) (err error) {
	if err := requireRoot(); err != nil {
		return err
	}
	if s, err := readState(statePath); err == nil && processAlive(s.PID) {
		return fmt.Errorf("a tunnel is already up (pid %d, %s); run neronet down first", s.PID, s.Interface)
	}
	data, err := os.ReadFile(profilePath)
	if err != nil {
		return err
	}
	prof, err := profile.Parse(bytes.NewReader(data))
	if err != nil {
		return err
	}
	search, err := searchDomain(data)
	if err != nil {
		return err
	}
	// String omits the private key by design.
	fmt.Fprintln(stdout, prof.String())

	allowed := []netip.Prefix{}
	seen := map[string]bool{}
	for _, peer := range prof.Peers {
		for _, p := range peer.AllowedIPs {
			if k := p.Masked().String(); !seen[k] {
				seen[k] = true
				allowed = append(allowed, p.Masked())
			}
		}
	}

	// Resolve endpoints before the tunnel exists, so the system resolver is still in use.
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	endpoints := make([]string, len(prof.Peers))
	var endpointList []string
	for i, peer := range prof.Peers {
		if peer.Endpoint == "" {
			continue
		}
		ap, err := resolveEndpoint(ctx, peer.Endpoint)
		if err != nil {
			return err
		}
		if endpointRouted(ap.Addr(), allowed) {
			return fmt.Errorf("endpoint %s lies inside AllowedIPs, so its handshake would enter the tunnel; full-tunnel profiles are not supported in v0", ap)
		}
		endpoints[i] = ap.String()
		endpointList = append(endpointList, ap.String())
	}

	mtu := prof.MTU
	if mtu == 0 {
		mtu = device.DefaultMTU
	}
	t := &tunnel{statePath: statePath}
	defer func() {
		if err != nil {
			t.Close()
		}
	}()

	tunDev, err := tun.CreateTUN("utun", mtu)
	if err != nil {
		return fmt.Errorf("create utun: %w", err)
	}
	t.name, err = tunDev.Name()
	if err != nil {
		_ = tunDev.Close()
		return fmt.Errorf("name utun: %w", err)
	}
	logger := device.NewLogger(device.LogLevelError, "[neronet] ")
	t.dev = device.NewDevice(tunDev, conn.NewDefaultBind(), logger)

	if err := t.dev.IpcSet(prof.UAPI(endpoints...)); err != nil {
		return fmt.Errorf("configure wireguard: %w", err)
	}
	if err := t.dev.Up(); err != nil {
		return fmt.Errorf("bring wireguard up: %w", err)
	}
	for _, argv := range ifconfigArgs(t.name, prof.Addresses, mtu) {
		if err := runCmd(argv); err != nil {
			return err
		}
	}
	for _, p := range allowed {
		if err := runCmd(routeAddArgs(p, t.name)); err != nil {
			return err
		}
		t.routes = append(t.routes, p)
	}

	dns := make([]string, 0, len(prof.DNS))
	for _, a := range prof.DNS {
		dns = append(dns, a.String())
	}
	switch {
	case len(prof.DNS) == 0:
		fmt.Fprintln(stdout, "dns: the profile names no DNS server; system DNS was not changed")
	case search == "":
		fmt.Fprintf(stdout, "dns: %s; system DNS was not changed (the profile has no NeroNet-Search line)\n", strings.Join(dns, ", "))
	default:
		rp, err := resolverPath(search)
		if err != nil {
			return err
		}
		if err := os.MkdirAll(resolverDir, 0755); err != nil {
			return err
		}
		if err := writeFile(rp, []byte(resolverFile(prof.DNS)), 0644); err != nil {
			return err
		}
		t.resolver = rp
		fmt.Fprintf(stdout, "dns: %s for *.%s via %s\n", strings.Join(dns, ", "), search, rp)
	}

	st := tunnelState{
		PID:       os.Getpid(),
		Interface: t.name,
		Profile:   prof.String(),
		Endpoints: endpointList,
		DNS:       dns,
		Resolver:  t.resolver,
		StartedAt: time.Now().UTC(),
	}
	for _, a := range prof.Addresses {
		st.Addresses = append(st.Addresses, a.String())
	}
	for _, p := range t.routes {
		st.Routes = append(st.Routes, p.String())
	}
	if err := writeState(statePath, st); err != nil {
		return err
	}

	fmt.Fprintf(stdout, "up on %s with %d routes; stop with neronet down or Ctrl-C\n", t.name, len(t.routes))
	sigCtx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	select {
	case <-sigCtx.Done():
		fmt.Fprintln(stdout, "stopping")
		t.Close()
		return nil
	case <-t.dev.Wait():
		t.Close()
		return errors.New("wireguard device stopped unexpectedly")
	}
}
