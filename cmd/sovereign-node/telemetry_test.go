package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/sovereign/proxy/v4/pkg/control"
	"github.com/sovereign/proxy/v4/pkg/dataplane"
)

func TestNativeTelemetryReadsRealWireGuardTrafficAndPeerIncarnations(t *testing.T) {
	a := newOverlayNode(t, "100.64.88.1/10")
	b := newOverlayNode(t, "100.64.88.2/10")
	ma, mb := managerFor(t, a), managerFor(t, b)
	apply := func(version uint64, peers ...control.NetmapPeer) {
		t.Helper()
		if err := ma.Apply(netmapFor(version, a.addr, allowAllPolicy("a", a.addr, b.addr), peers...), time.Now()); err != nil {
			t.Fatal(err)
		}
	}
	apply(1, b.peerEntry("b"))
	if err := mb.Apply(netmapFor(1, b.addr, allowAllPolicy("b", b.addr, a.addr), a.peerEntry("a")), time.Now()); err != nil {
		t.Fatal(err)
	}
	echo, err := dataplane.ListenEcho(b.dev, echoPort, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer echo.Close()
	holder := &netmapHolder{}
	holder.set(ma)
	sampler := newTelemetrySampler(holder)
	initial, err := sampler.snapshot()
	if err != nil || !initial.TrafficAvailable {
		t.Fatalf("initial: %+v %v", initial, err)
	}
	if err := echoOnce(t, a, b.addr, echoPort, 15*time.Second); err != nil {
		t.Fatal(err)
	}
	observed, err := sampler.snapshot()
	if err != nil {
		t.Fatal(err)
	}
	if observed.RxBytes == "0" || observed.TxBytes == "0" || observed.MemoryRuntimeSysBytes == "0" {
		t.Fatalf("missing real measurements: %+v", observed)
	}
	if observed.CounterEpoch != initial.CounterEpoch {
		t.Fatal("traffic alone changed the counter epoch")
	}
	apply(2, b.peerEntry("b"))
	unchanged, err := sampler.snapshot()
	if err != nil || unchanged.CounterEpoch != observed.CounterEpoch {
		t.Fatalf("unchanged peer reconfiguration reset counters: %+v %v", unchanged, err)
	}
	// Remove and re-add without sampling in between. A simple smaller-counter check
	// misses this reset once new traffic has already exceeded the old counter.
	apply(3)
	apply(4, b.peerEntry("b"))
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	conn, err := a.dev.DialContext(ctx, "tcp", net.JoinHostPort(b.addr.String(), fmt.Sprint(echoPort)))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(15 * time.Second))
	payload := bytes.Repeat([]byte("native-telemetry!"), 4096)
	if _, err := conn.Write(append([]byte{dataplane.ModeByteEcho}, payload...)); err != nil {
		t.Fatal(err)
	}
	got := make([]byte, len(payload))
	if _, err := io.ReadFull(conn, got); err != nil || !bytes.Equal(got, payload) {
		t.Fatalf("real echo: %v", err)
	}
	after, err := sampler.snapshot()
	if err != nil || after.CounterEpoch == observed.CounterEpoch {
		t.Fatalf("peer incarnation reset missed: %+v %v", after, err)
	}
	var beforeRX, afterRX uint64
	_, _ = fmt.Sscan(observed.RxBytes, &beforeRX)
	_, _ = fmt.Sscan(after.RxBytes, &afterRX)
	if afterRX <= beforeRX {
		t.Fatalf("test did not regrow the reset counter: before=%d after=%d", beforeRX, afterRX)
	}
}

