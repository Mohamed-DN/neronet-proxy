package dataplane

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"os"
	"sync"

	"golang.zx2c4.com/wireguard/tun"
	"golang.zx2c4.com/wireguard/tun/netstack"
)

// Virtual devices on the profile gateway (ADR 0036, access method vless-reality).
//
// Some access methods end in a terminator that is not WireGuard (Xray for VLESS +
// REALITY). It authenticates the person by its own means, and the gateway still has to
// put the person's traffic into the mesh as their device: from the device's overlay
// address, under the device's ACL, conntrack, blocks and names, never from a shared NAT
// or from the gateway's own address.
//
// A virtual device gives the device an IP stack of its own inside the gateway process
// (gVisor, bound to exactly the device's addresses). What the stack sends is what a
// decrypted packet from a WireGuard device would be: it is handed to the first wrapper's
// Write, so the very same code decides it (mesh names, exit, forwarding table, policy,
// conntrack) and relays it to whichever peer holds the destination. The way back is the
// reverse: a packet for the device's address is queued on the device's wrapper instead
// of being encrypted for a peer, and is written into its stack. The source address is
// authenticated twice: the stack cannot emit another one, and the pump drops a packet
// whose source is not one of the device's addresses.
//
// The device's policy lives where it always did, in the ForwardTable (SetForwarding); a
// virtual device whose address the table does not hold has all its packets refused.

// VirtualSpec names a virtual device and the overlay addresses it owns.
type VirtualSpec struct {
	ID    string
	Addrs []netip.Addr
}

type virtualDevice struct {
	id    string
	addrs []netip.Addr
	wrap  *filteredTUN // queue of packets addressed to the device
	dev   tun.Device
	tnet  *netstack.Net
	once  sync.Once
}

func (v *virtualDevice) close() {
	v.once.Do(func() {
		_ = v.wrap.Close()
		_ = v.dev.Close()
	})
}

// VirtualDialer opens connections that enter the mesh as one virtual device.
type VirtualDialer struct{ v *virtualDevice }

// DialContext dials through the device's own stack. A name is resolved by the mesh
// resolver, from the device's address, so what it learns is what the device may see.
func (vd VirtualDialer) DialContext(ctx context.Context, network, address string) (net.Conn, error) {
	return vd.v.tnet.DialContext(ctx, network, address)
}

// SetVirtualDevices makes the gateway's set of virtual devices the one given. A device
// that is unchanged keeps its stack and its connections; one that is gone or whose
// addresses changed is closed, which ends its connections at once (a revoked device).
func (d *Device) SetVirtualDevices(specs []VirtualSpec) error {
	d.mu.Lock()
	closed := d.closed
	d.mu.Unlock()
	if closed {
		return ErrClosed
	}
	seenID := map[string]bool{}
	seenAddr := map[netip.Addr]bool{}
	for _, s := range specs {
		if s.ID == "" {
			return errors.New("dataplane: a virtual device needs an id")
		}
		if seenID[s.ID] {
			return fmt.Errorf("dataplane: virtual device %q appears twice", s.ID)
		}
		seenID[s.ID] = true
		if len(s.Addrs) == 0 {
			return fmt.Errorf("dataplane: virtual device %q has no address", s.ID)
		}
		for _, a := range s.Addrs {
			a = a.Unmap()
			if !a.IsValid() || seenAddr[a] || d.filter.isLocal(a) {
				return fmt.Errorf("dataplane: virtual device %q: address %s is invalid, taken or the gateway's own", s.ID, a)
			}
			seenAddr[a] = true
		}
	}

	d.virtMu.Lock()
	defer d.virtMu.Unlock()
	if d.virt == nil {
		d.virt = map[string]*virtualDevice{}
	}
	next := make(map[string]*virtualDevice, len(specs))
	var stale []*virtualDevice
	for _, s := range specs {
		addrs := make([]netip.Addr, len(s.Addrs))
		for i, a := range s.Addrs {
			addrs[i] = a.Unmap()
		}
		if old, ok := d.virt[s.ID]; ok && sameAddrs(old.addrs, addrs) {
			next[s.ID] = old
			continue
		}
		v, err := d.newVirtualDevice(s.ID, addrs)
		if err != nil {
			for _, made := range next {
				if d.virt[made.id] != made {
					made.close()
				}
			}
			return err
		}
		next[s.ID] = v
	}
	for id, old := range d.virt {
		if next[id] != old {
			stale = append(stale, old)
		}
	}
	routes := make(map[netip.Addr]*filteredTUN)
	for _, v := range next {
		for _, a := range v.addrs {
			routes[a] = v.wrap
		}
	}
	// The routes change before the old stacks close, so a reply for a removed device
	// is dropped by the relay and not queued on a wrapper nobody reads.
	if len(routes) == 0 {
		d.filter.virt.Store(nil)
	} else {
		d.filter.virt.Store(&routes)
	}
	d.virt = next
	for _, old := range stale {
		old.close()
	}
	return nil
}

