//go:build awg

package dataplane

// RED stub. It exists only so the interop test in this commit compiles: it accepts the
// configuration and listens on nothing, which is what main does. The next commits replace
// this file with the real second device.

import "fmt"

// AWGParams are the AmneziaWG obfuscation parameters of one organisation.
type AWGParams struct {
	Jc, Jmin, Jmax int
	S1, S2, S3, S4 int
	H1, H2, H3, H4 string
}

// AWGConfig configures the gateway's AmneziaWG device.
type AWGConfig struct {
	ListenPort uint16
	Params     AWGParams
}

func (p AWGParams) uapi() string {
	return fmt.Sprintf("jc=%d\njmin=%d\njmax=%d\ns1=%d\ns2=%d\ns3=%d\ns4=%d\nh1=%s\nh2=%s\nh3=%s\nh4=%s\n",
		p.Jc, p.Jmin, p.Jmax, p.S1, p.S2, p.S3, p.S4, p.H1, p.H2, p.H3, p.H4)
}

// StartAWG would start the second device; the stub starts nothing.
func (d *Device) StartAWG(AWGConfig) error { return nil }

// AWGPort names a port nothing listens on.
func (d *Device) AWGPort() (uint16, error) { return 51999, nil }
