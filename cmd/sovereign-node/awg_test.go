package main

import (
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/sovereign/proxy/v4/pkg/control"
	"github.com/sovereign/proxy/v4/pkg/dataplane"
)

// ADR 0036 on the node's side: when the AmneziaWG device runs, under which parameters, and
// which profile devices it carries.

func awgDoc() []control.NetmapPeer {
	doc := profileDoc()
	doc[1].AccessMethod = "amneziawg"
	return doc
}

func netmapAWG() *control.AwgConfig {
	return &control.AwgConfig{Jc: 5, Jmin: 40, Jmax: 120, S1: 37, S2: 71, S3: 23, S4: 11,
		H1: "1177943521-1177943999", H2: "2218841063-2218841590", H3: "3302115709", H4: "412345678-412346133"}
}

type awgRecorder struct {
	starts []dataplane.AWGConfig
	stops  int
	fail   error
}

func (r *awgRecorder) start(c dataplane.AWGConfig) error {
	if r.fail != nil {
		return r.fail
	}
	r.starts = append(r.starts, c)
	return nil
}
func (r *awgRecorder) stop() { r.stops++ }

// awgManager is a gateway manager whose data plane is a recorder. The peers the manager
// hands to the data plane are captured.
func awgManager(t *testing.T, listen uint16) (*netmapManager, *awgRecorder, *[][]dataplane.Peer) {
	t.Helper()
	m, _ := gatewayManager(t)
	var applied [][]dataplane.Peer
	m.setPeers = func(p []dataplane.Peer) error { applied = append(applied, p); return nil }
	rec := &awgRecorder{}
	m.awg = awgState{built: true, listen: listen, start: rec.start, stop: rec.stop}
	return m, rec, &applied
}

func apply(t *testing.T, m *netmapManager, version uint64, doc []control.NetmapPeer, awg *control.AwgConfig) {
	t.Helper()
	nm := &control.NetmapResponse{Version: version, Peers: doc, Self: control.NetmapSelf{Awg: awg}}
	if err := m.Apply(nm, time.Now()); err != nil {
		t.Fatal(err)
	}
}

func lastPeer(t *testing.T, applied *[][]dataplane.Peer, key string) (dataplane.Peer, bool) {
	t.Helper()
	if len(*applied) == 0 {
		t.Fatal("no peer set reached the data plane")
	}
	for _, p := range (*applied)[len(*applied)-1] {
		if p.PublicKey == key {
			return p, true
		}
	}
	return dataplane.Peer{}, false
}

