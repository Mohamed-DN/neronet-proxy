package control

import (
	"encoding/binary"
	"errors"
	"fmt"
	"net"
	"sync"
)

var (
	ErrNoVIPAvailable = errors.New("overlay VIP pool exhausted")
)

// VIPAllocator manages dynamic overlay IPv4 and IPv6 assignment
type VIPAllocator struct {
	mu         sync.Mutex
	baseIPv4   uint32 // e.g. 100.64.0.1
	maxIPv4    uint32 // e.g. 100.127.255.254
	nextOffset uint32
	allocated  map[string]uint32 // nodeID -> ipv4 uint32
	ipv6Prefix string            // e.g. "fd7a:115c:a1e0"
}

// NewVIPAllocator creates a new allocator for 100.64.0.0/10.
//
// The returned allocator starts empty, which means it starts from the beginning of
// the pool. A process that restarts without replaying existing assignments through
// Restore will hand out addresses that are already in use -- and overlay_ipv4 and
// overlay_ipv6 are unique per node, so that is data corruption rather than a
// performance problem. It surfaces only on restart, which is exactly when a
// high-availability control plane is supposed to behave best.
//
// Callers must seed it: see Restore.
func NewVIPAllocator() *VIPAllocator {
	base := binary.BigEndian.Uint32(net.ParseIP("100.64.0.2").To4())
	max := binary.BigEndian.Uint32(net.ParseIP("100.127.255.254").To4())

	return &VIPAllocator{
		baseIPv4:   base,
		maxIPv4:    max,
		nextOffset: 0,
		allocated:  make(map[string]uint32),
		ipv6Prefix: "fd7a:115c:a1e0",
	}
}

// Restore records an assignment that already exists, so a restarted allocator does
// not hand the same address to somebody else.
//
// Call this for every known node before serving traffic. It also advances the
// cursor past the restored address, which is what stops the next Allocate from
// colliding with assignments made by a previous process.
func (a *VIPAllocator) Restore(nodeID string, ipv4 string) error {
	parsed := net.ParseIP(ipv4)
	if parsed == nil || parsed.To4() == nil {
		return fmt.Errorf("cannot restore %q: not an IPv4 address", ipv4)
	}

	ipInt := binary.BigEndian.Uint32(parsed.To4())
	if ipInt < a.baseIPv4 || ipInt > a.maxIPv4 {
		return fmt.Errorf("cannot restore %s: outside the overlay pool", ipv4)
	}

	a.mu.Lock()
	defer a.mu.Unlock()

	a.allocated[nodeID] = ipInt

	if offset := ipInt - a.baseIPv4 + 1; offset > a.nextOffset {
		a.nextOffset = offset
	}

	return nil
}

// isUsable rejects the network and broadcast addresses of each /24.
//
// The Node.js allocator skips them; this one did not. Two allocators disagreeing
// about which addresses exist is a collision waiting for the day both are running.
func isUsable(ipInt uint32) bool {
	last := byte(ipInt & 0xFF)
	return last != 0 && last != 255
}

// Allocate assigns a unique overlay IPv4 and IPv6 address to a node ID
func (a *VIPAllocator) Allocate(nodeID string) (ipv4 string, ipv6 string, err error) {
	a.mu.Lock()
	defer a.mu.Unlock()

	if existing, ok := a.allocated[nodeID]; ok {
		return uint32ToIP(existing).String(), fmt.Sprintf("%s::%x", a.ipv6Prefix, existing-a.baseIPv4+2), nil
	}

	for {
		if a.baseIPv4+a.nextOffset > a.maxIPv4 {
			return "", "", ErrNoVIPAvailable
		}

		ipInt := a.baseIPv4 + a.nextOffset
		a.nextOffset++

		if !isUsable(ipInt) {
			continue
		}

		a.allocated[nodeID] = ipInt

		return uint32ToIP(ipInt).String(), fmt.Sprintf("%s::%x", a.ipv6Prefix, ipInt-a.baseIPv4+2), nil
	}
}

// Release frees an allocated overlay IP
func (a *VIPAllocator) Release(nodeID string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	delete(a.allocated, nodeID)
}

func uint32ToIP(n uint32) net.IP {
	ip := make(net.IP, 4)
	binary.BigEndian.PutUint32(ip, n)
	return ip
}
