package dataplane

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
)

// AmneziaWG obfuscation parameters (ADR 0036).
//
// AmneziaWG is WireGuard with the protocol's fixed bytes made variable: the four message
// types become values in per-deployment ranges (H1-H4), each handshake and data message
// gets random-length padding in front (S1-S4), and a burst of random junk datagrams
// precedes each handshake (Jc, Jmin, Jmax). A client and a server interoperate only when
// S1-S4 and H1-H4 are identical on both ends; the junk parameters shape what the sender
// emits and need not match.
//
// The values are secrets of a kind: whoever knows them can tell this deployment's traffic
// from noise, and whoever does not know them cannot handshake. They are generated per
// organisation by the console, travel in the netmap, and are never compiled in: a fixed
// set shared by every install would be a signature for a censor to match. For the same
// reason this package has no default set and refuses to start a device without one.
//
// Sources of the rules in Validate: the amneziawg-go v0.2.19 README ("Configuration") and
// its device package (device/uapi.go, device/magic-header.go) for what the engine accepts,
// and the AmneziaWG documentation for the recommended ranges. Where the engine's own limit
// is looser than a limit that matters on the wire, the stricter one is enforced and says
// so below.

// AWGParams is one organisation's AmneziaWG parameter set. The JSON names match the
// netmap's awg object (pkg/control.AwgConfig).
type AWGParams struct {
	Jc   int `json:"jc"`
	Jmin int `json:"jmin"`
	Jmax int `json:"jmax"`
	S1   int `json:"s1"`
	S2   int `json:"s2"`
	S3   int `json:"s3"`
	S4   int `json:"s4"`
	// H1-H4 are a single value ("1177943521") or an inclusive range ("1177943521-1177943999").
	H1 string `json:"h1"`
	H2 string `json:"h2"`
	H3 string `json:"h3"`
	H4 string `json:"h4"`
}

// AWGConfig configures the gateway's AmneziaWG device.
type AWGConfig struct {
	// ListenPort is the UDP port of the AmneziaWG device. Zero asks the kernel for an
	// ephemeral port (tests); a gateway always names one.
	ListenPort uint16
	Params     AWGParams
}

var (
	// ErrAWGParams wraps every parameter validation failure. Its text names the field and
	// never the value.
	ErrAWGParams = errors.New("dataplane: invalid AmneziaWG parameters")
	// ErrAWGNotBuilt is returned when AmneziaWG is asked for in a binary built without the
	// awg build tag.
	ErrAWGNotBuilt = errors.New("dataplane: this binary was built without AmneziaWG (build tag awg)")
	// ErrAWGNotRunning is returned for a peer that wants the AmneziaWG device when none runs.
	ErrAWGNotRunning = errors.New("dataplane: the AmneziaWG device is not running")
)

// Limits. Wire sizes: a handshake initiation is 148 bytes, a response 92, a cookie reply
// 64 and a transport header 32 before padding; the padded message must fit a 1280 byte
// datagram (the IPv6 minimum MTU) or it fragments, which is itself a tell.
const (
	awgJcMax   = 128  // junk datagrams before a handshake
	awgJmaxCap = 1280 // junk size: above the path MTU a datagram fragments
	awgS1Max   = 1280 - 148
	awgS2Max   = 1280 - 92
	// S3 and S4 are held below the MTU bound on purpose. S4 is added to every data
	// message, so a large one costs throughput and pushes full-size packets over the path
	// MTU; S3 pads the rare cookie reply.
	awgS3Max = 64
	awgS4Max = 32
	// An initiation and a response must differ in size, or padding hides nothing:
	// 148+S1 == 92+S2 exactly when S2 == S1+56.
	awgInitResponseGap = 56
	// WireGuard's own message types are 1 to 4. A header range that touches them would
	// make this device accept or emit standard messages.
	awgHeaderFloor = 5
	// The console generates inside 5..2147483647, and so does every profile; a header above
	// that is not one the official apps' generator would produce.
	awgHeaderCap = 2147483647
)

type awgHeaderRange struct{ lo, hi uint32 }

