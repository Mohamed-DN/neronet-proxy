package transport

import (
	"encoding/binary"
	"encoding/hex"
	"errors"
	"testing"

	"golang.org/x/crypto/blake2s"
	"golang.zx2c4.com/wireguard/conn"
)

// ADR 0029 A4. A profile device has no declared path: it speaks first, from whatever
// network it is on. The gateway must answer it there, and only it: a mesh peer stays
// reachable only on its declared paths, and nothing but a handshake answer whose MAC1
// names a profile device may go to an address the Mux has not attributed.

var (
	devPub  = [32]byte{0xd1, 0xd2, 0xd3}
	meshPub = [32]byte{0xa1, 0xa2, 0xa3}
)

// handshakeTo is a handshake message of the given type whose MAC1 verifies for the
// recipient key, as wireguard-go writes it: BLAKE2s-128 keyed with
// HASH("mac1----" || recipient public key) over the bytes before the MAC1 field.
func handshakeTo(typ uint32, recipient [32]byte) []byte {
	size, macAt := sizeResponse, 60
	if typ == msgInitiation {
		size, macAt = sizeInitiation, initMAC1Offset
	}
	b := make([]byte, size)
	binary.LittleEndian.PutUint32(b, typ)
	for i := 4; i < macAt; i++ {
		b[i] = byte(i * 7)
	}
	key := mac1Key(recipient)
	h, _ := blake2s.New128(key[:])
	h.Write(b[:macAt])
	copy(b[macAt:], h.Sum(nil))
	return b
}

func gateway(t *testing.T) (*Mux, *fakeTransport) {
	t.Helper()
	m := NewMux(Config{}, []string{UDP})
	udp := &fakeTransport{}
	m.open[UDP] = udp
	if err := m.SetProfilePeer(hex.EncodeToString(devPub[:])); err != nil {
		t.Fatal(err)
	}
	// The mesh peer is built the way the other tests in this package build theirs:
	// SetPeerPaths needs the transports registered by the binary, which a package test
	// does not link.
	declared, _ := conn.NewStdNetBind().ParseEndpoint("10.0.0.2:51820")
	meshKey := hex.EncodeToString(meshPub[:])
	m.peers.byKey[meshKey] = &peerState{key: meshKey, pub: meshPub, mac1: mac1Key(meshPub),
		paths: []candidate{{tr: UDP, addr: declared.DstToString(), ep: declared}}}
	return m, udp
}

func unattributed(t *testing.T, addr string) *endpoint {
	t.Helper()
	ep, err := conn.NewStdNetBind().ParseEndpoint(addr)
	if err != nil {
		t.Fatal(err)
	}
	return newConcrete(UDP, ep)
}

func TestGatewayAnswersAProfileDeviceFromANewAddress(t *testing.T) {
	m, udp := gateway(t)
	ep := unattributed(t, "198.51.100.7:40001")
	if err := m.Send([][]byte{handshakeTo(msgResponse, devPub)}, ep); err != nil {
		t.Fatalf("the handshake response to the device was not sent: %v", err)
	}
	if udp.count() != 1 {
		t.Fatalf("UDP sends = %d, want 1", udp.count())
	}
	ps := m.incomingPeer(UDP, "198.51.100.7:40001")
	if ps == nil || ps.key != hex.EncodeToString(devPub[:]) {
		t.Fatal("the answered address is not bound to the device, so its next packet would be dropped")
	}
}

func TestMeshPeerIsNotAnsweredAtAnUndeclaredAddress(t *testing.T) {
	m, udp := gateway(t)
	ep := unattributed(t, "198.51.100.8:40002")
	err := m.Send([][]byte{handshakeTo(msgResponse, meshPub)}, ep)
	if !errors.Is(err, ErrNoPath) {
		t.Fatalf("send to a mesh peer at an undeclared address: err = %v, want ErrNoPath", err)
	}
	if udp.count() != 0 {
		t.Fatal("a mesh peer was answered at an address it never declared")
	}
	if m.incomingPeer(UDP, "198.51.100.8:40002") != nil {
		t.Fatal("an undeclared address was bound to a mesh peer")
	}
}

func TestDataToAnUnboundAddressIsDropped(t *testing.T) {
	m, udp := gateway(t)
	err := m.Send([][]byte{wirePacket(4, 64)}, unattributed(t, "198.51.100.9:40003"))
	if !errors.Is(err, ErrNoPath) || udp.count() != 0 {
		t.Fatalf("data to an unbound address: err = %v, sends = %d; want ErrNoPath and nothing sent", err, udp.count())
	}
}

func TestRoamingMovesTheBindingWithTheDevice(t *testing.T) {
	m, _ := gateway(t)
	if err := m.Send([][]byte{handshakeTo(msgResponse, devPub)}, unattributed(t, "198.51.100.7:40001")); err != nil {
		t.Fatal(err)
	}
	if err := m.Send([][]byte{handshakeTo(msgResponse, devPub)}, unattributed(t, "203.0.113.5:50000")); err != nil {
		t.Fatal(err)
	}
	if m.incomingPeer(UDP, "203.0.113.5:50000") == nil {
		t.Fatal("the device's new address is not bound")
	}
	if m.incomingPeer(UDP, "198.51.100.7:40001") != nil {
		t.Fatal("the device's old address is still bound after it moved")
	}
}

// receiveOne runs the Mux's receive wrapper over one packet from addr and reports
// whether the packet was delivered to wireguard-go.
func receiveOne(t *testing.T, m *Mux, pkt []byte, addr string) bool {
	t.Helper()
	ep, _ := conn.NewStdNetBind().ParseEndpoint(addr)
	fn := m.wrapReceive(UDP, func(packets [][]byte, sizes []int, eps []conn.Endpoint) (int, error) {
		copy(packets[0], pkt)
		sizes[0] = len(pkt)
		eps[0] = ep
		return 1, nil
	})
	packets := [][]byte{make([]byte, 2048)}
	sizes := []int{0}
	eps := []conn.Endpoint{nil}
	if _, err := fn(packets, sizes, eps); err != nil {
		t.Fatal(err)
	}
	return sizes[0] > 0
}

func TestUnattributedInitiationsReachWireGuardOnlyOnAGateway(t *testing.T) {
	plain := NewMux(Config{}, []string{UDP})
	plain.open[UDP] = &fakeTransport{}
	if receiveOne(t, plain, handshakeTo(msgInitiation, meshPub), "198.51.100.10:1") {
		t.Fatal("a node without profile devices delivered a packet from an undeclared address")
	}

	m, _ := gateway(t)
	if !receiveOne(t, m, handshakeTo(msgInitiation, devPub), "198.51.100.10:1") {
		t.Fatal("the gateway dropped an initiation from a new address; a profile device could never connect")
	}
	if receiveOne(t, m, wirePacket(4, 64), "198.51.100.11:1") {
		t.Fatal("the gateway delivered a data packet from an unbound address; only initiations may arrive unattributed")
	}
}
