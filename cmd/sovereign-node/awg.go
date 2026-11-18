package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net"
	"os"
	"slices"
	"strconv"
	"strings"

	"github.com/sovereign/proxy/v4/pkg/control"
	"github.com/sovereign/proxy/v4/pkg/dataplane"
)

// AmneziaWG on the profile gateway (ADR 0036), from the node's side.
//
// Two things must both be true for the second device to run: the operator gave the node a
// port (SOVEREIGN_AWG_LISTEN, default off), and the netmap carries the organisation's
// parameter set (self.awg), which the console sends only when the organisation allows the
// method. There is no default set. SOVEREIGN_AWG_PARAMS (a JSON object with the netmap's
// field names) is a fallback for tests and lab nodes that have no console; a netmap that
// carries parameters always wins over it, and an invalid netmap set is never replaced by
// the environment's.
//
// A profile device the netmap puts on AmneziaWG (access_method "amneziawg") is carried by
// the second device. When that device does not run, the device is carried by nothing and
// the document says so in its dropped list: it is not quietly moved to plain WireGuard,
// because its profile is written for AmneziaWG and the organisation did not choose the
// other method for it.

// awgState is the manager's record of the AmneziaWG device. Guarded by applyMu.
type awgState struct {
	listen  uint16
	env     *dataplane.AWGParams
	built   bool
	start   func(dataplane.AWGConfig) error
	stop    func()
	applied *dataplane.AWGParams
	note    string
}

// SetAWG records the operator's port and the environment's fallback parameters. Called
// once, before the first document is applied.
func (m *netmapManager) SetAWG(listen uint16, env *dataplane.AWGParams) {
	m.applyMu.Lock()
	m.awg.listen = listen
	m.awg.env = env
	m.applyMu.Unlock()
}

// awgWanted returns the parameter set the device should run under, or nil and the reason
// it should not run.
func (m *netmapManager) awgWanted(doc *control.NetmapResponse) (*dataplane.AWGParams, string) {
	if m.awg.listen == 0 {
		return nil, "SOVEREIGN_AWG_LISTEN is not set"
	}
	if !m.awg.built {
		return nil, "this binary was built without AmneziaWG"
	}
	var p dataplane.AWGParams
	switch {
	case doc != nil && doc.Self.Awg != nil:
		p = awgParamsFromNetmap(doc.Self.Awg.Params)
	case m.awg.env != nil:
		p = *m.awg.env
	default:
		return nil, "the netmap carries no AmneziaWG parameters (the organisation does not allow the method)"
	}
	if err := p.Validate(); err != nil {
		return nil, err.Error()
	}
	return &p, ""
}

func awgParamsFromNetmap(c control.AwgParams) dataplane.AWGParams {
	return dataplane.AWGParams{
		Jc: c.Jc, Jmin: c.Jmin, Jmax: c.Jmax,
		S1: c.S1, S2: c.S2, S3: c.S3, S4: c.S4,
		H1: c.H1, H2: c.H2, H3: c.H3, H4: c.H4,
	}
}

// reconcileAWG starts, restarts or stops the device so it matches the document. New
// parameters need a new device (a session cannot change its message types), so a change
// restarts it and the paired devices' sessions end with it. Callers hold applyMu.
func (m *netmapManager) reconcileAWG(doc *control.NetmapResponse) {
	if m.awg.start == nil {
		return
	}
	want, why := m.awgWanted(doc)
	running := m.awg.applied != nil
	switch {
	case want == nil && running:
		m.awg.stop()
		m.awg.applied = nil
		m.awgSay("AmneziaWG device stopped: " + why)
	case want == nil:
		m.awgSay("AmneziaWG device not running: " + why)
	case running && *want == *m.awg.applied:
		m.awgSay("")
	default:
		if running {
			m.awg.stop()
			m.awg.applied = nil
		}
		if err := m.awg.start(dataplane.AWGConfig{ListenPort: m.awg.listen, Params: *want}); err != nil {
			m.awgSay("AmneziaWG device could not start: " + err.Error())
			return
		}
		m.awg.applied = want
		m.awgSay(fmt.Sprintf("AmneziaWG device running on udp %d", m.awg.listen))
	}
}

