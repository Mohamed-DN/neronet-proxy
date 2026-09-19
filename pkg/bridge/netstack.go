package bridge

import (
	"context"
	"fmt"
	"io"
	"net"
	"strconv"
	"sync"
	"sync/atomic"
	"time"
)

// OverlayDialer opens connections inside the mesh overlay. The data plane device
// implements it; the bridge holds it as an interface so pkg/bridge does not depend
// on the WireGuard stack, and so a test can substitute a plain listener for it.
type OverlayDialer interface {
	DialContext(ctx context.Context, network, address string) (net.Conn, error)
}

// overlayPrefixes are the ranges the control plane allocates node addresses from.
// A destination inside them belongs to the mesh and has no meaning on the public
// internet, so dialling it directly can only ever reach the wrong host.
var overlayPrefixes = []*net.IPNet{
	mustParseCIDR("100.64.0.0/10"),
	mustParseCIDR("fd7a:115c:a1e0::/48"),
}

// IsOverlayIP reports whether an address belongs to the mesh overlay.
func IsOverlayIP(ip net.IP) bool {
	if ip == nil {
		return false
	}
	for _, p := range overlayPrefixes {
		if p.Contains(ip) {
			return true
		}
	}
	return false
}

// NetstackBridge coordinates userspace sandboxed outbound dialing and stream piping
type NetstackBridge struct {
	mu            sync.RWMutex
	policy        *SandboxPolicyEngine
	resolver      *DoHResolver
	guardian      *Guardian
	activeStreams int64
	bytesSent     uint64
	bytesRecv     uint64
	dialer        *net.Dialer

	overlay OverlayDialer
}

// NewNetstackBridge initializes a new sandboxed userspace bridge
func NewNetstackBridge(policy *SandboxPolicyEngine, resolver *DoHResolver, guardian *Guardian) *NetstackBridge {
	if policy == nil {
		policy = NewSandboxPolicyEngine(SandboxPolicyConfig{})
	}
	if resolver == nil {
		resolver = NewDoHResolver(nil)
	}
	if guardian == nil {
		guardian = NewGuardian(0)
	}

	return &NetstackBridge{
		policy:   policy,
		resolver: resolver,
		guardian: guardian,
		dialer: &net.Dialer{
			Timeout:   10 * time.Second,
			KeepAlive: 30 * time.Second,
		},
	}
}

// SetOverlayDialer attaches a mesh data plane to the bridge. Until one is set, a
// destination inside the overlay ranges is rejected by the sandbox as a bogon,
// which is what happens today: the assigned 100.64 addresses are unreachable.
//
// Passing nil detaches it and restores that behaviour.
func (b *NetstackBridge) SetOverlayDialer(d OverlayDialer) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.overlay = d
}

func (b *NetstackBridge) overlayDialer() OverlayDialer {
	b.mu.RLock()
	defer b.mu.RUnlock()
	return b.overlay
}

// DialAndPipe forwards traffic from an inbound client connection to a destination host:port
func (b *NetstackBridge) DialAndPipe(ctx context.Context, clientConn net.Conn, targetHost string, targetPort int) error {
	defer clientConn.Close()

	// 1. Guardian check
	if b.guardian.IsSuspended() {
		return ErrEgressNotPermitted
	}

	// 2. Resolve target IP via Anti-Leak DoH Resolver
	ips, err := b.resolver.ResolveIPs(ctx, targetHost)
	if err != nil {
		return fmt.Errorf("DNS resolution failed for %s: %w", targetHost, err)
	}

	if len(ips) == 0 {
		return fmt.Errorf("no IP addresses found for %s", targetHost)
	}

	targetIP := ips[0]
	targetAddr := net.JoinHostPort(targetIP.String(), strconv.Itoa(targetPort))

	var outboundConn net.Conn

	// 3. An overlay destination goes through the mesh, not out of the host.
	//
	// The sandbox is deliberately skipped for this path: its job is to keep egress
	// off private networks, and it lists 100.64.0.0/10 as a bogon precisely because
	// reaching that range over the host's interfaces would be a leak. Inside the
	// tunnel the same range is the mesh, and what a peer may reach there is decided
	// by the ACL filter on the packets, not by the egress sandbox.
	if overlay := b.overlayDialer(); overlay != nil && IsOverlayIP(targetIP) {
		conn, dialErr := overlay.DialContext(ctx, "tcp", targetAddr)
		if dialErr != nil {
			return fmt.Errorf("overlay dial to %s failed: %w", targetAddr, dialErr)
		}
		outboundConn = conn
	} else {
		// 4. Validate sandbox policy (Bogon IP, blocked ports, battery)
		batPct, onBat, _, _ := b.guardian.Status()
		if err := b.policy.ValidateEgress(targetIP, targetPort, batPct, onBat); err != nil {
			return err
		}

		// 5. Dial destination
		conn, dialErr := b.dialer.DialContext(ctx, "tcp", targetAddr)
		if dialErr != nil {
			return fmt.Errorf("outbound dial to %s failed: %w", targetAddr, dialErr)
		}
		outboundConn = conn
	}
	defer outboundConn.Close()

	atomic.AddInt64(&b.activeStreams, 1)
	defer atomic.AddInt64(&b.activeStreams, -1)

	// 6. Bidirectional copy
	errCh := make(chan error, 2)

	go func() {
		n, err := io.Copy(outboundConn, clientConn)
		atomic.AddUint64(&b.bytesSent, uint64(n))
		b.guardian.RecordTransfer(uint64(n))
		errCh <- err
	}()

	go func() {
		n, err := io.Copy(clientConn, outboundConn)
		atomic.AddUint64(&b.bytesRecv, uint64(n))
		b.guardian.RecordTransfer(uint64(n))
		errCh <- err
	}()

	// Wait for one stream direction to complete or error
	select {
	case <-errCh:
	case <-ctx.Done():
		return ctx.Err()
	}

	return nil
}

// Stats returns stream counts and byte metrics
func (b *NetstackBridge) Stats() (active int64, tx uint64, rx uint64) {
	return atomic.LoadInt64(&b.activeStreams), atomic.LoadUint64(&b.bytesSent), atomic.LoadUint64(&b.bytesRecv)
}
