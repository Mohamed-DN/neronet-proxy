//go:build awg

package dataplane

import (
	"encoding/hex"
	"errors"
	"fmt"
	"net/netip"
	"os"
	"strconv"
	"strings"
	"sync"

	awgconn "github.com/amnezia-vpn/amneziawg-go/conn"
	awgdevice "github.com/amnezia-vpn/amneziawg-go/device"
	awgtun "github.com/amnezia-vpn/amneziawg-go/tun"
	"golang.zx2c4.com/wireguard/tun"
)

// The gateway's second device (ADR 0036): amneziawg-go on its own UDP port, serving the
// profile devices an organisation put on AmneziaWG.
//
// How it shares the policy point. The first device and this one each have a tun wrapper
// (filteredTUN), and every policy decision is made in the wrapper that decrypted the
// packet, against the one ForwardTable both are given (SetForwarding installs it in both
// under fwdMu), so a profile device's ACL and conntrack are the same objects whichever
// device carries it. What the wrappers do not share is the WireGuard peer table: a
// decrypted packet that passed policy has to be encrypted by the device that holds the
// destination peer. relayRoute is that switch: it sends a packet to this device's queue
// when the destination is one of its peers and to the first device's otherwise, so a
// reply from the mesh reaches an AmneziaWG device and a packet from one reaches the mesh.
//
// A peer is on one device. SetPeers partitions the netmap's peers by Peer.AWG, refuses a
// key named on both, and removes a key from the device it left, so a profile device is
// never reachable over both with different rules (the rules are the same objects anyway).
//
// This device has no IP stack of its own. A packet addressed to the gateway itself (the
// tunnel check, mesh names) is handed to the first wrapper's Write, which is the one place
// the local stack, the mesh DNS and the gateway's own filter sit; its answers leave
// through the first wrapper's Read, where keepOutbound moves the ones addressed to an
// AmneziaWG peer onto this device's queue.

// AWGBuilt reports whether this binary can run an AmneziaWG device.
func AWGBuilt() bool { return true }

type awgRuntime struct {
	dev      *awgdevice.Device
	wrap     *filteredTUN
	router   *relayRoute
	port     uint16
	peerKeys map[string]struct{} // guarded by Device.setMu
}

// StartAWG brings up the AmneziaWG device. The parameters are validated first and there is
// no default set: an empty or invalid configuration returns an error and starts nothing.
func (d *Device) StartAWG(cfg AWGConfig) error {
	if err := cfg.Params.Validate(); err != nil {
		return err
	}
	d.setMu.Lock()
	defer d.setMu.Unlock()
	d.mu.Lock()
	closed := d.closed
	d.mu.Unlock()
	if closed {
		return ErrClosed
	}
	if d.awg != nil {
		return errors.New("dataplane: the AmneziaWG device is already running")
	}

	wrap := newFilteredTUN(newNullTUN(), nil)
	wrap.local = append([]netip.Addr(nil), d.filter.local...)
	router := &relayRoute{main: d.filter, awg: wrap}

	logger := &awgdevice.Logger{Verbosef: awgdevice.DiscardLogf, Errorf: awgdevice.DiscardLogf}
	if d.logf != nil {
		logger.Errorf = func(format string, args ...any) { d.logf("[dataplane/awg] "+format, args...) }
		if d.verbose {
			logger.Verbosef = func(format string, args ...any) { d.logf("[dataplane/awg] "+format, args...) }
		}
	}
	dev := awgdevice.NewDevice(newAWGTUN(wrap, d.mtu), awgconn.NewDefaultBind(), logger)
	// Parameters before the port, and the device is still down: it comes up only at Up.
	uapi := fmt.Sprintf("private_key=%s\n", hex.EncodeToString(d.privKey[:])) +
		cfg.Params.uapi() + fmt.Sprintf("listen_port=%d\n", cfg.ListenPort)
	if err := dev.IpcSet(uapi); err != nil {
		dev.Close()
		return fmt.Errorf("dataplane: configuring the AmneziaWG device: %w", err)
	}
	if err := dev.Up(); err != nil {
		dev.Close()
		return fmt.Errorf("dataplane: bringing the AmneziaWG device up: %w", err)
	}
	port, err := awgListenPort(dev)
	if err != nil {
		dev.Close()
		return err
	}

	d.fwdMu.Lock()
	wrap.forward.Store(d.filter.forward.Load())
	wrap.route.Store(router)
	d.filter.route.Store(router)
	d.fwdMu.Unlock()
	d.awg = &awgRuntime{dev: dev, wrap: wrap, router: router, port: port, peerKeys: map[string]struct{}{}}
	return nil
}

