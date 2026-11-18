package bridge

import (
	"io"
	"net"
	"sync"
)

// Attributed SOCKS5 for the access methods that terminate outside the gateway (ADR 0036).
//
// A terminator such as Xray (VLESS + REALITY) authenticates a person by its own means and
// then needs to put the connection into the mesh as that person's device, not as the
// gateway and not behind a shared address. It does that by connecting here with one
// username and password per device. The username names the device, the password is a
// random secret only the gateway and the terminator's configuration hold, and the dialer
// the pair resolves to opens connections from that device's own overlay address, so the
// device's ACL, conntrack, blocks and mesh names apply to them exactly as to a WireGuard
// device. A pair that is wrong, unknown or removed gets nothing: there is no anonymous
// method and no default device.

// DeviceEntry is one device's secret and the dialer that enters the mesh as it.
type DeviceEntry struct {
	Password string
	Dialer   OverlayDialer
}

// DeviceSOCKS is the registry a SOCKS5Server authenticates against. It is replaced as a
// whole when the netmap changes.
type DeviceSOCKS struct {
	mu      sync.RWMutex
	entries map[string]DeviceEntry
}

// NewDeviceSOCKS returns an empty registry: nobody authenticates.
func NewDeviceSOCKS() *DeviceSOCKS { return &DeviceSOCKS{entries: map[string]DeviceEntry{}} }

// Replace installs the given set of devices and forgets all others.
func (r *DeviceSOCKS) Replace(entries map[string]DeviceEntry) {
	next := make(map[string]DeviceEntry, len(entries))
	for k, v := range entries {
		next[k] = v
	}
	r.mu.Lock()
	r.entries = next
	r.mu.Unlock()
}

// Authenticate resolves a credential pair to the device's dialer. The password is
// compared in constant time and a username that does not exist costs the same compare.
func (r *DeviceSOCKS) Authenticate(username, password string) (OverlayDialer, bool) {
	r.mu.RLock()
	e, found := r.entries[username]
	r.mu.RUnlock()
	if !found || e.Password == "" || e.Dialer == nil {
		_ = constantTimeEqual(password, "unknown-device-padding-value")
		return nil, false
	}
	if !constantTimeEqual(password, e.Password) {
		return nil, false
	}
	return e.Dialer, true
}

// SetDeviceAuth makes the proxy authenticate every client as a device. It replaces
// SetCredentials.
func (s *SOCKS5Server) SetDeviceAuth(f func(username, password string) (OverlayDialer, bool)) {
	s.deviceAuth = f
}

// pipeDevice copies both ways until either side ends, then closes both.
func pipeDevice(client, outbound net.Conn) {
	defer outbound.Close()
	done := make(chan struct{}, 2)
	go func() { _, _ = io.Copy(outbound, client); done <- struct{}{} }()
	go func() { _, _ = io.Copy(client, outbound); done <- struct{}{} }()
	<-done
}
