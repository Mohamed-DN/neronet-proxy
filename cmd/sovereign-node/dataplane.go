package main

import (
	"context"
	"encoding/hex"
	"fmt"
	"log"
	"net/netip"
	"time"

	"github.com/sovereign/proxy/v4/pkg/acl"
	"github.com/sovereign/proxy/v4/pkg/bridge"
	"github.com/sovereign/proxy/v4/pkg/control"
	"github.com/sovereign/proxy/v4/pkg/crypto"
	"github.com/sovereign/proxy/v4/pkg/dataplane"
)

// dataplaneOptions is everything the spike data plane needs from main.
type dataplaneOptions struct {
	Mode        string
	SpikeConfig string

	Keypair *crypto.Keypair

	// Registration is the control plane's answer, which carries the overlay
	// addresses. Nil when registration failed and the node runs standalone.
	Registration *control.RegisterResponse

	Netfilter *acl.NetstackFilter
	Bridge    *bridge.NetstackBridge
}

// overlayPrefixBits is the prefix length of the mesh IPv4 range. The address is
// configured with it rather than as a /32 so a kernel TUN interface gets a route
// covering the other nodes.
const (
	overlayPrefixBits   = 10
	overlayV6PrefixBits = 48
)

// startDataplane brings up the WP-201 spike data plane.
//
// It returns a no-op closer when the mode is off, which is the default: a node
// started without -dataplane runs exactly the code it ran before this package
// existed.
func startDataplane(ctx context.Context, opts dataplaneOptions) (func(), error) {
	mode, err := dataplane.ParseMode(opts.Mode)
	if err != nil {
		return nil, err
	}
	if mode == dataplane.ModeOff {
		return func() {}, nil
	}

	var spike *dataplane.SpikeConfig
	if opts.SpikeConfig != "" {
		spike, err = dataplane.LoadSpikeConfig(opts.SpikeConfig)
		if err != nil {
			return nil, err
		}
	} else {
		spike = &dataplane.SpikeConfig{}
	}

	addrs, err := overlayAddresses(opts, spike)
	if err != nil {
		return nil, err
	}

	cfg := dataplane.Config{
		Mode:       mode,
		PrivateKey: opts.Keypair.PrivateKey,
		Addresses:  addrs,
		ListenPort: listenPort(spike),
		MTU:        spike.MTU,
		Verbose:    true,
		Logf:       log.Printf,
	}
	if spike.Enforce {
		// Enforcement is opt-in for the spike and default-deny once on: with no
		// policy loaded pkg/acl rejects every packet, which is the correct
		// behaviour and a useless measurement.
		cfg.Filter = dataplane.NewACLFilter(opts.Netfilter)
	}

	dev, err := dataplane.New(cfg)
	if err != nil {
		return nil, err
	}

	log.Printf("[SOVEREIGN-NODE] Data plane up in %s mode on %v (wireguard public key %s, udp port %d, enforcement %t)",
		dev.Mode(), dev.Addresses(), hex.EncodeToString(opts.Keypair.PublicKey[:]), listenPort(spike), spike.Enforce)

	if err := dev.SetPeers(spike.Peers); err != nil {
		dev.Close()
		return nil, err
	}
	log.Printf("[SOVEREIGN-NODE] Data plane peers applied: %d", len(spike.Peers))

	opts.Bridge.SetOverlayDialer(dev)

	var echo *dataplane.EchoResponder
	if spike.EchoPort != 0 {
		echo, err = dataplane.ListenEcho(dev, spike.EchoPort, log.Printf)
		if err != nil {
			dev.Close()
			return nil, err
		}
		log.Printf("[SOVEREIGN-NODE] Spike measurement responder listening on %s", echo.Addr())
	}

	probeCtx, stopProbe := context.WithCancel(ctx)
	if spike.ProbeTarget != "" {
		go probeLoop(probeCtx, dev, spike)
	}

	return func() {
		stopProbe()
		if echo != nil {
			_ = echo.Close()
		}
		opts.Bridge.SetOverlayDialer(nil)
		stats := dev.Stats()
		log.Printf("[SOVEREIGN-NODE] Data plane stopping (dropped: outbound %d, inbound %d, malformed %d)",
			stats.OutboundDropped, stats.InboundDropped, stats.MalformedDropped)
		_ = dev.Close()
	}, nil
}

func listenPort(spike *dataplane.SpikeConfig) uint16 {
	if spike.ListenPort == 0 {
		return dataplane.DefaultListenPort
	}
	return spike.ListenPort
}

// overlayAddresses prefers the addresses the control plane assigned. The spike file
// supplies them only when there are none, which is how a node measured without a
// control plane gets an address at all.
func overlayAddresses(opts dataplaneOptions, spike *dataplane.SpikeConfig) ([]netip.Prefix, error) {
	type assignedAddr struct {
		addr string
		bits int
	}

	var assigned []assignedAddr
	if opts.Registration != nil {
		assigned = []assignedAddr{
			{opts.Registration.OverlayIPv4, overlayPrefixBits},
			{opts.Registration.OverlayIPv6, overlayV6PrefixBits},
		}
	}

	var out []netip.Prefix
	for _, pair := range assigned {
		if pair.addr == "" {
			continue
		}
		a, err := netip.ParseAddr(pair.addr)
		if err != nil {
			return nil, fmt.Errorf("control plane assigned overlay address %q is not an IP: %w", pair.addr, err)
		}
		out = append(out, netip.PrefixFrom(a, pair.bits))
	}

	if len(out) > 0 {
		return out, nil
	}
	if len(spike.Addresses) > 0 {
		return spike.Addresses, nil
	}
	return nil, dataplane.ErrNoAddresses
}

// probeLoop reports a measured round trip through the tunnel. A failed probe is
// logged as a failure and not as a number: an unreachable peer has no latency.
func probeLoop(ctx context.Context, dev *dataplane.Device, spike *dataplane.SpikeConfig) {
	target, err := netip.ParseAddr(spike.ProbeTarget)
	if err != nil {
		log.Printf("[SOVEREIGN-NODE] Data plane probe target %q is not an address: %v", spike.ProbeTarget, err)
		return
	}

	interval := time.Duration(spike.ProbeIntervalSeconds) * time.Second
	if interval <= 0 {
		interval = 10 * time.Second
	}

	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			probeCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
			rtt, err := dev.Ping(probeCtx, target)
			cancel()
			if err != nil {
				log.Printf("[SOVEREIGN-NODE] Data plane probe to %s failed: %v", target, err)
				continue
			}
			log.Printf("[SOVEREIGN-NODE] Data plane probe to %s: rtt %.3f ms", target, float64(rtt.Microseconds())/1000)
		}
	}
}
