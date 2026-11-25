package meshnode

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"log"
	"net"
	"net/netip"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"

	"github.com/sovereign/proxy/v4/pkg/bridge"
	"github.com/sovereign/proxy/v4/pkg/control"
	"github.com/sovereign/proxy/v4/pkg/dataplane"
	"github.com/sovereign/proxy/v4/pkg/xrayconf"
)

// VLESS + REALITY on the profile gateway (ADR 0036), from the node's side.
//
// Xray runs as its own container and terminates REALITY on TCP 443. It cannot know the
// mesh; this file is what makes its users NeroNet devices. For every profile device the
// netmap puts on "vless-reality" the gateway
//
//   - runs a virtual device (pkg/dataplane/virtdev.go): an IP stack bound to the device's
//     overlay address, inside the same forwarding table as every WireGuard device, so the
//     device's ACL, conntrack, blocks and mesh names apply;
//   - generates a random SOCKS password for it, held in memory and in the Xray config only;
//   - renders Xray's configuration (pkg/xrayconf) so that the device's VLESS uuid is routed
//     to a SOCKS outbound that authenticates here as that device.
//
// The device SOCKS listener accepts nothing else: no pair, no anonymous method. The node
// writes the Xray configuration to a file the Xray container reads from a shared volume
// (docker/xray); when the organisation switches the method off the file is removed, which
// stops the terminator. Three things must hold for any of this to run: the operator gave
// the node a SOCKS listen address and a configuration path, the netmap carries the
// organisation's REALITY parameters (self.vless), and the device has a uuid.

// VlessCapability is what a gateway tells the console when it can serve VLESS + REALITY.
const VlessCapability = "vless-v1"

// vlessState is the manager's record. Guarded by applyMu.
type vlessState struct {
	enabled    bool
	socksAddr  string // host:port the Xray container reaches the device SOCKS at
	configPath string
	reg        *bridge.DeviceSOCKS
	setVirtual func([]dataplane.VirtualSpec) error
	dialerOf   func(id string) (bridge.OverlayDialer, bool)

	secrets map[string]string // device id -> SOCKS password, for the life of the process
	served  map[string]bool   // device ids carried by a virtual device
	last    []byte            // the config as last written
	note    string
}

// SetVLESS records the operator's settings. Called once, before the first document.
func (m *netmapManager) SetVLESS(socksAddr, configPath string, reg *bridge.DeviceSOCKS) {
	m.applyMu.Lock()
	defer m.applyMu.Unlock()
	m.vless.enabled = socksAddr != "" && configPath != "" && reg != nil
	m.vless.socksAddr = socksAddr
	m.vless.configPath = configPath
	m.vless.reg = reg
	if m.dev != nil {
		m.vless.setVirtual = m.dev.SetVirtualDevices
		m.vless.dialerOf = func(id string) (bridge.OverlayDialer, bool) {
			d, ok := m.dev.VirtualDialer(id)
			return d, ok
		}
	}
}

// accessMethodVLESS reports whether a netmap entry puts a profile device on VLESS.
func accessMethodVLESS(p control.NetmapPeer) bool {
	return p.Profile && strings.EqualFold(strings.TrimSpace(p.AccessMethod), "vless-reality")
}

type vlessDevice struct {
	id, uuid string
	addrs    []netip.Addr
}

// vlessDevices lists the devices the document puts on VLESS and that may be served:
// not revoked, with a uuid and single-host addresses.
func vlessDevices(peers []control.NetmapPeer, revoked map[string]uint64) []vlessDevice {
	var out []vlessDevice
	for _, p := range peers {
		if !accessMethodVLESS(p) || p.NodeID == "" || p.VlessUUID == "" {
			continue
		}
		if _, gone := revoked[normaliseKey(p.PublicKeyHex)]; gone {
			continue
		}
		var addrs []netip.Addr
		for _, raw := range p.AllowedIPs {
			prefix, err := netip.ParsePrefix(strings.TrimSpace(raw))
			if err != nil || !prefix.IsSingleIP() {
				continue
			}
			addrs = append(addrs, prefix.Addr().Unmap())
		}
		if len(addrs) == 0 {
			continue
		}
		out = append(out, vlessDevice{id: p.NodeID, uuid: strings.ToLower(p.VlessUUID), addrs: addrs})
	}
	return out
}

