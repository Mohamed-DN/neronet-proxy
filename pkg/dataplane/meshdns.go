package dataplane

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net/netip"
	"time"

	"gvisor.dev/gvisor/pkg/tcpip/adapters/gonet"
	"gvisor.dev/gvisor/pkg/tcpip/stack"
	"gvisor.dev/gvisor/pkg/tcpip/transport/tcp"
	"gvisor.dev/gvisor/pkg/tcpip/transport/udp"
	"gvisor.dev/gvisor/pkg/waiter"
)

// Mesh names for profile devices (ADR 0034).
//
// A stock WireGuard app has no resolver of its own for mesh names, so the gateway
// answers them at ExitDNS (100.100.100.100), port 53, UDP and TCP, for every profile
// device it serves, exit or not. The address lives only in the gateway's userspace
// stack (egress_stack.go): a packet reaches it after wireguard-go authenticated the
// sending device, and nothing listens on the host's network.
//
// What a query meets, in order:
//
//   - MeshDNS.Answer decides first, for every profile device. A mesh name is answered
//     from the netmap and an unknown mesh name is NXDOMAIN; neither is ever forwarded.
//   - anything else from a device without an exit goes to MeshDNS.Upstream.
//   - anything else from a device with an exit goes to the exit's resolver (ADR 0032),
//     never to MeshDNS.Upstream: a device that chose an exit must not resolve around it.
//     For an exit on this host that is the resolver SetEgress was given (SERVFAIL if
//     none). For a mesh exit the gateway cannot ask that resolver itself, so it answers
//     mesh names only for UDP queries, which it can read before relaying; those it
//     does not answer, and every TCP query, are relayed to the exit unchanged.
//
// With no MeshDNS installed a non-exit device's packet to ExitDNS meets the forwarding
// policy as any other packet and is dropped, which is what happened before.

// MeshDNS is the resolver a gateway installs with SetMeshDNS.
type MeshDNS struct {
	// Answer evaluates one packed query. reply is nil for bytes that are not a query to
	// answer. forward true says the name is not the mesh's and reply is only the
	// fallback if the query cannot be relayed.
	Answer func(query []byte) (reply []byte, forward bool)
	// Upstream is the resolver for names outside the mesh. Invalid means none: the
	// device then gets SERVFAIL for them.
	Upstream netip.AddrPort
}

const (
	meshDNSMaxInFlight = 256
	meshDNSIdle        = 10 * time.Second
	meshDNSUpstreamTO  = 3 * time.Second
	meshDNSMaxMessage  = 65535
)

// SetMeshDNS installs, replaces or (with nil) removes the mesh resolver. It builds the
// userspace stack the first time one is installed.
func (d *Device) SetMeshDNS(m *MeshDNS) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.closed {
		return ErrClosed
	}
	f := d.filter
	if m == nil {
		f.meshDNS.Store(nil)
		if es := f.egressStack.Load(); es != nil {
			es.mesh.Store(nil)
		}
		return nil
	}
	if m.Answer == nil {
		return errors.New("dataplane: MeshDNS without an Answer function")
	}
	es := f.egressStack.Load()
	if es == nil {
		var err error
		es, err = newEgressStack(d.mtu, netip.AddrPort{}, f.enqueueOriginated)
		if err != nil {
			return fmt.Errorf("dataplane: userspace stack for mesh names: %w", err)
		}
		es.exitClient = f.exitVia
		f.egressStack.Store(es)
	}
	es.mesh.Store(m)
	f.meshDNS.Store(m)
	f.wakeIfDirect()
	return nil
}

// exitVia reports whether a client address has an exit selected, and which kind.
func (f *filteredTUN) exitVia(a netip.Addr) (EgressVia, bool) {
	t := f.egress.Load()
	if t == nil {
		return EgressNone, false
	}
	c, ok := t.Client(a)
	if !ok {
		return EgressNone, false
	}
	return c.Via, true
}

