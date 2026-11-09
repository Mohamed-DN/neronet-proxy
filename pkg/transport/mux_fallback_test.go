package transport

import (
	"encoding/binary"
	"errors"
	"sync"
	"syscall"
	"testing"
	"time"

	"golang.zx2c4.com/wireguard/conn"
)

// fakeTransport records what it is asked to send, or refuses every send with err.
type fakeTransport struct {
	mu   sync.Mutex
	err  error
	sent int
}

func (f *fakeTransport) Open(uint16) ([]conn.ReceiveFunc, uint16, error) { return nil, 0, nil }
func (f *fakeTransport) Close() error                                    { return nil }
func (f *fakeTransport) SetMark(uint32) error                            { return nil }
func (f *fakeTransport) Send(bufs [][]byte, _ conn.Endpoint) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.err != nil {
		return f.err
	}
	f.sent += len(bufs)
	return nil
}

func (f *fakeTransport) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.sent
}

// wirePacket is a WireGuard message of the given type (anything but an initiation is
// sent through sendConcrete).
func wirePacket(typ uint32, size int) []byte {
	b := make([]byte, size)
	binary.LittleEndian.PutUint32(b, typ)
	return b
}

// Seen on the dedicated stack with UDP dropped in one node's namespace: after DERP was
// withdrawn and allowed again, SetPeers left the peers on their peer-level endpoint,
// and every data packet and handshake response to them went to the first path, UDP,
// whose local write failed (EPERM) on every try. DERP, allowed and homed, was never
// used, and those pairs stayed cut off for minutes.
func TestPeerLevelSendFallsBackWhenAPathFailsLocally(t *testing.T) {
	m := NewMux(Config{Relays: []Relay{{Region: "derp-a"}}}, []string{UDP, DERP})
	udp := &fakeTransport{err: syscall.EPERM}
	derp := &fakeTransport{}
	m.open[UDP] = udp
	m.open[DERP] = derp

	std := conn.NewStdNetBind()
	udpEP, err := std.ParseEndpoint("10.0.0.2:51820")
	if err != nil {
		t.Fatal(err)
	}
	derpEP, err := std.ParseEndpoint("10.0.0.3:8443")
	if err != nil {
		t.Fatal(err)
	}
	ps := &peerState{key: "peer", paths: []candidate{
		{tr: UDP, addr: udpEP.DstToString(), ep: udpEP},
		{tr: DERP, addr: derpEP.DstToString(), ep: derpEP},
	}}
	m.peers.byKey["peer"] = ps
	ep := newPeerLevel(ps)

	for name, pkt := range map[string][]byte{
		"data":               wirePacket(4, 64),
		"handshake response": wirePacket(msgResponse, sizeResponse),
	} {
		before := derp.count()
		if err := m.Send([][]byte{pkt}, ep); err != nil {
			t.Fatalf("%s: send failed although DERP is allowed and works: %v", name, err)
		}
		if derp.count() != before+1 {
			t.Fatalf("%s: not carried over DERP after the UDP write failed locally", name)
		}
	}

	// A concrete UDP endpoint with fresh authentication (no race) whose write fails
	// locally: the batch goes over the other allowed path instead of being lost.
	ps.mu.Lock()
	ps.lastAuthenticated = time.Now()
	ps.winner = UDP
	ps.mu.Unlock()
	concrete := newConcrete(UDP, udpEP)
	concrete.peer.Store(ps)
	before := derp.count()
	if err := m.Send([][]byte{wirePacket(4, 64)}, concrete); err != nil {
		t.Fatalf("concrete send failed although DERP carried it: %v", err)
	}
	if derp.count() != before+1 {
		t.Fatal("concrete UDP endpoint: batch lost although DERP is allowed and works")
	}

	// With every allowed path failing, the error is reported, never swallowed.
	derp.err = errors.New("relay down")
	if err := m.Send([][]byte{wirePacket(4, 64)}, ep); err == nil {
		t.Fatal("a send that failed on every path reported success")
	}
}

// Seen on the dedicated stack (a49f72a, UDP dropped at relay-de): right after the
// periodic PSK rotation every session re-handshakes at once. relay-de received each
// initiation over DERP, but its handshake response took the raced path -- the
// authentication was older than 2 s -- and was written to UDP only: the first
// candidate failed locally (EPERM) and the other paths were left to timers, or, with a
// race already running for that peer, not sent at all. client-de never got an answer.
// A raced send whose own path fails locally must reach the next path now, not later.
func TestRacedSendFallsBackAtOnceWhenAPathFailsLocally(t *testing.T) {
	for _, alreadyRacing := range []bool{false, true} {
		m := NewMux(Config{Relays: []Relay{{Region: "derp-a"}}}, []string{UDP, DERP}, WithStagger(time.Hour))
		udp := &fakeTransport{err: syscall.EPERM}
		derp := &fakeTransport{}
		m.open[UDP] = udp
		m.open[DERP] = derp
		std := conn.NewStdNetBind()
		udpEP, _ := std.ParseEndpoint("10.0.0.2:51820")
		derpEP, _ := std.ParseEndpoint("10.0.0.3:8443")
		ps := &peerState{key: "peer", paths: []candidate{
			{tr: UDP, addr: udpEP.DstToString(), ep: udpEP},
			{tr: DERP, addr: derpEP.DstToString(), ep: derpEP},
		}}
		ps.lastAuthenticated = time.Now().Add(-time.Minute) // stale: the send races
		ps.dataRacing = alreadyRacing
		m.peers.byKey["peer"] = ps
		concrete := newConcrete(UDP, udpEP)
		concrete.peer.Store(ps)

		if err := m.Send([][]byte{wirePacket(msgResponse, sizeResponse)}, concrete); err != nil {
			t.Fatalf("racing=%v: handshake response failed although DERP is allowed and works: %v", alreadyRacing, err)
		}
		if derp.count() != 1 {
			t.Fatalf("racing=%v: handshake response not carried over DERP at once after UDP failed locally (DERP sends: %d)", alreadyRacing, derp.count())
		}
	}
}
