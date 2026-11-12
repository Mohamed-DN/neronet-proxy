package dataplane

import (
	"errors"
	"fmt"
	"net/netip"
	"sync"
	"time"
)

// Exit nodes (ADR 0032, phase 1).
//
// A client of an exit sends all its traffic into the tunnel, internet included. The
// node that serves it (a profile gateway for a stock WireGuard phone) decides, per
// packet, whether an internet-bound packet may leave and where:
//
//   - EgressLocal: this node is the exit. The packet goes into a userspace IP stack of
//     its own (egress_stack.go) whose TCP and UDP forwarders dial the destination from
//     this host's network, as Tailscale does for a userspace exit node. No capability,
//     no ip_forward, no NAT table: the host sees ordinary outgoing sockets.
//   - EgressMesh: another mesh node is the exit. The packet is relayed to it inside
//     WireGuard; the peer that holds 0.0.0.0/0 and ::/0 in this node's peer set is that
//     exit, and the exit applies the same checks again before it dials.
//   - EgressNone: an exit was chosen but cannot be used here (the exit node is not in
//     the peer set, or this node was not started as an exit). The packet is dropped.
//     There is never a fallback to another path: a client whose exit is down has no
//     internet, which is the only behaviour that cannot leak.
//
// What may leave is checked before anything is dialled or relayed, in this order:
// fragments and protocols other than TCP and UDP are dropped; addresses that belong to
// the exit's own networks (RFC 1918, CGNAT and the overlay, loopback, link-local and the
// cloud metadata address, multicast, unique-local IPv6) are dropped unless the client
// is allowed the exit's LAN, and loopback, link-local and multicast never are; then the
// client's internet rules decide, first match wins, and no matching rule accepts,
// because the exit assignment itself is the administrator's grant.
//
// The one overlay-range address that is not refused is ExitDNS on port 53: the exit
// answers it from its own resolver, so names resolve where the traffic leaves.

// ExitDNS is the address a full-tunnel profile names as its DNS server. Port 53 of it
// is answered by the exit the client uses, from that exit's own resolver. The control
// plane never allocates it to a node.
var ExitDNS = netip.MustParseAddr("100.100.100.100")

// EgressVia says where a client's internet-bound packets leave.
type EgressVia uint8

const (
	// EgressNone drops them: the chosen exit is not usable from here.
	EgressNone EgressVia = iota
	// EgressLocal dials them out from this host.
	EgressLocal
	// EgressMesh relays them to the mesh exit that holds the default route.
	EgressMesh
)

func (v EgressVia) String() string {
	switch v {
	case EgressLocal:
		return "local"
	case EgressMesh:
		return "mesh"
	default:
		return "none"
	}
}

// InternetRule is one of a client's ordered internet rules. Proto 0 matches TCP and
// UDP; PortLo/PortHi bound the destination port, 0-65535 for all.
type InternetRule struct {
	Prefix netip.Prefix
	Proto  uint8
	PortLo uint16
	PortHi uint16
	Accept bool
}

// EgressClient is one address that may send internet-bound packets through this node.
type EgressClient struct {
	ID       string
	Via      EgressVia
	AllowLAN bool
	Rules    []InternetRule
}

var (
	errEgressNoExit    = errors.New("dataplane: the chosen exit is not usable from this node")
	errEgressFragment  = errors.New("dataplane: fragment on the exit path")
	errEgressProto     = errors.New("dataplane: only TCP and UDP leave through an exit")
	errEgressPrivate   = errors.New("dataplane: destination is on the exit's private networks")
	errEgressRule      = errors.New("dataplane: an internet rule drops the destination")
	errEgressNoStack   = errors.New("dataplane: no userspace egress stack on this node")
	errEgressQueueFull = errors.New("dataplane: egress queue full")
)

// EgressTable is the node's set of exit clients. Like a ForwardTable it is immutable
// once installed; the conntrack it carries is handed from one table to the next so a
// netmap change does not cut the replies of flows already open.
type EgressTable struct {
	clients    map[netip.Addr]*EgressClient
	meshRoutes []netip.Prefix
	ct         *egressConntrack
}

// NewEgressTable returns an empty table.
func NewEgressTable() *EgressTable {
	return &EgressTable{clients: map[netip.Addr]*EgressClient{}, ct: newEgressConntrack()}
}