// StopAWG takes the AmneziaWG device down with its peers. A node whose organisation no
// longer allows the method, or whose parameters changed, calls it.
func (d *Device) StopAWG() { d.shutdownAWG() }

func (d *Device) shutdownAWG() {
	d.setMu.Lock()
	defer d.setMu.Unlock()
	rt := d.awg
	if rt == nil {
		return
	}
	d.awg = nil
	if len(rt.peerKeys) > 0 && d.counterEpoch != ^uint64(0) {
		d.counterEpoch++
	}
	d.fwdMu.Lock()
	d.filter.route.Store(nil)
	d.fwdMu.Unlock()
	rt.dev.Close()
}

// AWGRunning reports whether the AmneziaWG device is up.
func (d *Device) AWGRunning() bool {
	d.setMu.Lock()
	defer d.setMu.Unlock()
	return d.awg != nil
}

// AWGPort reports the UDP port the AmneziaWG device is bound to.
func (d *Device) AWGPort() (uint16, error) {
	d.setMu.Lock()
	defer d.setMu.Unlock()
	if d.awg == nil {
		return 0, ErrAWGNotRunning
	}
	return d.awg.port, nil
}

func awgListenPort(dev *awgdevice.Device) (uint16, error) {
	raw, err := dev.IpcGet()
	if err != nil {
		return 0, fmt.Errorf("dataplane: reading AmneziaWG device state: %w", err)
	}
	for _, line := range strings.Split(raw, "\n") {
		if value, ok := strings.CutPrefix(strings.TrimSpace(line), "listen_port="); ok {
			port, convErr := strconv.ParseUint(value, 10, 16)
			if convErr != nil {
				return 0, fmt.Errorf("dataplane: AmneziaWG device reported listen port %q: %w", value, convErr)
			}
			return uint16(port), nil
		}
	}
	return 0, errors.New("dataplane: AmneziaWG device reported no listen port")
}

// applyAWGPeersLocked makes the AmneziaWG device's peer set the one given, removing the
// peers that are gone. The caller holds setMu and has validated the peers.
func (d *Device) applyAWGPeersLocked(peers []Peer) error {
	rt := d.awg
	if rt == nil {
		if len(peers) > 0 {
			return ErrAWGNotRunning
		}
		return nil
	}
	var b strings.Builder
	seen := make(map[string]struct{}, len(peers))
	addrs := make(map[netip.Addr]struct{}, len(peers))
	for _, p := range peers {
		seen[strings.ToLower(strings.TrimSpace(p.PublicKey))] = struct{}{}
	}
	for key := range rt.peerKeys {
		if _, stays := seen[key]; !stays {
			fmt.Fprintf(&b, "public_key=%s\nremove=true\n", key)
		}
	}
	for _, p := range peers {
		fmt.Fprintf(&b, "public_key=%s\nreplace_allowed_ips=true\n", strings.ToLower(strings.TrimSpace(p.PublicKey)))
		for _, aip := range p.AllowedIPs {
			fmt.Fprintf(&b, "allowed_ip=%s\n", aip.String())
			addrs[aip.Addr().Unmap()] = struct{}{}
		}
		if p.PresharedKey != "" {
			fmt.Fprintf(&b, "preshared_key=%s\n", strings.ToLower(strings.TrimSpace(p.PresharedKey)))
		}
		fmt.Fprintf(&b, "persistent_keepalive_interval=%d\n", p.PersistentKeepalive)
	}

	changed := len(seen) != len(rt.peerKeys)
	for key := range seen {
		if _, exists := rt.peerKeys[key]; !exists {
			changed = true
		}
	}
	if changed {
		if d.counterEpoch == ^uint64(0) {
			return errors.New("dataplane: counter epoch exhausted")
		}
		d.counterEpoch++
	}
	if b.Len() > 0 {
		if err := rt.dev.IpcSet(b.String()); err != nil {
			return fmt.Errorf("dataplane: applying %d AmneziaWG peer(s): %w", len(peers), err)
		}
	}
	rt.peerKeys = seen
	rt.router.awgAddrs.Store(&addrs)
	return nil
}

