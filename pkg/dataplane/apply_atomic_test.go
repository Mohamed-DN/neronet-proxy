package dataplane

import (
	"encoding/hex"
	"errors"
	"net/netip"
	"reflect"
	"strings"
	"testing"

	"github.com/sovereign/proxy/v4/pkg/crypto"
	"github.com/sovereign/proxy/v4/pkg/transport"
)

func muxNode(t *testing.T) (*Device, *transport.Mux) {
	t.Helper()
	keys, err := crypto.GenerateKeypair()
	if err != nil {
		t.Fatal(err)
	}
	mux := transport.NewMux(transport.Config{PrivateKey: keys.PrivateKey}, []string{transport.UDP})
	dev, err := New(Config{Mode: ModeNetstack, PrivateKey: keys.PrivateKey,
		Addresses: []netip.Prefix{netip.MustParsePrefix("100.64.0.1/10")}, TransportMux: mux})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = dev.Close() })
	return dev, mux
}

func meshPeer(t *testing.T, ip, address string) Peer {
	t.Helper()
	keys, err := crypto.GenerateKeypair()
	if err != nil {
		t.Fatal(err)
	}
	return Peer{
		PublicKey:  hex.EncodeToString(keys.PublicKey[:]),
		AllowedIPs: []netip.Prefix{netip.MustParsePrefix(ip)},
		Paths:      []transport.PathSpec{{Transport: transport.UDP, Address: address}},
	}
}

type muxView struct {
	paths map[string][]string
}

func viewOf(m *transport.Mux, peers ...Peer) muxView {
	v := muxView{paths: map[string][]string{}}
	for _, p := range peers {
		v.paths[p.PublicKey] = m.PeerPaths(p.PublicKey)
	}
	return v
}

// D15: when the device refuses the request, the transport mux must end up exactly as
// it was before Apply, or the data plane and the mux disagree about who the peers are.
func TestSetPeersFailureLeavesTheMuxAsItWas(t *testing.T) {
	dev, mux := muxNode(t)
	kept := meshPeer(t, "100.64.0.2/32", "127.0.0.1:41001")
	gone := meshPeer(t, "100.64.0.3/32", "127.0.0.1:41002")
	fresh := meshPeer(t, "100.64.0.4/32", "127.0.0.1:41003")
	if err := dev.SetPeers([]Peer{kept, gone}); err != nil {
		t.Fatal(err)
	}
	epoch := dev.counterEpoch
	before := viewOf(mux, kept, gone, fresh)

	boom := errors.New("uapi refused")
	dev.ipcSet = func(string) error { return boom }
	moved := kept
	moved.Paths = []transport.PathSpec{{Transport: transport.UDP, Address: "127.0.0.1:49999"}}
	err := dev.SetPeers([]Peer{moved, fresh}) // moves kept, drops gone, adds fresh
	if !errors.Is(err, boom) {
		t.Fatalf("SetPeers error = %v, want the device error", err)
	}

	if after := viewOf(mux, kept, gone, fresh); !reflect.DeepEqual(before, after) {
		t.Fatalf("mux changed by a failed SetPeers:\nbefore %v\nafter  %v", before, after)
	}
	if len(mux.PeerPaths(fresh.PublicKey)) != 0 {
		t.Fatal("the mux kept a peer the device never got")
	}
	if dev.counterEpoch <= epoch {
		t.Fatal("the counter epoch must still be invalidated by a failed apply")
	}
	if _, ok := dev.peerKeys[strings.ToLower(gone.PublicKey)]; !ok {
		t.Fatal("device peer set changed by a failed apply")
	}

	// And the same device still works once the fault is gone.
	dev.ipcSet = nil
	if err := dev.SetPeers([]Peer{moved, fresh}); err != nil {
		t.Fatalf("retry: %v", err)
	}
	if got := mux.PeerPaths(moved.PublicKey); len(got) != 1 || got[0] != "udp://127.0.0.1:49999" {
		t.Fatalf("retry paths = %v", got)
	}
	if len(mux.PeerPaths(gone.PublicKey)) != 0 {
		t.Fatal("retry left the removed peer in the mux")
	}
}
