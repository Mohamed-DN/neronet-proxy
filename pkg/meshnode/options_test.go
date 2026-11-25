package meshnode

import (
	"net"
	"net/netip"
	"reflect"
	"testing"
	"time"
)

// Every setting that Params and the data plane options both name must reach the data plane. VLESS was
// parsed, advertised to the console and never handed over, so no binary ever ran it.
func TestEveryOperatorSettingReachesTheDataPlane(t *testing.T) {
	var p Params
	pv := reflect.ValueOf(&p).Elem()
	optsType := reflect.TypeOf(dataplaneOptions{})
	var shared []string
	for i := 0; i < optsType.NumField(); i++ {
		f := optsType.Field(i)
		target, ok := pv.Type().FieldByName(f.Name)
		if !ok || target.Type != f.Type {
			continue
		}
		v := pv.FieldByName(f.Name)
		switch {
		case f.Type == reflect.TypeOf(netip.AddrPort{}):
			v.Set(reflect.ValueOf(netip.MustParseAddrPort("192.0.2.1:53")))
		case f.Type.Kind() == reflect.String:
			v.SetString("set-" + f.Name)
		case f.Type.Kind() == reflect.Bool:
			v.SetBool(true)
		case f.Type.Kind() == reflect.Pointer:
			v.Set(reflect.New(f.Type.Elem()))
		default:
			t.Fatalf("no sample value for %s of type %s: add one", f.Name, f.Type)
		}
		shared = append(shared, f.Name)
	}
	if len(shared) < 8 {
		t.Fatalf("only %d shared settings found: %v", len(shared), shared)
	}
	got := reflect.ValueOf(p.operatorOptions())
	for _, name := range shared {
		if got.FieldByName(name).IsZero() {
			t.Errorf("%s is set by the operator and never reaches the data plane", name)
		}
	}
	// The renamed ones.
	p.DataplaneMode, p.SpikePeers, p.OverlayEchoPort, p.EnableExit = "netstack", "spike", 9999, true
	o := p.operatorOptions()
	if o.Mode != "netstack" || o.SpikeConfig != "spike" || o.EchoPort != 9999 || !o.ExitEnabled {
		t.Errorf("a renamed setting was lost: %+v", o)
	}
}

// With the three VLESS settings the device SOCKS listener really answers.
func TestTheVLESSSettingsOpenTheDeviceListener(t *testing.T) {
	addr := freeAddr(t)
	p := Params{VLESSSocksListen: addr, VLESSSocksAddr: addr, XrayConfig: t.TempDir() + "/config.json"}
	o := p.operatorOptions()
	stop, err := startVLESS(&netmapManager{}, o.VLESSSocksListen, o.VLESSSocksAddr, o.XrayConfig)
	if err != nil {
		t.Fatal(err)
	}
	defer stop()
	conn, err := net.DialTimeout("tcp", addr, 2*time.Second)
	if err != nil {
		t.Fatalf("the device SOCKS listener is not there: %v", err)
	}
	_ = conn.Close()
}