func TestNetmapAccessMethodPutsOnlyAProfileDeviceOnAmneziaWG(t *testing.T) {
	doc := awgDoc()
	doc[0].AccessMethod = "amneziawg" // a mesh node has no access method
	peers, _, err := netmapPeers(doc, nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, p := range peers {
		switch p.PublicKey {
		case profileKeyHex:
			if !p.AWG {
				t.Fatal("a profile device that chose amneziawg was not marked")
			}
		case meshKeyHex:
			if p.AWG {
				t.Fatal("a mesh node was marked as an AmneziaWG device")
			}
		}
	}
	doc[1].AccessMethod = "wireguard"
	peers, _, _ = netmapPeers(doc, nil)
	for _, p := range peers {
		if p.AWG {
			t.Fatal("a device on plain WireGuard was marked as AmneziaWG")
		}
	}
}

func TestAWGDeviceStartsOnlyWithAPortAndNetmapParameters(t *testing.T) {
	// No port: the operator did not turn the method on.
	m, rec, applied := awgManager(t, 0)
	apply(t, m, 1, awgDoc(), netmapAWG())
	if len(rec.starts) != 0 {
		t.Fatal("the device started without SOVEREIGN_AWG_LISTEN")
	}
	if _, kept := lastPeer(t, applied, profileKeyHex); kept {
		t.Fatal("a device that chose AmneziaWG was carried although the gateway runs none")
	}

	// A port but no parameters: there is no default set.
	m, rec, applied = awgManager(t, 51821)
	apply(t, m, 1, awgDoc(), nil)
	if len(rec.starts) != 0 {
		t.Fatal("the device started with no parameters from anywhere")
	}
	if _, kept := lastPeer(t, applied, profileKeyHex); kept {
		t.Fatal("an AmneziaWG device was carried with no AmneziaWG device running")
	}
	if _, kept := lastPeer(t, applied, meshKeyHex); !kept {
		t.Fatal("the mesh peer was lost with the AmneziaWG device")
	}

	// Both: it runs, and carries the device marked for it.
	m, rec, applied = awgManager(t, 51821)
	apply(t, m, 1, awgDoc(), netmapAWG())
	if len(rec.starts) != 1 || rec.starts[0].ListenPort != 51821 {
		t.Fatalf("starts = %+v", rec.starts)
	}
	if p, kept := lastPeer(t, applied, profileKeyHex); !kept || !p.AWG {
		t.Fatalf("the AmneziaWG device is not carried as one: %+v kept=%v", p, kept)
	}
}

func TestAWGDeviceIsNotStartedFromInvalidNetmapParametersEvenWithAnEnvironmentSet(t *testing.T) {
	m, rec, _ := awgManager(t, 51821)
	env := awgParamsFromNetmap(*netmapAWG())
	m.awg.env = &env
	bad := netmapAWG()
	bad.H1 = "2" // WireGuard's own message type
	apply(t, m, 1, awgDoc(), bad)
	if len(rec.starts) != 0 {
		t.Fatal("invalid netmap parameters were replaced by the environment's instead of refusing")
	}
}

func TestAWGEnvironmentParametersAreAFallbackOnly(t *testing.T) {
	m, rec, _ := awgManager(t, 51821)
	env := awgParamsFromNetmap(*netmapAWG())
	env.S1 = 99
	m.awg.env = &env
	apply(t, m, 1, awgDoc(), nil)
	if len(rec.starts) != 1 || rec.starts[0].Params.S1 != 99 {
		t.Fatalf("the environment's set was not used when the netmap had none: %+v", rec.starts)
	}
	apply(t, m, 2, awgDoc(), netmapAWG())
	if len(rec.starts) != 2 || rec.starts[1].Params.S1 != 37 || rec.stops != 1 {
		t.Fatalf("the netmap's set did not win over the environment's: starts=%d stops=%d", len(rec.starts), rec.stops)
	}
}

func TestAWGDeviceRestartsOnNewParametersAndNotOnTheSame(t *testing.T) {
	m, rec, _ := awgManager(t, 51821)
	apply(t, m, 1, awgDoc(), netmapAWG())
	apply(t, m, 2, awgDoc(), netmapAWG())
	if len(rec.starts) != 1 || rec.stops != 0 {
		t.Fatalf("an unchanged set restarted the device: starts=%d stops=%d", len(rec.starts), rec.stops)
	}
	next := netmapAWG()
	next.S1 = 53
	apply(t, m, 3, awgDoc(), next)
	if len(rec.starts) != 2 || rec.stops != 1 || rec.starts[1].Params.S1 != 53 {
		t.Fatalf("new parameters did not restart the device: starts=%d stops=%d", len(rec.starts), rec.stops)
	}
}

func TestAWGDeviceStopsWhenTheOrganisationWithdrawsTheMethod(t *testing.T) {
	m, rec, applied := awgManager(t, 51821)
	apply(t, m, 1, awgDoc(), netmapAWG())
	apply(t, m, 2, awgDoc(), nil)
	if rec.stops != 1 {
		t.Fatalf("the device kept running after the parameters were withdrawn: stops=%d", rec.stops)
	}
	if _, kept := lastPeer(t, applied, profileKeyHex); kept {
		t.Fatal("a device on AmneziaWG was still carried after the method was withdrawn")
	}
}

func TestAWGStartFailureDropsTheDevicesInsteadOfFailingTheDocument(t *testing.T) {
	m, rec, applied := awgManager(t, 51821)
	rec.fail = errors.New("address already in use")
	apply(t, m, 1, awgDoc(), netmapAWG())
	if _, kept := lastPeer(t, applied, meshKeyHex); !kept {
		t.Fatal("the mesh peer was lost because the AmneziaWG port was busy")
	}
	if _, kept := lastPeer(t, applied, profileKeyHex); kept {
		t.Fatal("an AmneziaWG device was carried with no AmneziaWG device running")
	}
}

func TestAWGListenPort(t *testing.T) {
	for spec, want := range map[string]uint16{"": 0, "51821": 51821, ":51821": 51821, " 443 ": 443} {
		got, err := awgListenPort(spec)
		if err != nil || got != want {
			t.Errorf("%q: got %d, %v; want %d", spec, got, err, want)
		}
	}
	for _, spec := range []string{"0", "70000", "abc", "10.0.0.1:51821", "localhost:51821", ":x"} {
		if _, err := awgListenPort(spec); err == nil {
			t.Errorf("%q was accepted", spec)
		}
	}
}

func TestAWGParamsFromEnvironment(t *testing.T) {
	t.Setenv("SOVEREIGN_AWG_PARAMS", "")
	if p, err := awgParamsFromEnv(); p != nil || err != nil {
		t.Fatalf("unset: %v %v", p, err)
	}
	t.Setenv("SOVEREIGN_AWG_PARAMS", `{"jc":5,"jmin":40,"jmax":120,"s1":37,"s2":71,"s3":23,"s4":11,"h1":"1177943521-1177943999","h2":"2218841063-2218841590","h3":"3302115709","h4":"412345678-412346133"}`)
	if p, err := awgParamsFromEnv(); err != nil || p == nil || p.S1 != 37 {
		t.Fatalf("valid: %v %v", p, err)
	}
	for name, raw := range map[string]string{
		"not json":      `{"jc":`,
		"unknown field": `{"jc":5,"secret":"1177943521"}`,
		"invalid":       `{"jc":5,"jmin":40,"jmax":120,"s1":37,"s2":71,"s3":23,"s4":11,"h1":"1-4","h2":"2218841063","h3":"3302115709","h4":"412345678"}`,
	} {
		t.Setenv("SOVEREIGN_AWG_PARAMS", raw)
		_, err := awgParamsFromEnv()
		if err == nil {
			t.Fatalf("%s was accepted", name)
		}
		if strings.Contains(err.Error(), "1177943521") || strings.Contains(err.Error(), "3302115709") {
			t.Fatalf("%s: the error carries a value: %v", name, err)
		}
	}
}
