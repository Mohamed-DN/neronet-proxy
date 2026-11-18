package dataplane

import (
	"context"
	"io"
	"net"
	"net/netip"
	"testing"
	"time"

	"github.com/sovereign/proxy/v4/pkg/acl"
)

// A virtual device (ADR 0036, vless-reality) is a profile device that has no WireGuard
// peer: a terminator outside the gateway authenticates the person and the gateway
// originates their connections from the device's own overlay address, inside the same
// forwarding table, so the same ACL and conntrack decide. These tests build
//
//	V (virtual device 100.64.0.3, inside G) --- G (gateway, 100.64.0.1) --- N (mesh node, 100.64.0.2)
//
// and look at what N sees.

type virtRig struct {
	g, n    *testNode
	table   *ForwardTable
	dFilter *acl.NetstackFilter
}

func newVirtRig(t *testing.T, policy *acl.CompiledPeerPolicy) *virtRig {
	t.Helper()
	g := newTestNode(t, gwAddr+"/10", nil)
	n := newTestNode(t, meshAddr+"/10", nil)
	if err := g.dev.SetPeers([]Peer{n.peerEntry()}); err != nil {
		t.Fatalf("G peers: %v", err)
	}
	gwForMesh := g.peerEntry()
	gwForMesh.AllowedIPs = []netip.Prefix{prefix32(gwAddr), prefix32(deviceAddr)}
	if err := n.dev.SetPeers([]Peer{gwForMesh}); err != nil {
		t.Fatalf("N peers: %v", err)
	}
	r := &virtRig{g: g, n: n, dFilter: acl.NewNetstackFilter()}
	r.dFilter.UpdatePolicy(policy)
	r.table = NewForwardTable()
	r.table.AddDevice(netip.MustParseAddr(deviceAddr), r.dFilter)
	g.dev.SetForwarding(r.table)
	if err := g.dev.SetVirtualDevices([]VirtualSpec{{ID: "dev-1", Addrs: []netip.Addr{netip.MustParseAddr(deviceAddr)}}}); err != nil {
		t.Fatalf("SetVirtualDevices: %v", err)
	}
	return r
}

// sourceRecorder accepts connections on N and reports the remote address of each.
func sourceRecorder(t *testing.T, d *Device, port uint16) <-chan string {
	t.Helper()
	ln, err := d.Listen("tcp", netip.AddrPortFrom(netip.MustParseAddr(meshAddr), port).String())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	seen := make(chan string, 8)
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			seen <- c.RemoteAddr().String()
			go func() { _, _ = io.Copy(c, c); c.Close() }()
		}
	}()
	return seen
}

func dialVirtual(t *testing.T, g *Device, id, address string, total time.Duration) (net.Conn, error) {
	t.Helper()
	dl, ok := g.VirtualDialer(id)
	if !ok {
		t.Fatalf("no virtual device %q", id)
	}
	deadline := time.Now().Add(total)
	var err error
	for time.Now().Before(deadline) {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		var c net.Conn
		c, err = dl.DialContext(ctx, "tcp", address)
		cancel()
		if err == nil {
			return c, nil
		}
	}
	return nil, err
}

func TestVirtualDeviceEntersTheMeshAsTheDeviceNotTheGateway(t *testing.T) {
	policy := devicePolicy(deviceAddr,
		[]acl.CompiledFilterRule{rule(meshAddr, acl.ProtocolTCP, 9999, acl.ActionAccept)}, nil)
	r := newVirtRig(t, policy)
	seen := sourceRecorder(t, r.n.dev, 9999)

	c, err := dialVirtual(t, r.g.dev, "dev-1", meshAddr+":9999", 15*time.Second)
	if err != nil {
		t.Fatalf("virtual device -> mesh node: %v", err)
	}
	defer c.Close()
	_ = c.SetDeadline(time.Now().Add(5 * time.Second))
	if _, err := c.Write([]byte("hello")); err != nil {
		t.Fatal(err)
	}
	got := make([]byte, 5)
	if _, err := io.ReadFull(c, got); err != nil || string(got) != "hello" {
		t.Fatalf("echo %q %v", got, err)
	}

	remote := <-seen
	ap, _ := netip.ParseAddrPort(remote)
	if ap.Addr().String() != deviceAddr {
		t.Fatalf("mesh node saw source %s, want the device's overlay address %s (the gateway is %s)", ap.Addr(), deviceAddr, gwAddr)
	}
	if st := r.g.dev.Stats(); st.Forwarded < 2 {
		t.Fatalf("gateway forwarded %d packets; the exchange must pass the forwarding point both ways", st.Forwarded)
	}
}

func TestVirtualDeviceIsCutByItsDropRuleAndByNoRule(t *testing.T) {
	for name, outbound := range map[string][]acl.CompiledFilterRule{
		"explicit drop": {rule(meshAddr, acl.ProtocolTCP, 9999, acl.ActionDrop)},
		"no rule":       nil,
	} {
		t.Run(name, func(t *testing.T) {
			r := newVirtRig(t, devicePolicy(deviceAddr, outbound, nil))
			seen := sourceRecorder(t, r.n.dev, 9999)
			dl, _ := r.g.dev.VirtualDialer("dev-1")
			ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
			defer cancel()
			if c, err := dl.DialContext(ctx, "tcp", meshAddr+":9999"); err == nil {
				c.Close()
				t.Fatal("the connection was carried although the device's policy forbids it")
			}
			select {
			case s := <-seen:
				t.Fatalf("mesh node received a connection from %s", s)
			default:
			}
			if r.g.dev.Stats().ForwardDropped == 0 {
				t.Fatal("the gateway counted no dropped forwarded packet")
			}
		})
	}
}

func TestVirtualDeviceRemovalEndsItsConnectionsAndItsDialer(t *testing.T) {
	policy := devicePolicy(deviceAddr,
		[]acl.CompiledFilterRule{rule(meshAddr, acl.ProtocolTCP, 9999, acl.ActionAccept)}, nil)
	r := newVirtRig(t, policy)
	_ = sourceRecorder(t, r.n.dev, 9999)
	c, err := dialVirtual(t, r.g.dev, "dev-1", meshAddr+":9999", 15*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()

	if err := r.g.dev.SetVirtualDevices(nil); err != nil {
		t.Fatal(err)
	}
	if _, ok := r.g.dev.VirtualDialer("dev-1"); ok {
		t.Fatal("a removed device still has a dialer")
	}
	_ = c.SetDeadline(time.Now().Add(3 * time.Second))
	_, _ = c.Write([]byte("x"))
	buf := make([]byte, 1)
	if _, err := c.Read(buf); err == nil {
		t.Fatal("an established connection of a removed device still carries data")
	}
}

func TestVirtualDevicesRefuseOverlappingAndInvalidSpecs(t *testing.T) {
	g := newTestNode(t, gwAddr+"/10", nil)
	a := netip.MustParseAddr(deviceAddr)
	for name, specs := range map[string][]VirtualSpec{
		"same address twice": {{ID: "a", Addrs: []netip.Addr{a}}, {ID: "b", Addrs: []netip.Addr{a}}},
		"duplicate id":       {{ID: "a", Addrs: []netip.Addr{a}}, {ID: "a", Addrs: []netip.Addr{netip.MustParseAddr(otherAddr)}}},
		"no address":         {{ID: "a"}},
		"no id":              {{Addrs: []netip.Addr{a}}},
		"the gateway itself": {{ID: "a", Addrs: []netip.Addr{netip.MustParseAddr(gwAddr)}}},
	} {
		if err := g.dev.SetVirtualDevices(specs); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}
