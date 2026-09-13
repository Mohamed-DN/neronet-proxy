package control

import (
	"net"
	"testing"
)

// A VIPAllocator keeps its cursor in memory. Nothing persists it, so a restarted
// process starts at the beginning of the pool and hands out addresses that are
// already assigned. overlay_ipv4 and overlay_ipv6 are unique per node, so that is
// data corruption, and it surfaces only on restart -- exactly when a
// high-availability control plane is meant to behave best.
func TestRestartReassignsWithoutRestore(t *testing.T) {
	first := NewVIPAllocator()

	assigned := make(map[string]string)
	for _, node := range []string{"node-a", "node-b", "node-c"} {
		ipv4, _, err := first.Allocate(node)
		if err != nil {
			t.Fatalf("Allocate(%s): %v", node, err)
		}
		assigned[node] = ipv4
	}

	// The process restarts. Nothing was persisted.
	restarted := NewVIPAllocator()

	fresh, _, err := restarted.Allocate("node-d")
	if err != nil {
		t.Fatalf("Allocate after restart: %v", err)
	}

	// This is the defect, asserted so it stays visible: a brand new allocator will
	// reissue the first address unless the caller replays what already exists.
	if fresh != assigned["node-a"] {
		t.Fatalf("expected the unseeded allocator to reissue %s, got %s -- if this changed, update the comment above",
			assigned["node-a"], fresh)
	}
}

func TestRestoreStopsReassignment(t *testing.T) {
	first := NewVIPAllocator()

	assigned := make(map[string]string)
	for _, node := range []string{"node-a", "node-b", "node-c"} {
		ipv4, _, err := first.Allocate(node)
		if err != nil {
			t.Fatalf("Allocate(%s): %v", node, err)
		}
		assigned[node] = ipv4
	}

	restarted := NewVIPAllocator()
	for node, ipv4 := range assigned {
		if err := restarted.Restore(node, ipv4); err != nil {
			t.Fatalf("Restore(%s, %s): %v", node, ipv4, err)
		}
	}

	fresh, _, err := restarted.Allocate("node-d")
	if err != nil {
		t.Fatalf("Allocate after restore: %v", err)
	}

	for node, ipv4 := range assigned {
		if fresh == ipv4 {
			t.Fatalf("new node was given %s, already held by %s", fresh, node)
		}
	}

	// A restored node must keep the address it already had, not be given a new one.
	again, _, err := restarted.Allocate("node-b")
	if err != nil {
		t.Fatalf("Allocate for a restored node: %v", err)
	}
	if again != assigned["node-b"] {
		t.Fatalf("restored node-b was moved from %s to %s", assigned["node-b"], again)
	}
}

func TestRestoreRejectsAddressesOutsideThePool(t *testing.T) {
	a := NewVIPAllocator()

	for _, bad := range []string{"192.168.1.1", "not-an-ip", "8.8.8.8", "2001:db8::1"} {
		if err := a.Restore("node", bad); err == nil {
			t.Fatalf("Restore accepted %q, which is not an overlay address", bad)
		}
	}
}

// The Node.js allocator skips the network and broadcast address of each /24. This one
// did not, so the two disagreed about which addresses exist -- a collision waiting
// for the day both are running.
func TestAllocateSkipsNetworkAndBroadcastAddresses(t *testing.T) {
	a := NewVIPAllocator()

	for i := 0; i < 600; i++ {
		ipv4, _, err := a.Allocate(string(rune(i)) + "-node")
		if err != nil {
			t.Fatalf("Allocate: %v", err)
		}

		parsed := net.ParseIP(ipv4).To4()
		if parsed == nil {
			t.Fatalf("Allocate returned %q, which is not an IPv4 address", ipv4)
		}

		if last := parsed[3]; last == 0 || last == 255 {
			t.Fatalf("allocated %s, which is a network or broadcast address", ipv4)
		}
	}
}