func parseAWGHeader(spec string) (awgHeaderRange, error) {
	spec = strings.TrimSpace(spec)
	if spec == "" {
		return awgHeaderRange{}, errors.New("missing")
	}
	parts := strings.Split(spec, "-")
	if len(parts) > 2 {
		return awgHeaderRange{}, errors.New("not a value or a range")
	}
	lo, err := strconv.ParseUint(parts[0], 10, 32)
	if err != nil {
		return awgHeaderRange{}, errors.New("not a 32-bit number")
	}
	hi := lo
	if len(parts) == 2 {
		if hi, err = strconv.ParseUint(parts[1], 10, 32); err != nil {
			return awgHeaderRange{}, errors.New("not a 32-bit number")
		}
	}
	if hi < lo {
		return awgHeaderRange{}, errors.New("range ends before it starts")
	}
	if hi > awgHeaderCap {
		return awgHeaderRange{}, errors.New("above 2147483647")
	}
	if lo < awgHeaderFloor {
		return awgHeaderRange{}, errors.New("overlaps WireGuard's own message types 1-4")
	}
	return awgHeaderRange{uint32(lo), uint32(hi)}, nil
}

// Validate refuses a parameter set that the engine would accept but that would not
// obfuscate, would not interoperate with the official apps, or would fragment on the wire.
// The zero value fails: there is no default set.
func (p AWGParams) Validate() error {
	fail := func(field, why string) error {
		return fmt.Errorf("%w: %s %s", ErrAWGParams, field, why)
	}
	if p.Jc < 1 || p.Jc > awgJcMax {
		return fail("Jc", fmt.Sprintf("must be 1 to %d", awgJcMax))
	}
	if p.Jmin < 1 {
		return fail("Jmin", "must be at least 1")
	}
	if p.Jmax < p.Jmin {
		return fail("Jmax", "must not be below Jmin")
	}
	if p.Jmax > awgJmaxCap {
		return fail("Jmax", fmt.Sprintf("must be at most %d", awgJmaxCap))
	}
	if p.S1 < 1 || p.S1 > awgS1Max {
		return fail("S1", fmt.Sprintf("must be 1 to %d", awgS1Max))
	}
	if p.S2 < 1 || p.S2 > awgS2Max {
		return fail("S2", fmt.Sprintf("must be 1 to %d", awgS2Max))
	}
	if p.S2 == p.S1+awgInitResponseGap {
		return fail("S2", "makes the handshake response the same size as the initiation")
	}
	if p.S3 < 0 || p.S3 > awgS3Max {
		return fail("S3", fmt.Sprintf("must be 0 to %d", awgS3Max))
	}
	if p.S4 < 0 || p.S4 > awgS4Max {
		return fail("S4", fmt.Sprintf("must be 0 to %d", awgS4Max))
	}
	headers := []struct {
		name, spec string
	}{{"H1", p.H1}, {"H2", p.H2}, {"H3", p.H3}, {"H4", p.H4}}
	parsed := make([]awgHeaderRange, len(headers))
	for i, h := range headers {
		r, err := parseAWGHeader(h.spec)
		if err != nil {
			return fail(h.name, err.Error())
		}
		parsed[i] = r
		for j := 0; j < i; j++ {
			if r.lo <= parsed[j].hi && parsed[j].lo <= r.hi {
				return fail(h.name, "overlaps "+headers[j].name)
			}
		}
	}
	return nil
}

// uapi renders the parameters as amneziawg-go UAPI lines. Callers validate first.
func (p AWGParams) uapi() string {
	return fmt.Sprintf("jc=%d\njmin=%d\njmax=%d\ns1=%d\ns2=%d\ns3=%d\ns4=%d\nh1=%s\nh2=%s\nh3=%s\nh4=%s\n",
		p.Jc, p.Jmin, p.Jmax, p.S1, p.S2, p.S3, p.S4,
		strings.TrimSpace(p.H1), strings.TrimSpace(p.H2), strings.TrimSpace(p.H3), strings.TrimSpace(p.H4))
}

// String and GoString keep the values out of logs: they are treated like keys.
func (AWGParams) String() string   { return "awg-params(redacted)" }
func (AWGParams) GoString() string { return "awg-params(redacted)" }
