package dataplane

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"math/rand"
	"net"
	"net/netip"
	"time"

	"golang.zx2c4.com/wireguard/tun"
	"golang.zx2c4.com/wireguard/tun/netstack"
)

// netstackBackend runs the IP stack in this process (gVisor). It needs no
// capabilities, no device node and no interface configuration, which is the whole
// reason the container nodes can use it.
type netstackBackend struct {
	dev  tun.Device
	tnet *netstack.Net
}

func newNetstackBackend(cfg Config) (*netstackBackend, error) {
	addrs := make([]netip.Addr, 0, len(cfg.Addresses))
	for _, p := range cfg.Addresses {
		addrs = append(addrs, p.Addr())
	}

	// No DNS servers: names inside the overlay are not resolved here. The node's
	// existing DoH resolver handles names, and passing a resolver this stack cannot
	// reach would turn every lookup into a timeout.
	dev, tnet, err := netstack.CreateNetTUN(addrs, nil, cfg.MTU)
	if err != nil {
		return nil, fmt.Errorf("dataplane: creating userspace stack: %w", err)
	}
	return &netstackBackend{dev: dev, tnet: tnet}, nil
}

func (b *netstackBackend) tunDevice() tun.Device { return b.dev }

func (b *netstackBackend) dialContext(ctx context.Context, network, address string) (net.Conn, error) {
	return b.tnet.DialContext(ctx, network, address)
}

func (b *netstackBackend) listen(network, address string) (net.Listener, error) {
	addrPort, err := netip.ParseAddrPort(address)
	if err != nil {
		return nil, fmt.Errorf("dataplane: listen address %q: %w", address, err)
	}
	switch network {
	case "tcp", "tcp4", "tcp6":
		return b.tnet.ListenTCPAddrPort(addrPort)
	default:
		return nil, fmt.Errorf("dataplane: listen network %q is not supported", network)
	}
}

func (b *netstackBackend) close() error {
	return b.dev.Close()
}

// icmpEchoRequest is the ICMPv4 type for an echo request; icmpEchoReply its answer.
const (
	icmpEchoRequest = 8
	icmpEchoReply   = 0

	icmpv6EchoRequest = 128
	icmpv6EchoReply   = 129
)

// ping sends one echo request and measures the round trip.
//
// The reply is matched on the identifier, sequence and payload rather than on
// arrival alone, because the ICMP endpoint is shared: another echo in flight would
// otherwise be counted as this one's answer and report a latency that was never
// measured.
func (b *netstackBackend) ping(ctx context.Context, dst netip.Addr) (time.Duration, error) {
	if !dst.IsValid() {
		return 0, errors.New("dataplane: ping needs a destination address")
	}

	pc, err := b.tnet.DialPingAddr(netip.Addr{}, dst)
	if err != nil {
		return 0, fmt.Errorf("dataplane: ping dial %s: %w", dst, err)
	}
	defer pc.Close()

	deadline, ok := ctx.Deadline()
	if !ok {
		deadline = time.Now().Add(5 * time.Second)
	}
	if err := pc.SetReadDeadline(deadline); err != nil {
		return 0, fmt.Errorf("dataplane: ping deadline: %w", err)
	}

	id := uint16(rand.Uint32())
	seq := uint16(rand.Uint32())
	payload := make([]byte, 16)
	binary.BigEndian.PutUint64(payload[:8], uint64(time.Now().UnixNano()))
	binary.BigEndian.PutUint16(payload[8:10], id)
	binary.BigEndian.PutUint16(payload[10:12], seq)

	requestType, replyType := byte(icmpEchoRequest), byte(icmpEchoReply)
	if dst.Is6() {
		requestType, replyType = icmpv6EchoRequest, icmpv6EchoReply
	}

	msg := buildICMPEcho(requestType, id, seq, payload)

	start := time.Now()
	if _, err := pc.Write(msg); err != nil {
		return 0, fmt.Errorf("dataplane: ping write to %s: %w", dst, err)
	}

	buf := make([]byte, 1500)
	for {
		n, err := pc.Read(buf)
		if err != nil {
			return 0, fmt.Errorf("dataplane: ping read from %s: %w", dst, err)
		}
		elapsed := time.Since(start)
		if n < 8+len(payload) {
			continue
		}
		reply := buf[:n]
		if reply[0] != replyType {
			continue
		}
		if binary.BigEndian.Uint16(reply[4:6]) != id || binary.BigEndian.Uint16(reply[6:8]) != seq {
			continue
		}
		if string(reply[8:8+len(payload)]) != string(payload) {
			continue
		}
		return elapsed, nil
	}
}

// buildICMPEcho assembles an echo message with its checksum. gVisor recomputes the
// checksum on send, but a message that is already correct is also the one the tests
// can check on its own.
func buildICMPEcho(msgType byte, id, seq uint16, payload []byte) []byte {
	msg := make([]byte, 8+len(payload))
	msg[0] = msgType
	msg[1] = 0
	binary.BigEndian.PutUint16(msg[4:6], id)
	binary.BigEndian.PutUint16(msg[6:8], seq)
	copy(msg[8:], payload)
	binary.BigEndian.PutUint16(msg[2:4], onesComplementChecksum(msg))
	return msg
}

func onesComplementChecksum(b []byte) uint16 {
	var sum uint32
	for i := 0; i+1 < len(b); i += 2 {
		sum += uint32(binary.BigEndian.Uint16(b[i : i+2]))
	}
	if len(b)%2 == 1 {
		sum += uint32(b[len(b)-1]) << 8
	}
	for sum>>16 != 0 {
		sum = (sum & 0xffff) + (sum >> 16)
	}
	return ^uint16(sum)
}
