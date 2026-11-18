//go:build !awg

package dataplane

// A binary built without the awg tag has no AmneziaWG device. The methods exist so the node
// compiles either way and says plainly why a request for AmneziaWG cannot be honoured.

type awgRuntime struct{}

// AWGBuilt reports whether this binary can run an AmneziaWG device.
func AWGBuilt() bool { return false }

// StartAWG always fails in this build.
func (d *Device) StartAWG(AWGConfig) error { return ErrAWGNotBuilt }

// StopAWG does nothing in this build.
func (d *Device) StopAWG() {}

// AWGRunning is always false in this build.
func (d *Device) AWGRunning() bool { return false }

// AWGPort always fails in this build.
func (d *Device) AWGPort() (uint16, error) { return 0, ErrAWGNotBuilt }

func (d *Device) applyAWGPeersLocked(peers []Peer) error {
	if len(peers) > 0 {
		return ErrAWGNotBuilt
	}
	return nil
}

func (d *Device) awgIpcGet() string { return "" }

func (d *Device) shutdownAWG() {}