// meshDNSWrite takes a decrypted packet to ExitDNS:53 from a profile device and hands it
// to the stack. It reports whether it took the packet.
func (f *filteredTUN) meshDNSWrite(raw []byte, pkt Packet) bool {
	if pkt.Dst.Unmap() != ExitDNS || pkt.DstPort != 53 || pkt.Fragment {
		return false
	}
	if pkt.Protocol != ProtoTCP && pkt.Protocol != ProtoUDP {
		return false
	}
	ft := f.forward.Load()
	if ft == nil {
		return false
	}
	src := pkt.Src.Unmap()
	if _, profile := ft.devices[src]; !profile {
		return false
	}
	es := f.egressStack.Load()
	if es == nil {
		return false
	}
	if t := f.egress.Load(); t != nil {
		if c, ok := t.Client(src); ok {
			return f.meshDNSExitWrite(raw, pkt, c, es)
		}
	}
	es.inject(raw)
	return true
}

// meshDNSExitWrite is meshDNSWrite for a device that has an exit. It takes the packet
// only when the mesh resolver may answer it; otherwise the exit path handles it as it
// always did.
func (f *filteredTUN) meshDNSExitWrite(raw []byte, pkt Packet, c *EgressClient, es *egressStack) bool {
	if c.Decide(pkt) != nil {
		return false // the exit path drops it and counts the drop
	}
	switch c.Via {
	case EgressLocal:
		es.inject(raw)
		f.egressed.Add(1)
		return true
	case EgressMesh:
		m := es.mesh.Load()
		if m == nil || pkt.Protocol != ProtoUDP || pkt.Version != 4 {
			return false
		}
		query := udpPayloadV4(raw)
		if query == nil {
			return false
		}
		if reply, forward := m.Answer(query); reply != nil && !forward {
			es.inject(raw)
			return true
		}
	}
	return false
}

// udpPayloadV4 returns the UDP payload of an IPv4 packet that ParsePacket accepted, or nil.
func udpPayloadV4(raw []byte) []byte {
	if len(raw) < 28 {
		return nil
	}
	ihl := int(raw[0]&0x0f) * 4
	total := int(binary.BigEndian.Uint16(raw[2:4]))
	if ihl < 20 || total > len(raw) || ihl+8 > total {
		return nil
	}
	return raw[ihl+8 : total]
}

// isMeshDNS reports whether a flow that reached the stack is a mesh name query.
func (e *egressStack) isMeshDNS(id stack.TransportEndpointID) bool {
	if e.mesh.Load() == nil || id.LocalPort != 53 {
		return false
	}
	dst, ok := netip.AddrFromSlice(id.LocalAddress.AsSlice())
	if !ok || dst.Unmap() != ExitDNS {
		return false
	}
	return true
}

// exitOf says whether the flow's source has an exit, and which kind.
func (e *egressStack) exitOf(id stack.TransportEndpointID) (EgressVia, bool) {
	if e.exitClient == nil {
		return EgressNone, false
	}
	src, ok := netip.AddrFromSlice(id.RemoteAddress.AsSlice())
	if !ok {
		return EgressNone, false
	}
	return e.exitClient(src.Unmap())
}

func (e *egressStack) serveMeshUDP(r *udp.ForwarderRequest) bool {
	via, viaExit := e.exitOf(r.ID())
	var wq waiter.Queue
	ep, err := r.CreateEndpoint(&wq)
	if err != nil {
		return false
	}
	client := gonet.NewUDPConn(&wq, ep)
	go func() {
		defer client.Close()
		buf := make([]byte, meshDNSMaxMessage)
		for {
			_ = client.SetReadDeadline(time.Now().Add(meshDNSIdle))
			n, err := client.Read(buf)
			if err != nil {
				return
			}
			query := append([]byte(nil), buf[:n]...)
			select {
			case e.meshSlots <- struct{}{}:
			default:
				continue // overloaded: a stub resolver retries
			}
			go func() {
				defer func() { <-e.meshSlots }()
				if reply := e.meshReply(query, false, via, viaExit); reply != nil {
					_, _ = client.Write(reply)
				}
			}()
		}
	}()
	return true
}

