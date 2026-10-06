package transport

import (
	"encoding/binary"
	"testing"

	"golang.zx2c4.com/wireguard/conn"
)

type trackingTimer struct{ stopped bool }

func (t *trackingTimer) Stop() bool { t.stopped = true; return true }

func TestUnauthenticatedWireAnswersDoNotConfirmPath(t *testing.T) {
	for _, typ := range []uint32{msgResponse, msgCookie} {
		t.Run(map[uint32]string{msgResponse: "response", msgCookie: "cookie"}[typ], func(t *testing.T) {
			m := NewMux(Config{}, []string{UDP, DERP})
			pendingTimer := &trackingTimer{}
			ps := &peerState{attempt: &attempt{index: 42, timers: []timer{pendingTimer}}}
			m.peers.pending[42] = ps
			inner, err := conn.NewStdNetBind().ParseEndpoint("127.0.0.1:51820")
			if err != nil {
				t.Fatal(err)
			}
			n := sizeResponse
			if typ == msgCookie {
				n = sizeCookie
			}
			bogus := make([]byte, n)
			binary.LittleEndian.PutUint32(bogus, typ)
			offset := 8
			if typ == msgCookie {
				offset = 4
			}
			binary.LittleEndian.PutUint32(bogus[offset:], 42)
			read := m.wrapReceive(UDP, func(p [][]byte, sizes []int, endpoints []conn.Endpoint) (int, error) {
				copy(p[0], bogus)
				sizes[0] = len(bogus)
				endpoints[0] = inner
				return 1, nil
			})
			_, err = read([][]byte{make([]byte, 2048)}, make([]int, 1), make([]conn.Endpoint, 1))
			if err != nil {
				t.Fatal(err)
			}
			if ps.attempt.answered || pendingTimer.stopped || ps.winner != "" {
				t.Fatal("fabricated wire header confirmed a path and cancelled alternatives before WireGuard authentication")
			}
		})
	}
}
