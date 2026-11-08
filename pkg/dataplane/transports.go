package dataplane

import (
	"context"
	"fmt"
	"time"

	"github.com/sovereign/proxy/v4/pkg/transport"
)

type PathStatus struct {
	PeerStatus
	ObservedAt time.Time
}

func (d *Device) TransportMux() *transport.Mux { return d.mux }

// ReconfigureTransports closes withdrawn transports before returning. Newly allowed
// receive functions require WireGuard to reopen this same Bind, not a second device.
func (d *Device) ReconfigureTransports(allowed []string, relays []transport.Relay) error {
	if d.mux == nil {
		return nil
	}
	d.setMu.Lock()
	defer d.setMu.Unlock()
	port := d.transportPort
	if port == 0 {
		port, _ = d.ListenPort()
		d.transportPort = port
	}
	d.mux.Reconfigure(func(cfg *transport.Config) { cfg.Relays = append([]transport.Relay(nil), relays...) })
	if d.mux.SetAllowed(allowed) {
		return d.wg.IpcSet(fmt.Sprintf("listen_port=%d\n", port))
	}
	return nil
}

// WatchAuthenticatedPaths reads the unmodified WireGuard device. Its concrete
// endpoint is assigned only after Noise/AEAD authentication and replay checks;
// a received cookie or fabricated response cannot change these counters.
func (d *Device) WatchAuthenticatedPaths(ctx context.Context, interval time.Duration) {
	if d.mux == nil {
		return
	}
	if interval <= 0 {
		interval = 200 * time.Millisecond
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			d.SampleAuthenticatedPaths()
		}
	}
}

func (d *Device) SampleAuthenticatedPaths() []PathStatus {
	peers, err := d.Peers()
	if err != nil {
		return nil
	}
	d.authMu.Lock()
	defer d.authMu.Unlock()
	if d.authPaths == nil {
		d.authPaths = map[string]PathStatus{}
	}
	current := make(map[string]PathStatus, len(peers))
	var out []PathStatus
	for _, peer := range peers {
		prior := d.authPaths[peer.PublicKey]
		observed := prior.ObservedAt
		fresh := (peer.RxBytes > prior.RxBytes || peer.LastHandshake.After(prior.LastHandshake) || (peer.Endpoint != prior.Endpoint && !peer.LastHandshake.IsZero()))
		if fresh && d.mux != nil && d.mux.ConfirmAuthenticated(peer.PublicKey, peer.Endpoint) {
			observed = time.Now()
		}
		status := PathStatus{peer, observed}
		current[peer.PublicKey] = status
		out = append(out, status)
	}
	d.authPaths = current
	return out
}