// reconcileVLESS makes the virtual devices, the SOCKS registry and the Xray configuration
// match the document. Callers hold applyMu.
func (m *netmapManager) reconcileVLESS(doc *control.NetmapResponse, revoked map[string]uint64) {
	v := &m.vless
	if !v.enabled {
		v.served = nil
		return
	}
	var params *control.VlessConfig
	if doc != nil {
		params = doc.Self.Vless
	}
	var devs []vlessDevice
	if params != nil && doc != nil {
		devs = vlessDevices(doc.Peers, revoked)
	}

	specs := make([]dataplane.VirtualSpec, 0, len(devs))
	for _, d := range devs {
		specs = append(specs, dataplane.VirtualSpec{ID: d.id, Addrs: d.addrs})
	}
	if v.setVirtual != nil {
		if err := v.setVirtual(specs); err != nil {
			// Nothing is served rather than something half-built.
			v.served = nil
			v.reg.Replace(map[string]bridge.DeviceEntry{})
			v.say("VLESS devices could not be set up: " + err.Error())
			return
		}
	}

	if v.secrets == nil {
		v.secrets = map[string]string{}
	}
	entries := make(map[string]bridge.DeviceEntry, len(devs))
	served := make(map[string]bool, len(devs))
	clients := make([]xrayconf.Client, 0, len(devs))
	live := make(map[string]bool, len(devs))
	for _, d := range devs {
		live[d.id] = true
		pw, ok := v.secrets[d.id]
		if !ok {
			var b [32]byte
			if _, err := rand.Read(b[:]); err != nil {
				v.say("VLESS: no randomness for a device secret")
				return
			}
			pw = hex.EncodeToString(b[:])
			v.secrets[d.id] = pw
		}
		var dialer bridge.OverlayDialer
		if v.dialerOf != nil {
			var found bool
			if dialer, found = v.dialerOf(d.id); !found {
				continue
			}
		} else {
			continue
		}
		entries[d.id] = bridge.DeviceEntry{Password: pw, Dialer: dialer}
		served[d.id] = true
		clients = append(clients, xrayconf.Client{DeviceID: d.id, UUID: d.uuid, SocksPassword: pw})
	}
	for id := range v.secrets {
		if !live[id] {
			delete(v.secrets, id)
		}
	}
	v.reg.Replace(entries)
	v.served = served

	if params == nil {
		v.removeConfig()
		v.say("VLESS terminator stopped: the netmap carries no REALITY parameters (the organisation does not allow the method)")
		return
	}
	host, portStr, err := net.SplitHostPort(v.socksAddr)
	port, perr := strconv.ParseUint(portStr, 10, 16)
	if err != nil || perr != nil {
		v.say("VLESS: the SOCKS address for Xray is not host:port")
		return
	}
	cfg, err := xrayconf.Render(xrayconf.Spec{
		ListenPort: params.ListenPort, Dest: params.Dest, ServerNames: params.ServerNames,
		PrivateKey: params.PrivateKey, ShortIDs: params.ShortIDs,
		SocksHost: host, SocksPort: uint16(port), Clients: clients,
	})
	if err != nil {
		// The error names fields, never values. Nothing is served without a config.
		v.removeConfig()
		v.say("VLESS configuration refused: " + err.Error())
		return
	}
	if slices.Equal(cfg, v.last) {
		return
	}
	if err := writeAtomic(v.configPath, cfg); err != nil {
		v.say("VLESS: could not write the Xray configuration: " + err.Error())
		return
	}
	v.last = cfg
	v.say(fmt.Sprintf("VLESS terminator configured for %d device(s)", len(clients)))
}

func (v *vlessState) removeConfig() {
	if v.last != nil || fileExists(v.configPath) {
		_ = os.Remove(v.configPath)
	}
	v.last = nil
}

func fileExists(p string) bool { _, err := os.Stat(p); return err == nil }

// say logs a change of state once, not on every document.
func (v *vlessState) say(note string) {
	if note == "" || note == v.note {
		return
	}
	v.note = note
	log.Printf("[SOVEREIGN-NODE] %s", note)
}

// writeAtomic writes the file with mode 0600 through a rename, so Xray never reads half
// a configuration. The file holds secrets.
func writeAtomic(path string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".xray-*")
	if err != nil {
		return err
	}
	name := tmp.Name()
	if err := tmp.Chmod(0o600); err != nil && os.PathSeparator == '/' {
		tmp.Close()
		os.Remove(name)
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		os.Remove(name)
		return err
	}
	if err := tmp.Close(); err != nil {
		os.Remove(name)
		return err
	}
	return os.Rename(name, path)
}

// withVless adds the capability and the public port when the operator gave the node one.
// Without it the console never offers the method for this gateway. The caller's slice is
// left alone.
func withVless(c control.CapabilityDesc, port uint16) control.CapabilityDesc {
	if port == 0 {
		return c
	}
	c.Capabilities = append(slices.Clone(c.Capabilities), VlessCapability)
	c.VlessPort = port
	return c
}
