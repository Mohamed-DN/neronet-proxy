package dataplane

import (
	"bufio"
	"context"
	"errors"
	"io"
	"net"
	"net/netip"
	"os"
	"strings"
	"sync"
	"time"

	"gvisor.dev/gvisor/pkg/buffer"
	"gvisor.dev/gvisor/pkg/tcpip"
	"gvisor.dev/gvisor/pkg/tcpip/adapters/gonet"
	"gvisor.dev/gvisor/pkg/tcpip/header"
	"gvisor.dev/gvisor/pkg/tcpip/link/channel"
	"gvisor.dev/gvisor/pkg/tcpip/network/ipv4"
	"gvisor.dev/gvisor/pkg/tcpip/network/ipv6"
	"gvisor.dev/gvisor/pkg/tcpip/stack"
	"gvisor.dev/gvisor/pkg/tcpip/transport/tcp"
	"gvisor.dev/gvisor/pkg/tcpip/transport/udp"
	"gvisor.dev/gvisor/pkg/waiter"
)

// egressStack is the userspace exit: a gVisor stack of its own, separate from the one
// wireguard-go's netstack keeps unexported, that accepts any destination (promiscuous)
// and answers from any source (spoofing). A client's TCP connection or UDP flow ends in
// it, and a forwarder opens the matching socket on the host and copies both ways.
//
// Every packet that reaches inject has already passed EgressClient.Decide, so the
// forwarders dial what they are handed; the one rewrite is ExitDNS:53, which goes to
// this host's resolver instead.
type egressStack struct {
	s   *stack.Stack
	ep  *channel.Endpoint
	out func([]byte) bool

	dnsUpstream netip.AddrPort
	dial        func(ctx context.Context, network, address string) (net.Conn, error)

	closeOnce sync.Once
}

const (
	egressNIC         tcpip.NICID = 1
	egressDialTimeout             = 10 * time.Second
	egressUDPIdle                 = 60 * time.Second
	egressDNSIdle                 = 10 * time.Second
	egressMaxInFlight             = 1024
)

// newEgressStack builds the exit stack. out hands a packet the stack sends (a reply
// to a client) back towards wireguard-go and reports whether it was queued.
func newEgressStack(mtu int, dnsUpstream netip.AddrPort, out func([]byte) bool) (*egressStack, error) {
	s := stack.New(stack.Options{
		NetworkProtocols:   []stack.NetworkProtocolFactory{ipv4.NewProtocol, ipv6.NewProtocol},
		TransportProtocols: []stack.TransportProtocolFactory{tcp.NewProtocol, udp.NewProtocol},
	})
	sack := tcpip.TCPSACKEnabled(true)
	if err := s.SetTransportProtocolOption(tcp.ProtocolNumber, &sack); err != nil {
		return nil, errors.New(err.String())
	}
	ep := channel.New(1024, uint32(mtu), "")
	if err := s.CreateNIC(egressNIC, ep); err != nil {
		return nil, errors.New(err.String())
	}
	if err := s.SetPromiscuousMode(egressNIC, true); err != nil {
		return nil, errors.New(err.String())
	}
	if err := s.SetSpoofing(egressNIC, true); err != nil {
		return nil, errors.New(err.String())
	}
	s.SetRouteTable([]tcpip.Route{
		{Destination: header.IPv4EmptySubnet, NIC: egressNIC},
		{Destination: header.IPv6EmptySubnet, NIC: egressNIC},
	})
	e := &egressStack{
		s:           s,
		ep:          ep,
		out:         out,
		dnsUpstream: dnsUpstream,
		dial:        (&net.Dialer{Timeout: egressDialTimeout}).DialContext,
	}
	ep.AddNotify(e)
	tcpFwd := tcp.NewForwarder(s, 0, egressMaxInFlight, e.handleTCP)
	s.SetTransportProtocolHandler(tcp.ProtocolNumber, tcpFwd.HandlePacket)
	udpFwd := udp.NewForwarder(s, e.handleUDP)
	s.SetTransportProtocolHandler(udp.ProtocolNumber, udpFwd.HandlePacket)
	return e, nil
}

// WriteNotify drains what the stack sent. It runs on the stack's send path, so out
// must not block: a full queue drops, as a router's output queue does.
func (e *egressStack) WriteNotify() {
	for {
		pkt := e.ep.Read()
		if pkt == nil {
			return
		}
		view := pkt.ToView()
		pkt.DecRef()
		e.out(view.AsSlice())
		view.Release()
	}
}

// inject hands the stack one packet a client sent. The bytes are copied: the caller's
// buffer belongs to wireguard-go.
func (e *egressStack) inject(raw []byte) {
	pkb := stack.NewPacketBuffer(stack.PacketBufferOptions{Payload: buffer.MakeWithData(append([]byte(nil), raw...))})
	defer pkb.DecRef()
	switch raw[0] >> 4 {
	case 4:
		e.ep.InjectInbound(header.IPv4ProtocolNumber, pkb)
	case 6:
		e.ep.InjectInbound(header.IPv6ProtocolNumber, pkb)
	}
}