// awgSay logs a change of state once, not on every document.
func (m *netmapManager) awgSay(note string) {
	if note == "" || note == m.awg.note {
		return
	}
	m.awg.note = note
	log.Printf("[SOVEREIGN-NODE] %s", note)
}

// withoutUnservedAWG removes the profile devices that chose AmneziaWG when the device is
// not running, and says which. Callers hold applyMu.
func (m *netmapManager) withoutUnservedAWG(peers []dataplane.Peer, dropped []string, doc []control.NetmapPeer) ([]dataplane.Peer, []string) {
	if m.awg.applied != nil {
		return peers, dropped
	}
	names := make(map[string]string, len(doc))
	for _, p := range doc {
		names[normaliseKey(p.PublicKeyHex)] = p.NodeID
	}
	kept := peers[:0:0]
	for _, p := range peers {
		if !p.AWG {
			kept = append(kept, p)
			continue
		}
		dropped = append(dropped, fmt.Sprintf("%s chose AmneziaWG and the gateway runs none", names[normaliseKey(p.PublicKey)]))
	}
	return kept, dropped
}

// accessMethodAWG reports whether a netmap entry puts a profile device on AmneziaWG.
func accessMethodAWG(p control.NetmapPeer) bool {
	return p.Profile && strings.EqualFold(strings.TrimSpace(p.AccessMethod), "amneziawg")
}

// awgListenPort reads SOVEREIGN_AWG_LISTEN: a UDP port, written "51821" or ":51821". Empty
// means the method is off. The device binds every interface; a host part would promise
// something it cannot do, so it is refused.
func awgListenPort(spec string) (uint16, error) {
	spec = strings.TrimSpace(spec)
	if spec == "" {
		return 0, nil
	}
	if strings.Contains(spec, ":") {
		host, port, err := net.SplitHostPort(spec)
		if err != nil {
			return 0, fmt.Errorf("AmneziaWG listen address %q: %w", spec, err)
		}
		if host != "" {
			return 0, fmt.Errorf("AmneziaWG listen address %q: give a port only; the device binds every interface", spec)
		}
		spec = port
	}
	n, err := strconv.ParseUint(spec, 10, 16)
	if err != nil || n == 0 {
		return 0, fmt.Errorf("AmneziaWG listen port %q is not a UDP port", spec)
	}
	return uint16(n), nil
}

// awgParamsFromEnv reads the fallback parameter set. The error never carries the value.
func awgParamsFromEnv() (*dataplane.AWGParams, error) {
	raw := strings.TrimSpace(os.Getenv("SOVEREIGN_AWG_PARAMS"))
	if raw == "" {
		return nil, nil
	}
	var p dataplane.AWGParams
	dec := json.NewDecoder(strings.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&p); err != nil {
		return nil, fmt.Errorf("SOVEREIGN_AWG_PARAMS is not a parameter object (jc, jmin, jmax, s1-s4, h1-h4)")
	}
	if err := p.Validate(); err != nil {
		return nil, fmt.Errorf("SOVEREIGN_AWG_PARAMS: %w", err)
	}
	return &p, nil
}

// AWGCapability is what a gateway tells the console when it can serve AmneziaWG.
const AWGCapability = "awg-v1"

// withAWG adds the capability and the port when the operator gave the node a port and the
// binary can run the device. Without both the console never offers the method for this
// gateway. The caller's slice is left alone.
func withAWG(c control.CapabilityDesc, port uint16, built bool) control.CapabilityDesc {
	if port == 0 || !built {
		return c
	}
	c.Capabilities = append(slices.Clone(c.Capabilities), AWGCapability)
	c.AwgPort = port
	return c
}