// AddClient registers one address of a client. A client with an IPv4 and an IPv6
// address is added twice with the same entry.
func (t *EgressTable) AddClient(addr netip.Addr, c *EgressClient) {
	if c == nil {
		panic("dataplane: EgressTable.AddClient with a nil client")
	}
	t.clients[addr.Unmap()] = c
}

// AddMeshRoute records a prefix a mesh peer routes (a subnet router): destinations in
// it are mesh traffic, never internet, even for a client of an exit.
func (t *EgressTable) AddMeshRoute(p netip.Prefix) {
	t.meshRoutes = append(t.meshRoutes, p.Masked())
}

// Len reports how many client addresses the table holds.
func (t *EgressTable) Len() int {
	if t == nil {
		return 0
	}
	return len(t.clients)
}

// Client returns the entry for one client address.
func (t *EgressTable) Client(addr netip.Addr) (*EgressClient, bool) {
	if t == nil {
		return nil, false
	}
	c, ok := t.clients[addr.Unmap()]
	return c, ok
}

// HasLocal reports whether any client leaves from this host.
func (t *EgressTable) HasLocal() bool {
	if t == nil {
		return false
	}
	for _, c := range t.clients {
		if c.Via == EgressLocal {
			return true
		}
	}
	return false
}

// adoptConntrack keeps the previous table's flows.
func (t *EgressTable) adoptConntrack(prev *EgressTable) {
	if prev != nil && prev.ct != nil {
		t.ct = prev.ct
	}
}

// isInternet reports whether dst is an exit destination rather than mesh traffic.
func (t *EgressTable) isInternet(dst netip.Addr) bool {
	dst = dst.Unmap()
	if dst == ExitDNS {
		return true
	}
	for _, p := range overlayPrefixes {
		if p.Contains(dst) {
			return false
		}
	}
	for _, p := range t.meshRoutes {
		if p.Contains(dst) {
			return false
		}
	}
	return true
}

// overlayPrefixes are the mesh's own ranges: traffic to them is never internet.
var overlayPrefixes = []netip.Prefix{
	netip.MustParsePrefix("100.64.0.0/10"),
	netip.MustParsePrefix("fd7a:115c:a1e0::/48"),
}

// neverPrefixes no client reaches through an exit, whatever it is allowed: the exit
// host itself, its link (including 169.254.169.254, the cloud metadata service) and
// multicast.
var neverPrefixes = []netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/8"),
	netip.MustParsePrefix("127.0.0.0/8"),
	netip.MustParsePrefix("169.254.0.0/16"),
	netip.MustParsePrefix("224.0.0.0/4"),
	netip.MustParsePrefix("240.0.0.0/4"),
	netip.MustParsePrefix("::/128"),
	netip.MustParsePrefix("::1/128"),
	netip.MustParsePrefix("fe80::/10"),
	netip.MustParsePrefix("ff00::/8"),
	netip.MustParsePrefix("::ffff:0:0/96"),
}

// lanPrefixes are the exit's private networks: refused unless the client is allowed
// the exit's LAN. The overlay and CGNAT range is here too, so a client cannot reach
// the exit's own mesh or its provider's carrier-grade NAT through the exit path.
var lanPrefixes = []netip.Prefix{
	netip.MustParsePrefix("10.0.0.0/8"),
	netip.MustParsePrefix("172.16.0.0/12"),
	netip.MustParsePrefix("192.168.0.0/16"),
	netip.MustParsePrefix("100.64.0.0/10"),
	netip.MustParsePrefix("fc00::/7"),
}

func inPrefixes(a netip.Addr, ps []netip.Prefix) bool {
	for _, p := range ps {
		if p.Contains(a) {
			return true
		}
	}
	return false
}

// blockedDestination is the private-range check on its own, so a test can name it.
func blockedDestination(dst netip.Addr, allowLAN bool) bool {
	dst = dst.Unmap()
	if inPrefixes(dst, neverPrefixes) {
		return true
	}
	if inPrefixes(dst, lanPrefixes) {
		return !allowLAN
	}
	return false
}

