package main

import (
	"context"
	"encoding/hex"
	"fmt"
	"log"
	"net/netip"
	"os"
	"time"

	"github.com/sovereign/proxy/v4/pkg/acl"
	"github.com/sovereign/proxy/v4/pkg/bridge"
	"github.com/sovereign/proxy/v4/pkg/control"
	"github.com/sovereign/proxy/v4/pkg/crypto"
	"github.com/sovereign/proxy/v4/pkg/dataplane"
)

// dataplaneOptions is everything the data plane needs from main.
type dataplaneOptions struct {
	Mode        string
	SpikeConfig string

	// EchoPort, when non-zero, answers TCP on this node's overlay address. It is how
	// the fleet scenarios prove reachability, and it is subject to the same filter as
	// everything else, so it answers only what the policy permits.
	EchoPort uint16

	// StunServer, when set, is asked for this node's reflexive address so peers
	// behind other networks have a candidate to try.
	StunServer string

	Keypair      *crypto.Keypair
	IdentityPath string

	// Control is the control plane client, and NodeID the identifier it assigned.
	// Nil and empty when registration failed: the node then runs on whatever it has
	// stored, or at default deny.
	Control *control.Client
	NodeID  string

	// Registration is the control plane's answer, which carries the overlay
	// addresses. Nil when registration failed and the node runs standalone.
	Registration *control.RegisterResponse

	Netfilter *acl.NetstackFilter
	Bridge    *bridge.NetstackBridge

	// Netmaps is where the heartbeat loop finds the manager once it exists.
	Netmaps *netmapHolder
}

// overlayPrefixBits is the prefix length of the mesh IPv4 range. The address is
// configured with it rather than as a /32 so a kernel TUN interface gets a route
// covering the other nodes.
const (
	overlayPrefixBits   = 10
	overlayV6PrefixBits = 48
)

// stalenessCheckInterval is how often the node re-examines the age of the document it
// is running on. It is unrelated to the heartbeat, because the case it exists for is
// the one where no heartbeat comes back.
const stalenessCheckInterval = 10 * time.Second