func TestNativeTelemetryAvailabilityAndObservedIndividualReset(t *testing.T) {
	peers := []dataplane.PeerStatus{{PublicKey: "a", RxBytes: 100, TxBytes: 200}, {PublicKey: "b", RxBytes: 100, TxBytes: 200}}
	var unavailable bool
	sampler := &telemetrySampler{epoch: 1, read: func() ([]dataplane.PeerStatus, uint64, error) {
		if unavailable {
			return nil, 0, errors.New("not ready")
		}
		return peers, 1, nil
	}}
	first, err := sampler.snapshot()
	if err != nil {
		t.Fatal(err)
	}
	peers[0].RxBytes = 1
	peers[1].RxBytes = 1000
	reset, err := sampler.snapshot()
	if err != nil || reset.CounterEpoch == first.CounterEpoch {
		t.Fatalf("individual reset concealed by total: %+v %v", reset, err)
	}
	unavailable = true
	missing, err := sampler.snapshot()
	if err != nil || missing.TrafficAvailable || missing.RxBytes != "" || missing.TxBytes != "" || missing.MemoryRuntimeSysBytes == "" {
		t.Fatalf("unavailable: %+v %v", missing, err)
	}
	unavailable = false
	recovered, err := sampler.snapshot()
	if err != nil || recovered.CounterEpoch == missing.CounterEpoch {
		t.Fatalf("recovery reused invalid baseline: %+v %v", recovered, err)
	}
}

func TestNativeTelemetryHeartbeatUsesRegisteredSessionAndExactStrings(t *testing.T) {
	for _, supported := range []bool{false, true} {
		t.Run(fmt.Sprint(supported), func(t *testing.T) {
			received := make(chan *control.NativeTelemetry, 3)
			registrations := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/v4/control/challenge":
					_, _ = fmt.Fprintf(w, `{"nonce":"%s","cp_public_key":"%s"}`, strings.Repeat("ab", 32), strings.Repeat("09", 32))
				case "/v4/control/register":
					registrations++
					response := map[string]any{"assigned_node_id": "a", "overlay_ipv4": "100.64.88.1"}
					if supported {
						response["telemetry_session"] = fmt.Sprintf("00000000-0000-4000-8000-%012d", registrations)
					}
					_ = json.NewEncoder(w).Encode(response)
				case "/v4/control/heartbeat":
					var body control.HeartbeatRequest
					if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
						t.Error(err)
					}
					received <- body.Telemetry
					_, _ = w.Write([]byte(`{"acknowledged":true}`))
				}
			}))
			defer server.Close()
			node := newOverlayNode(t, "100.64.88.3/10")
			client := control.NewClient(server.URL)
			measurement := &control.NativeTelemetry{Version: 1, Source: "wireguard-device", TrafficAvailable: true,
				CounterEpoch: "9", RxBytes: "18446744073709551615", TxBytes: "9007199254740993", MemoryRuntimeSysBytes: "12345678"}
			client.SetTelemetrySource(func() (*control.NativeTelemetry, error) { return measurement, nil })
			for round := 0; round < 2; round++ {
				if _, err := reregister(t.Context(), client, enrolmentFor(node.keys, ""), "CLIENT_ORIGIN", control.CapabilityDesc{}, nil); err != nil {
					t.Fatal(err)
				}
				for beat := 1; beat <= 2; beat++ {
					if _, err := client.SendHeartbeat(t.Context(), "a", nil, 0, 0, 0, 0, false); err != nil {
						t.Fatal(err)
					}
					body := <-received
					if !supported {
						if body != nil {
							t.Fatalf("sent unsupported contract to old server: %+v", body)
						}
						continue
					}
					if body == nil || body.Sequence != fmt.Sprint(beat) || body.SessionID != fmt.Sprintf("00000000-0000-4000-8000-%012d", round+1) || body.RxBytes != measurement.RxBytes || body.TxBytes != measurement.TxBytes || body.MemoryRuntimeSysBytes != measurement.MemoryRuntimeSysBytes {
						t.Fatalf("wire body lost session, sequence, precision or units: %+v", body)
					}
				}
			}
			client.SetTelemetrySource(func() (*control.NativeTelemetry, error) {
				return nil, errors.New("measurement unavailable")
			})
			if _, err := client.SendHeartbeat(t.Context(), "a", nil, 0, 0, 0, 0, false); err != nil {
				t.Fatalf("a measurement failure suppressed liveness: %v", err)
			}
			if body := <-received; body != nil {
				t.Fatalf("measurement failure fabricated an observation: %+v", body)
			}
		})
	}
}
