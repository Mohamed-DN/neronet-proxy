package main

import (
	"errors"
	"fmt"
	"runtime"
	"sync"

	"github.com/sovereign/proxy/v4/pkg/control"
	"github.com/sovereign/proxy/v4/pkg/dataplane"
)

// telemetrySampler reads the device, never transport labels or raw handshake
// packets. Its epoch covers peer incarnations and observed counter/availability
// changes. Counters describe the current WireGuard peer set, not lifetime payload.
type telemetrySampler struct {
	mu          sync.Mutex
	read        func() ([]dataplane.PeerStatus, uint64, error)
	epoch       uint64
	deviceEpoch uint64
	previous    map[string]dataplane.PeerStatus
	available   bool
	initialized bool
}

func newTelemetrySampler(holder *netmapHolder) *telemetrySampler {
	return &telemetrySampler{epoch: 1, read: func() ([]dataplane.PeerStatus, uint64, error) {
		manager := holder.get()
		if manager == nil {
			return nil, 0, errors.New("data plane not initialized")
		}
		return manager.dev.CounterSnapshot()
	}}
}

func (s *telemetrySampler) snapshot() (*control.NativeTelemetry, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var memory runtime.MemStats
	runtime.ReadMemStats(&memory)
	peers, deviceEpoch, err := s.read()
	available := err == nil
	next := make(map[string]dataplane.PeerStatus, len(peers))
	var rx, tx uint64
	reset := s.initialized && (s.available != available || (available && s.deviceEpoch != deviceEpoch))
	if available {
		for _, peer := range peers {
			if ^uint64(0)-rx < peer.RxBytes || ^uint64(0)-tx < peer.TxBytes {
				return nil, errors.New("WireGuard peer counter sum exceeds uint64")
			}
			rx += peer.RxBytes
			tx += peer.TxBytes
			next[peer.PublicKey] = peer
			previous, exists := s.previous[peer.PublicKey]
			if s.initialized && (!exists || peer.RxBytes < previous.RxBytes || peer.TxBytes < previous.TxBytes) {
				reset = true
			}
		}
		if s.initialized && len(next) != len(s.previous) {
			reset = true
		}
	}
	if reset {
		if s.epoch == ^uint64(0) {
			return nil, errors.New("native telemetry counter epoch exhausted")
		}
		s.epoch++
	}
	s.previous, s.deviceEpoch, s.available, s.initialized = next, deviceEpoch, available, true
	result := &control.NativeTelemetry{Version: 1, Source: "wireguard-device",
		CounterEpoch: fmt.Sprint(s.epoch), TrafficAvailable: available, MemoryRuntimeSysBytes: fmt.Sprint(memory.Sys)}
	if available {
		result.RxBytes, result.TxBytes = fmt.Sprint(rx), fmt.Sprint(tx)
	}
	return result, nil
}