// startDataplane brings the WireGuard data plane up and puts the node on its netmap.
//
// It returns a no-op closer when the mode is off, which is the default: a node started
// without -dataplane runs exactly the code it ran before this package existed.
//
// The order matters. The enforcement filter is installed with the device, before a
// single packet can cross it, and pkg/acl with no policy loaded drops everything: a
// node that never obtains a netmap moves nothing rather than falling back to something
// permissive.
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

	netmapPath := netmapPathFor(opts.IdentityPath)

	// The stored document is read before anything is built, because the device's
	// addresses, MTU and listen port come out of a netmap and a node restarted with
	// the control plane down has only this one.
	stored, storedErr := readPersistedNetmap(netmapPath)
	if storedErr != nil && !os.IsNotExist(storedErr) {
		log.Printf("[SOVEREIGN-NODE] Stored netmap at %s could not be read: %v", netmapPath, storedErr)
	}

	var fetched *control.NetmapResponse
	if opts.Control != nil && opts.NodeID != "" {
		fetchCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
		fetched, err = opts.Control.Netmap(fetchCtx, opts.NodeID, 0)
		cancel()
		if err != nil {
			log.Printf("[SOVEREIGN-NODE] Initial netmap fetch failed: %v", err)
			fetched = nil
		}
	}

	self := selfFrom(fetched, stored)

	addrs, err := overlayAddresses(opts, spike, self)
	if err != nil {
		return nil, err
	}

	cfg := dataplane.Config{
		Mode:       mode,
		PrivateKey: opts.Keypair.PrivateKey,
		Addresses:  addrs,
		ListenPort: listenPort(spike, self),
		MTU:        overlayMTU(spike, self),
		// Unconditional. There is no configuration that turns this off: the filter is
		// where the compiled policy meets the packets, and a node that carries traffic
		// it has not been given a policy for is the failure this whole package exists
		// to prevent.
		Filter:  dataplane.NewACLFilter(opts.Netfilter),
		Verbose: true,
		Logf:    log.Printf,
	}

	dev, err := dataplane.New(cfg)
	if err != nil {
		return nil, err
	}

	log.Printf("[SOVEREIGN-NODE] Data plane up in %s mode on %v (wireguard public key %s, udp port %d, mtu %d, enforcement on)",
		dev.Mode(), dev.Addresses(), hex.EncodeToString(opts.Keypair.PublicKey[:]), cfg.ListenPort, cfg.MTU)

	manager := newNetmapManager(opts.Control, dev, opts.Netfilter, opts.IdentityPath, cfg.ListenPort, opts.StunServer)

	switch {
	case fetched != nil:
		if applyErr := manager.Apply(fetched, time.Now()); applyErr != nil {
			dev.Close()
			return nil, fmt.Errorf("applying the initial netmap: %w", applyErr)
		}
	default:
		loaded, loadErr := manager.LoadPersisted(time.Now())
		if loadErr != nil {
			log.Printf("[SOVEREIGN-NODE] Stored netmap could not be applied: %v", loadErr)
		}
		if !loaded {
			log.Printf("[SOVEREIGN-NODE] No netmap: the node is at default deny and carries no peer")
		} else {
			log.Printf("[SOVEREIGN-NODE] Running fail-static on the stored netmap until the control plane answers")
		}
	}

	// The spike peer document still overrides the peer set, for the two-container lab
	// that has no control plane at all. It is never combined with a netmap: a document
	// from the control plane is the authority whenever there is one.
	if fetched == nil && len(spike.Peers) > 0 {
		if err := dev.SetPeers(spike.Peers); err != nil {
			dev.Close()
			return nil, err
		}
		if spike.Policy != nil {
			opts.Netfilter.UpdatePolicy(spike.Policy)
		}
		log.Printf("[SOVEREIGN-NODE] Spike peer document applied: %d peer(s), policy %s",
			len(spike.Peers), policyNote(spike.Policy))
	}

	if opts.Netmaps != nil {
		opts.Netmaps.set(manager)
	}

	opts.Bridge.SetOverlayDialer(dev)

	echoPort := opts.EchoPort
	if echoPort == 0 {
		echoPort = spike.EchoPort
	}

	var echo *dataplane.EchoResponder
	if echoPort != 0 {
		echo, err = dataplane.ListenEcho(dev, echoPort, log.Printf)
		if err != nil {
			dev.Close()
			return nil, err
		}
		log.Printf("[SOVEREIGN-NODE] Overlay echo listening on %s", echo.Addr())
	}

	loopCtx, stopLoops := context.WithCancel(ctx)
	go manager.WatchStaleness(loopCtx, stalenessCheckInterval)
	if spike.ProbeTarget != "" {
		go probeLoop(loopCtx, dev, spike)
	}

	return func() {
		stopLoops()
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

// selfFrom prefers the document just fetched over the stored one.
func selfFrom(fetched *control.NetmapResponse, stored *persistedNetmap) control.NetmapSelf {
	if fetched != nil {
		return fetched.Self
	}
	if stored != nil && stored.Netmap != nil {
		return stored.Netmap.Self
	}
	return control.NetmapSelf{}
}

func listenPort(spike *dataplane.SpikeConfig, self control.NetmapSelf) uint16 {
	if self.ListenPort != 0 {
		return self.ListenPort
	}
	if spike.ListenPort != 0 {
		return spike.ListenPort
	}
	return dataplane.DefaultListenPort
}

// overlayMTU is a configured constant end to end: the control plane sends the same
// value to every node. There is no path MTU discovery, which is recorded in ADR 0020.
func overlayMTU(spike *dataplane.SpikeConfig, self control.NetmapSelf) int {
	if self.MTU != 0 {
		return self.MTU
	}
	return spike.MTU
}

// overlayAddresses prefers the netmap, then what registration assigned, then the spike
// document. A node with none of the three cannot receive anything and says so.
func overlayAddresses(opts dataplaneOptions, spike *dataplane.SpikeConfig, self control.NetmapSelf) ([]netip.Prefix, error) {
	type assignedAddr struct {
		addr string
		bits int
	}

	var assigned []assignedAddr
	switch {
	case self.OverlayIPv4 != "" || self.OverlayIPv6 != "":
		assigned = []assignedAddr{
			{self.OverlayIPv4, overlayPrefixBits},
			{self.OverlayIPv6, overlayV6PrefixBits},
		}
	case opts.Registration != nil:
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
			return nil, fmt.Errorf("overlay address %q is not an IP: %w", pair.addr, err)
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