func (e *egressStack) close() {
	e.closeOnce.Do(func() {
		e.s.Close()
		e.ep.Close()
	})
}

// target is where the host socket for a client flow goes.
func (e *egressStack) target(id stack.TransportEndpointID) (netip.AddrPort, bool) {
	dst, ok := netip.AddrFromSlice(id.LocalAddress.AsSlice())
	if !ok {
		return netip.AddrPort{}, false
	}
	dst = dst.Unmap()
	if dst == ExitDNS {
		if id.LocalPort != 53 || !e.dnsUpstream.IsValid() {
			return netip.AddrPort{}, false
		}
		return e.dnsUpstream, true
	}
	return netip.AddrPortFrom(dst, id.LocalPort), true
}

func (e *egressStack) handleTCP(r *tcp.ForwarderRequest) {
	id := r.ID()
	dst, ok := e.target(id)
	if !ok {
		r.Complete(true)
		return
	}
	// Dial first: a destination that refuses or does not answer is answered with a
	// reset, as it would be on a direct connection, instead of an accepted connection
	// that then closes.
	ctx, cancel := context.WithTimeout(context.Background(), egressDialTimeout)
	host, err := e.dial(ctx, "tcp", dst.String())
	cancel()
	if err != nil {
		r.Complete(true)
		return
	}
	var wq waiter.Queue
	ep, tcpErr := r.CreateEndpoint(&wq)
	if tcpErr != nil {
		r.Complete(true)
		_ = host.Close()
		return
	}
	r.Complete(false)
	client := gonet.NewTCPConn(&wq, ep)
	go pipeTCP(client, host)
}

// pipeTCP copies both ways and half-closes each side when the other finishes sending.
func pipeTCP(client *gonet.TCPConn, host net.Conn) {
	done := make(chan struct{}, 2)
	go func() {
		_, _ = io.Copy(host, client)
		if hc, ok := host.(interface{ CloseWrite() error }); ok {
			_ = hc.CloseWrite()
		}
		done <- struct{}{}
	}()
	go func() {
		_, _ = io.Copy(client, host)
		_ = client.CloseWrite()
		done <- struct{}{}
	}()
	<-done
	<-done
	_ = client.Close()
	_ = host.Close()
}

func (e *egressStack) handleUDP(r *udp.ForwarderRequest) bool {
	id := r.ID()
	dst, ok := e.target(id)
	if !ok {
		return false
	}
	var wq waiter.Queue
	ep, err := r.CreateEndpoint(&wq)
	if err != nil {
		return false
	}
	client := gonet.NewUDPConn(&wq, ep)
	idle := egressUDPIdle
	if dst == e.dnsUpstream {
		idle = egressDNSIdle
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), egressDialTimeout)
		host, dialErr := e.dial(ctx, "udp", dst.String())
		cancel()
		if dialErr != nil {
			_ = client.Close()
			return
		}
		pipeUDP(client, host, idle)
	}()
	return true
}

// pipeUDP relays datagrams both ways until neither side has sent anything for idle.
func pipeUDP(client *gonet.UDPConn, host net.Conn, idle time.Duration) {
	var once sync.Once
	stop := func() {
		once.Do(func() {
			_ = client.Close()
			_ = host.Close()
		})
	}
	defer stop()
	go func() {
		defer stop()
		buf := make([]byte, 65535)
		for {
			_ = host.SetReadDeadline(time.Now().Add(idle))
			n, err := host.Read(buf)
			if err != nil {
				return
			}
			if _, err := client.Write(buf[:n]); err != nil {
				return
			}
		}
	}()
	buf := make([]byte, 65535)
	for {
		_ = client.SetReadDeadline(time.Now().Add(idle))
		n, err := client.Read(buf)
		if err != nil {
			return
		}
		if _, err := host.Write(buf[:n]); err != nil {
			return
		}
	}
}

// SystemResolver is the first nameserver of /etc/resolv.conf, port 53: the resolver
// the exit host itself uses, which answers ExitDNS. It reports false when there is
// none, and then a full-tunnel client of this exit has no DNS.
func SystemResolver() (netip.AddrPort, bool) {
	return resolverFrom("/etc/resolv.conf")
}

func resolverFrom(path string) (netip.AddrPort, bool) {
	f, err := os.Open(path)
	if err != nil {
		return netip.AddrPort{}, false
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		fields := strings.Fields(sc.Text())
		if len(fields) < 2 || fields[0] != "nameserver" {
			continue
		}
		addr, err := netip.ParseAddr(strings.SplitN(fields[1], "%", 2)[0])
		if err != nil {
			continue
		}
		return netip.AddrPortFrom(addr.Unmap(), 53), true
	}
	return netip.AddrPort{}, false
}