// VirtualDialer returns the dialer of a virtual device.
func (d *Device) VirtualDialer(id string) (VirtualDialer, bool) {
	d.virtMu.Lock()
	defer d.virtMu.Unlock()
	v, ok := d.virt[id]
	if !ok {
		return VirtualDialer{}, false
	}
	return VirtualDialer{v: v}, true
}

func sameAddrs(a, b []netip.Addr) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func (d *Device) newVirtualDevice(id string, addrs []netip.Addr) (*virtualDevice, error) {
	dev, tnet, err := netstack.CreateNetTUN(addrs, []netip.Addr{ExitDNS}, d.mtu)
	if err != nil {
		return nil, fmt.Errorf("dataplane: userspace stack for virtual device %q: %w", id, err)
	}
	v := &virtualDevice{
		id:    id,
		addrs: addrs,
		wrap:  newFilteredTUN(newNullTUN(), nil),
		dev:   dev,
		tnet:  tnet,
	}
	go d.virtualUp(v)
	go virtualDown(v)
	return v, nil
}

const virtualBuf = 2048

// virtualUp carries what the device's stack sends into the gateway's forwarding point.
func (d *Device) virtualUp(v *virtualDevice) {
	bufs := [][]byte{make([]byte, virtualBuf)}
	sizes := make([]int, 1)
	for {
		n, err := v.dev.Read(bufs, sizes, 0)
		if err != nil && n == 0 {
			return
		}
		for i := 0; i < n; i++ {
			raw := bufs[i][:sizes[i]]
			pkt, ok := ParsePacket(raw)
			if !ok || !v.owns(pkt.Src) {
				v.wrap.forwardDropped.Add(1)
				continue
			}
			cp := append([]byte(nil), raw...)
			_, _ = d.filter.Write([][]byte{cp}, 0)
		}
	}
}

// virtualDown writes what the gateway relays to the device into its stack.
func virtualDown(v *virtualDevice) {
	bufs := make([][]byte, 8)
	for i := range bufs {
		bufs[i] = make([]byte, virtualBuf)
	}
	sizes := make([]int, len(bufs))
	for {
		n, err := v.wrap.readMerged(bufs, sizes, 0)
		if err != nil {
			return
		}
		out := make([][]byte, n)
		for i := 0; i < n; i++ {
			out[i] = bufs[i][:sizes[i]]
		}
		_, _ = v.dev.Write(out, 0)
	}
}

func (v *virtualDevice) owns(a netip.Addr) bool {
	a = a.Unmap()
	for _, x := range v.addrs {
		if x == a {
			return true
		}
	}
	return false
}

// closeVirtual ends every virtual device. Device.Close calls it.
func (d *Device) closeVirtual() {
	d.virtMu.Lock()
	defer d.virtMu.Unlock()
	d.filter.virt.Store(nil)
	for _, v := range d.virt {
		v.close()
	}
	d.virt = nil
}

// divertToVirt queues a packet the gateway's own stack produced (a mesh name answer, a
// reply to a connection to the gateway) on the virtual device it is addressed to.
func (f *filteredTUN) divertToVirt(raw []byte) bool {
	m := f.virt.Load()
	if m == nil {
		return false
	}
	dst, ok := destinationOf(raw)
	if !ok {
		return false
	}
	w, ok := (*m)[dst.Unmap()]
	if !ok {
		return false
	}
	w.enqueueOriginated(raw)
	return true
}

// virtualWrapper is the wrapper a relayed packet for a virtual device goes to.
func (f *filteredTUN) virtualWrapper(dst netip.Addr) (*filteredTUN, bool) {
	m := f.virt.Load()
	if m == nil {
		return nil, false
	}
	w, ok := (*m)[dst.Unmap()]
	return w, ok
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