func (e *egressStack) serveMeshTCP(r *tcp.ForwarderRequest) {
	via, viaExit := e.exitOf(r.ID())
	var wq waiter.Queue
	ep, tcpErr := r.CreateEndpoint(&wq)
	if tcpErr != nil {
		r.Complete(true)
		return
	}
	r.Complete(false)
	conn := gonet.NewTCPConn(&wq, ep)
	go func() {
		defer conn.Close()
		var lenBuf [2]byte
		for {
			_ = conn.SetReadDeadline(time.Now().Add(meshDNSIdle))
			if _, err := io.ReadFull(conn, lenBuf[:]); err != nil {
				return
			}
			query := make([]byte, binary.BigEndian.Uint16(lenBuf[:]))
			if _, err := io.ReadFull(conn, query); err != nil {
				return
			}
			select {
			case e.meshSlots <- struct{}{}:
			default:
				return
			}
			reply := e.meshReply(query, true, via, viaExit)
			<-e.meshSlots
			if reply == nil {
				continue
			}
			out := make([]byte, 2+len(reply))
			binary.BigEndian.PutUint16(out, uint16(len(reply)))
			copy(out[2:], reply)
			if _, err := conn.Write(out); err != nil {
				return
			}
		}
	}()
}

// meshReply answers one query: from the netmap, or for a name outside the mesh from the
// upstream resolver, or, for a device that has an exit, from the exit's. It returns nil
// when there is nothing to send.
func (e *egressStack) meshReply(query []byte, overTCP bool, via EgressVia, viaExit bool) []byte {
	m := e.mesh.Load()
	if m == nil {
		return nil
	}
	reply, forward := m.Answer(query)
	if reply == nil || !forward {
		return reply
	}
	upstream := m.Upstream
	if viaExit {
		// Never the gateway's own resolver: the device chose to resolve where it exits.
		upstream = netip.AddrPort{}
		if via == EgressLocal {
			upstream = e.upstream()
		}
	}
	if !upstream.IsValid() {
		return servfail(query)
	}
	network := "udp"
	if overTCP {
		network = "tcp"
	}
	answer, err := e.relay(network, upstream, query)
	if err != nil {
		return servfail(query)
	}
	return answer
}

// relay sends one query to the upstream resolver and returns its answer.
func (e *egressStack) relay(network string, up netip.AddrPort, query []byte) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), meshDNSUpstreamTO)
	defer cancel()
	c, err := e.dial(ctx, network, up.String())
	if err != nil {
		return nil, err
	}
	defer c.Close()
	_ = c.SetDeadline(time.Now().Add(meshDNSUpstreamTO))
	if network == "tcp" {
		out := make([]byte, 2+len(query))
		binary.BigEndian.PutUint16(out, uint16(len(query)))
		copy(out[2:], query)
		if _, err := c.Write(out); err != nil {
			return nil, err
		}
		var lenBuf [2]byte
		if _, err := io.ReadFull(c, lenBuf[:]); err != nil {
			return nil, err
		}
		reply := make([]byte, binary.BigEndian.Uint16(lenBuf[:]))
		if _, err := io.ReadFull(c, reply); err != nil {
			return nil, err
		}
		return reply, nil
	}
	if _, err := c.Write(query); err != nil {
		return nil, err
	}
	buf := make([]byte, meshDNSMaxMessage)
	n, err := c.Read(buf)
	if err != nil {
		return nil, err
	}
	return buf[:n], nil
}

// servfail turns a query into a SERVFAIL answer, or nil if it has no header.
func servfail(query []byte) []byte {
	if len(query) < 12 {
		return nil
	}
	out := append([]byte(nil), query...)
	out[2] = 0x80 | (query[2] & 0x79) // QR=1, keep opcode and RD
	out[3] = 0x80 | 2                 // RA, RCODE 2
	for i := 6; i < 12; i++ {
		out[i] = 0 // no answer, authority or additional records
	}
	return out
}
