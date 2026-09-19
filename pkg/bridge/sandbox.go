package bridge

import (
	"errors"
	"fmt"
	"net"
	"sync/atomic"
)

var (
	ErrBogonIPBlocked     = errors.New("destination IP belongs to private RFC 1918 / Bogon range")
	ErrAbusePortBlocked   = errors.New("destination port is blocked by anti-abuse egress policy")
	ErrBatteryLowBlocked  = errors.New("bridge is suspended due to low battery (< 20%)")
	ErrQuotaExceeded      = errors.New("bridge monthly bandwidth quota exceeded (>= 90%)")
	ErrEgressNotPermitted = errors.New("egress connection rejected by bridge policy engine")
)

// Private and Bogon IP CIDR ranges blocked from egress
var bogonCIDRs = []*net.IPNet{
	mustParseCIDR("10.0.0.0/8"),     // RFC 1918 Private Local
	mustParseCIDR("172.16.0.0/12"),  // RFC 1918 Private Local
	mustParseCIDR("192.168.0.0/16"), // RFC 1918 Private Local
	mustParseCIDR("127.0.0.0/8"),    // Host Loopback
	mustParseCIDR("100.64.0.0/10"),  // CGNAT / Overlay Subnet
	mustParseCIDR("169.254.0.0/16"), // Link-Local
	mustParseCIDR("224.0.0.0/4"),    // Multicast
	mustParseCIDR("fc00::/7"),       // IPv6 Unique Local
	mustParseCIDR("fe80::/10"),      // IPv6 Link-Local
	mustParseCIDR("::1/128"),        // IPv6 Loopback
}

// Blocked outbound ports for anti-abuse
var blockedPorts = map[int]string{
	25:   "SMTP",
	465:  "SMTPS",
	587:  "Submission",
	135:  "MS RPC",
	137:  "NetBIOS Name",
	138:  "NetBIOS Datagram",
	139:  "NetBIOS Session",
	445:  "SMB",
	22:   "SSH",
	23:   "Telnet",
	3389: "RDP",
	1900: "SSDP Amplification",
	5349: "STUN Amplification",
}

func mustParseCIDR(s string) *net.IPNet {
	_, ipnet, err := net.ParseCIDR(s)
	if err != nil {
		panic(fmt.Sprintf("invalid CIDR %s: %v", s, err))
	}
	return ipnet
}

// SandboxPolicyConfig configures the bridge security parameters
type SandboxPolicyConfig struct {
	AllowLAN        bool
	BlockedPorts    map[int]string
	MaxBandwidthMB  uint64
	CurrentUsageMB  uint64
	MinBatteryLevel uint8
}

// SandboxPolicyEngine enforces multi-layer isolation rules on outbound sockets
type SandboxPolicyEngine struct {
	config         SandboxPolicyConfig
	blockedCounts  uint64
	approvedCounts uint64
}

// NewSandboxPolicyEngine creates a new sandbox engine with default enterprise isolation rules
func NewSandboxPolicyEngine(cfg SandboxPolicyConfig) *SandboxPolicyEngine {
	if cfg.BlockedPorts == nil {
		cfg.BlockedPorts = blockedPorts
	}
	if cfg.MinBatteryLevel == 0 {
		cfg.MinBatteryLevel = 20
	}
	return &SandboxPolicyEngine{config: cfg}
}

// IsBogonIP checks if an IP belongs to private/loopback/multicast/link-local ranges
func IsBogonIP(ip net.IP) bool {
	if ip == nil {
		return true
	}
	if ip.IsLoopback() || ip.IsMulticast() || ip.IsLinkLocalUnicast() || ip.IsPrivate() || ip.IsUnspecified() {
		return true
	}

	for _, cidr := range bogonCIDRs {
		if cidr.Contains(ip) {
			return true
		}
	}
	return false
}

// IsBlockedPort checks if a port is in the anti-abuse blocklist
func IsBlockedPort(port int) bool {
	_, blocked := blockedPorts[port]
	return blocked
}

// ValidateEgress checks destination IP, port, and device safeguards before opening an outbound connection
func (e *SandboxPolicyEngine) ValidateEgress(ip net.IP, port int, batteryPct uint8, onBattery bool) error {
	// 1. Battery check
	if onBattery && batteryPct < e.config.MinBatteryLevel {
		atomic.AddUint64(&e.blockedCounts, 1)
		return ErrBatteryLowBlocked
	}

	// 2. Port check
	if _, blocked := e.config.BlockedPorts[port]; blocked {
		atomic.AddUint64(&e.blockedCounts, 1)
		return fmt.Errorf("%w: port %d (%s)", ErrAbusePortBlocked, port, e.config.BlockedPorts[port])
	}

	// 3. Bogon IP check
	if !e.config.AllowLAN && IsBogonIP(ip) {
		atomic.AddUint64(&e.blockedCounts, 1)
		return fmt.Errorf("%w: %s", ErrBogonIPBlocked, ip.String())
	}

	atomic.AddUint64(&e.approvedCounts, 1)
	return nil
}

// Stats returns the number of approved and blocked connection attempts
func (e *SandboxPolicyEngine) Stats() (approved uint64, blocked uint64) {
	return atomic.LoadUint64(&e.approvedCounts), atomic.LoadUint64(&e.blockedCounts)
}