// awgIpcGet is the AmneziaWG device's UAPI state, or "" when it is not running. The
// caller holds setMu. It carries the private key and the parameters: parse, never log.
func (d *Device) awgIpcGet() string {
	if d.awg == nil {
		return ""
	}
	raw, err := d.awg.dev.IpcGet()
	if err != nil {
		return ""
	}
	return raw
}

// awgTUN presents the AmneziaWG wrapper to amneziawg-go, whose tun.Device is a distinct
// type from wireguard-go's with the same methods. It has no kernel or stack behind it: Read
// serves the relay queue only.
type awgTUN struct {
	f      *filteredTUN
	mtu    int
	events chan awgtun.Event
	once   sync.Once
}

func newAWGTUN(f *filteredTUN, mtu int) *awgTUN {
	// No EventUp is queued: amneziawg-go would bring itself up the moment it is created,
	// opening the socket and starting its receive routines while StartAWG is still writing
	// the parameters they read. StartAWG calls Up once the configuration is in.
	return &awgTUN{f: f, mtu: mtu, events: make(chan awgtun.Event, 1)}
}

func (a *awgTUN) File() *os.File { return nil }
func (a *awgTUN) Read(bufs [][]byte, sizes []int, offset int) (int, error) {
	return a.f.readMerged(bufs, sizes, offset)
}
func (a *awgTUN) Write(bufs [][]byte, offset int) (int, error) { return a.f.Write(bufs, offset) }
func (a *awgTUN) MTU() (int, error)                            { return a.mtu, nil }
func (a *awgTUN) Name() (string, error)                        { return "awg0", nil }
func (a *awgTUN) Events() <-chan awgtun.Event                  { return a.events }
func (a *awgTUN) BatchSize() int                               { return 1 }
func (a *awgTUN) Close() error {
	err := a.f.Close()
	a.once.Do(func() { close(a.events) })
	return err
}

// nullTUN is the backend of the AmneziaWG wrapper: nothing is ever read from it and
// whatever is written to it is discarded. Packets for the gateway itself never reach it
// (they go to the first wrapper), so anything that does is traffic with nowhere to go.
type nullTUN struct {
	closed chan struct{}
	events chan tun.Event
	once   sync.Once
}

func newNullTUN() *nullTUN {
	return &nullTUN{closed: make(chan struct{}), events: make(chan tun.Event)}
}

func (n *nullTUN) File() *os.File { return nil }
func (n *nullTUN) Read([][]byte, []int, int) (int, error) {
	<-n.closed
	return 0, os.ErrClosed
}
func (n *nullTUN) Write(bufs [][]byte, _ int) (int, error) { return len(bufs), nil }
func (n *nullTUN) MTU() (int, error)                       { return DefaultMTU, nil }
func (n *nullTUN) Name() (string, error)                   { return "awg-null", nil }
func (n *nullTUN) Events() <-chan tun.Event                { return n.events }
func (n *nullTUN) BatchSize() int                          { return 1 }
func (n *nullTUN) Close() error {
	n.once.Do(func() {
		close(n.closed)
		close(n.events)
	})
	return nil
}
