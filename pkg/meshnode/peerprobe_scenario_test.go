package meshnode

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"net/netip"
	"testing"
	"time"

	"github.com/sovereign/proxy/v4/pkg/control"
	"github.com/sovereign/proxy/v4/pkg/crypto"
	"github.com/sovereign/proxy/v4/pkg/dataplane"
)

// A scenario with real WireGuard devices in this process (no mocks of the data plane): a
// gateway and two devices. One device answers ICMP; the other completes the handshake and
// then drops every ICMP packet, as a Windows machine with its default firewall does.
// The gateway's prober must report a number for the first and "no reply" for the second,
// and the second must still count as connected.

type dropICMP struct{}

func (dropICMP) Outbound(dataplane.Packet) error { return nil }
func (dropICMP) Inbound(p dataplane.Packet) error {
	if p.Protocol == dataplane.ProtoICMPv4 || p.Protocol == dataplane.ProtoICMPv6 {
		return errors.New("icmp dropped by the device's firewall")
	}
	return nil
}

type liveNode struct {
	keys *crypto.Keypair
	dev  *dataplane.Device
	addr netip.Addr
	port uint16
}

func bringUp(t *testing.T, address string, filter dataplane.PacketFilter) *liveNode {
	t.Helper()
	keys, err := crypto.GenerateKeypair()
	if err != nil {
		t.Fatal(err)
	}
	prefix := netip.MustParsePrefix(address)
	dev, err := dataplane.New(dataplane.Config{
		Mode: dataplane.ModeNetstack, PrivateKey: keys.PrivateKey, Addresses: []netip.Prefix{prefix}, Filter: filter,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = dev.Close() })
	port, err := dev.ListenPort()
	if err != nil {
		t.Fatal(err)
	}
	return &liveNode{keys: keys, dev: dev, addr: prefix.Addr(), port: port}
}

func (n *liveNode) entry() dataplane.Peer {
	return dataplane.Peer{
		PublicKey:  hex.EncodeToString(n.keys.PublicKey[:]),
		Endpoint:   fmt.Sprintf("127.0.0.1:%d", n.port),
		AllowedIPs: []netip.Prefix{netip.PrefixFrom(n.addr, n.addr.BitLen())},
	}
}

func TestGatewayMeasuresAnAnsweringDeviceAndReportsNoReplyForOneThatDropsICMP(t *testing.T) {
	gateway := bringUp(t, "100.64.0.1/10", nil)
	answering := bringUp(t, "100.64.0.2/10", nil)
	silent := bringUp(t, "100.64.0.3/10", dropICMP{})
	if err := gateway.dev.SetPeers([]dataplane.Peer{answering.entry(), silent.entry()}); err != nil {
		t.Fatal(err)
	}
	for _, device := range []*liveNode{answering, silent} {
		if err := device.dev.SetPeers([]dataplane.Peer{gateway.entry()}); err != nil {
			t.Fatal(err)
		}
	}

	pr := newPeerProber(gateway.dev)
	pr.timeout = 400 * time.Millisecond
	targetFor := func(id string, n *liveNode) probeTarget {
		for _, p := range handshakes(t, gateway.dev) {
			if p.PublicKey == hex.EncodeToString(n.keys.PublicKey[:]) {
				return probeTarget{PeerID: id, Addr: n.addr, LastHandshake: p.LastHandshake}
			}
		}
		return probeTarget{PeerID: id, Addr: n.addr}
	}

	// The first packets start the handshake; keep asking until it has completed.
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	var sample rttSample
	for ctx.Err() == nil {
		sample, _ = pr.probeNow(ctx, probeTarget{PeerID: "dev-answering", Addr: answering.addr, LastHandshake: time.Now()})
		if sample.RTTMillis != nil {
			break
		}
		time.Sleep(200 * time.Millisecond)
	}
	if sample.RTTMillis == nil || *sample.RTTMillis <= 0 {
		t.Fatalf("the answering device was not measured: %+v", sample)
	}

	// The silent device: drive a handshake with its own traffic, then ping it.
	for ctx.Err() == nil {
		// The reply is dropped by the silent device itself, so bound each ping.
		hs, cancelHS := context.WithTimeout(ctx, 500*time.Millisecond)
		_, _ = silent.dev.Ping(hs, gateway.addr) // the handshake completes on the way
		cancelHS()
		if !targetFor("dev-silent", silent).LastHandshake.IsZero() {
			break
		}
		time.Sleep(200 * time.Millisecond)
	}
	silentTarget := targetFor("dev-silent", silent)
	if silentTarget.LastHandshake.IsZero() {
		t.Fatal("the silent device never completed a handshake, so the scenario proves nothing")
	}
	pr.sweep(ctx, []probeTarget{silentTarget, targetFor("dev-answering", answering)})

	got, ok := pr.Sample("dev-silent")
	if !ok || got.RTTMillis != nil || got.At.IsZero() {
		t.Fatalf("a device that drops ICMP = %+v, want a sample with a time and no value", got)
	}
	if rep, ok := pr.Sample("dev-answering"); !ok || rep.RTTMillis == nil {
		t.Fatalf("the answering device after a sweep = %+v, want a measured value", rep)
	}

	// What the heartbeat would carry for the two, from the same state.
	doc := []control.NetmapPeer{
		{NodeID: "dev-answering", PublicKeyHex: hex.EncodeToString(answering.keys.PublicKey[:]), Profile: true,
			AllowedIPs: []string{"100.64.0.2/32"}},
		{NodeID: "dev-silent", PublicKeyHex: hex.EncodeToString(silent.keys.PublicKey[:]), Profile: true,
			AllowedIPs: []string{"100.64.0.3/32"}},
	}
	report := peerPathReport(doc, nil, false, gateway.dev.SampleAuthenticatedPaths(), noPaths{}, pr, time.Now())
	byID := map[string]control.PeerPathObservation{}
	for _, o := range report {
		byID[o.PeerID] = o
	}
	if o := byID["dev-answering"]; o.RTTMillis == nil || o.RTTObservedAtUnix == nil {
		t.Fatalf("answering device observation = %+v", o)
	}
	o := byID["dev-silent"]
	if o.RTTMillis != nil || o.RTTObservedAtUnix == nil || o.LastHandshakeUnix == nil {
		t.Fatalf("silent device observation = %+v, want no value, a sample time and a handshake (connected, not answering)", o)
	}
}

func handshakes(t *testing.T, dev *dataplane.Device) []dataplane.PeerStatus {
	t.Helper()
	peers, err := dev.Peers()
	if err != nil {
		t.Fatal(err)
	}
	return peers
}