// Decide applies a client's exit checks to an internet-bound packet it sent.
func (c *EgressClient) Decide(p Packet) error {
	if c.Via == EgressNone {
		return errEgressNoExit
	}
	if p.Fragment {
		return errEgressFragment
	}
	if p.Protocol != ProtoTCP && p.Protocol != ProtoUDP {
		return errEgressProto
	}
	dst := p.Dst.Unmap()
	if dst == ExitDNS {
		if p.DstPort != 53 {
			return errEgressPrivate
		}
	} else if blockedDestination(dst, c.AllowLAN) {
		return errEgressPrivate
	}
	for _, r := range c.Rules {
		if !r.Prefix.Contains(dst) {
			continue
		}
		if r.Proto != 0 && r.Proto != p.Protocol {
			continue
		}
		if p.DstPort < r.PortLo || p.DstPort > r.PortHi {
			continue
		}
		if r.Accept {
			return nil
		}
		return errEgressRule
	}
	return nil
}

// --- Conntrack for replies from a mesh exit ----------------------------------------

// A reply from the mesh exit arrives from the peer that holds the default route, with
// any source address. Only a packet answering a flow the client opened is let through
// to the client; anything else falls back to the paths that existed before exits, which
// drop it.

const (
	egressTCPTTL      = 5 * time.Minute
	egressUDPTTL      = 2 * time.Minute
	egressConntrackMx = 65536
)

type egressFlow struct {
	client, remote         netip.Addr
	clientPort, remotePort uint16
	proto                  uint8
}

type egressConntrack struct {
	mu    sync.Mutex
	flows map[egressFlow]int64
}

func newEgressConntrack() *egressConntrack {
	return &egressConntrack{flows: map[egressFlow]int64{}}
}

// record notes an outgoing packet of a client's flow, refreshing its expiry. A full
// table that has nothing expired refuses the new flow, and the packet is dropped.
func (ct *egressConntrack) record(p Packet, now time.Time) error {
	k := egressFlow{client: p.Src.Unmap(), remote: p.Dst.Unmap(), clientPort: p.SrcPort, remotePort: p.DstPort, proto: p.Protocol}
	ttl := egressUDPTTL
	if p.Protocol == ProtoTCP {
		ttl = egressTCPTTL
	}
	ct.mu.Lock()
	defer ct.mu.Unlock()
	if _, ok := ct.flows[k]; !ok && len(ct.flows) >= egressConntrackMx {
		n := now.UnixNano()
		for f, exp := range ct.flows {
			if exp < n {
				delete(ct.flows, f)
			}
		}
		if len(ct.flows) >= egressConntrackMx {
			return fmt.Errorf("dataplane: egress conntrack full (%d flows)", len(ct.flows))
		}
	}
	ct.flows[k] = now.Add(ttl).UnixNano()
	return nil
}

// isReply reports whether p answers a live flow a client opened.
func (ct *egressConntrack) isReply(p Packet, now time.Time) bool {
	k := egressFlow{client: p.Dst.Unmap(), remote: p.Src.Unmap(), clientPort: p.DstPort, remotePort: p.SrcPort, proto: p.Protocol}
	ct.mu.Lock()
	defer ct.mu.Unlock()
	exp, ok := ct.flows[k]
	return ok && exp >= now.UnixNano()
}

// SetEgress installs the node's exit clients. Nil or an empty table turns the exit
// path off: internet-bound packets then take the path they took before, which drops
// them. dnsUpstream is the resolver that answers ExitDNS for local clients; an invalid
// one leaves them without DNS.
//
// The userspace egress stack is built the first time a table has a local client, and
// kept until the device closes.
func (d *Device) SetEgress(t *EgressTable, dnsUpstream netip.AddrPort) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.closed {
		return ErrClosed
	}
	f := d.filter
	if t.Len() == 0 {
		f.egress.Store(nil)
		return nil
	}
	if t.HasLocal() && f.egressStack.Load() == nil {
		es, err := newEgressStack(d.mtu, dnsUpstream, f.enqueueOriginated)
		if err != nil {
			return fmt.Errorf("dataplane: userspace egress stack: %w", err)
		}
		f.egressStack.Store(es)
	}
	t.adoptConntrack(f.egress.Load())
	f.egress.Store(t)
	f.wakeIfDirect()
	return nil
}
