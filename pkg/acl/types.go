package acl

import (
	"fmt"
	"net"
	"strconv"
	"strings"
	"time"
)

// Protocol represents the transport layer protocol for ACL matching
type Protocol string

const (
	ProtocolTCP  Protocol = "TCP"
	ProtocolUDP  Protocol = "UDP"
	ProtocolICMP Protocol = "ICMP"
	ProtocolALL  Protocol = "ALL"
)

// Action defines the enforcement outcome
type Action string

const (
	ActionAccept Action = "ACCEPT"
	ActionDrop   Action = "DROP"
)

// PortRange specifies a contiguous range of ports [Start, End]
type PortRange struct {
	Start uint16 `json:"start"`
	End   uint16 `json:"end"`
}

// Matches checks if a port falls within the range
func (pr PortRange) Matches(port uint16) bool {
	return port >= pr.Start && port <= pr.End
}

// String returns formatted string representation of port range
func (pr PortRange) String() string {
	if pr.Start == pr.End {
		return strconv.Itoa(int(pr.Start))
	}
	return fmt.Sprintf("%d-%d", pr.Start, pr.End)
}

// ParsePortRanges converts a comma-separated string (e.g. "80,443,8000-8080", "*") into []PortRange
func ParsePortRanges(raw string) ([]PortRange, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" || raw == "*" {
		return []PortRange{{Start: 1, End: 65535}}, nil
	}

	parts := strings.Split(raw, ",")
	ranges := make([]PortRange, 0, len(parts))

	for _, part := range parts {
		part = strings.TrimSpace(part)
		if part == "" {
			return nil, fmt.Errorf("empty port range entry in %q", raw)
		}
		if strings.Contains(part, "-") {
			bounds := strings.Split(part, "-")
			if len(bounds) != 2 {
				return nil, fmt.Errorf("invalid port range %q", part)
			}
			startStr := strings.TrimSpace(bounds[0])
			endStr := strings.TrimSpace(bounds[1])
			start, err := strconv.ParseUint(startStr, 10, 16)
			if err != nil || start == 0 {
				return nil, fmt.Errorf("invalid start port in range %q", part)
			}
			end, err := strconv.ParseUint(endStr, 10, 16)
			if err != nil || end == 0 {
				return nil, fmt.Errorf("invalid end port in range %q", part)
			}
			if start > end {
				return nil, fmt.Errorf("start port %d cannot exceed end port %d in range %q", start, end, part)
			}
			ranges = append(ranges, PortRange{Start: uint16(start), End: uint16(end)})
		} else {
			port, err := strconv.ParseUint(part, 10, 16)
			if err != nil || port == 0 {
				return nil, fmt.Errorf("invalid port %q", part)
			}
			ranges = append(ranges, PortRange{Start: uint16(port), End: uint16(port)})
		}
	}
	return ranges, nil
}

// RuleItem represents a single protocol and port restriction rule
type RuleItem struct {
	Protocol   Protocol    `json:"protocol"` // TCP, UDP, ICMP, ALL
	PortRanges []PortRange `json:"port_ranges"`
	Action     Action      `json:"action"` // ACCEPT, DROP
}

// PolicyRule defines an administrative access control policy
type PolicyRule struct {
	ID            string     `json:"id"`
	Name          string     `json:"name"`
	Description   string     `json:"description"`
	Enabled       bool       `json:"enabled"`
	SourceGroups  []string   `json:"source_groups"`      // e.g. ["group:admin", "group:devs"]
	DestGroups    []string   `json:"destination_groups"` // e.g. ["group:exit-nodes", "group:residential"]
	Rules         []RuleItem `json:"rules"`
	Bidirectional bool       `json:"bidirectional"`
	CreatedAt     time.Time  `json:"created_at"`
	UpdatedAt     time.Time  `json:"updated_at"`
}

// PeerGroup defines a named group of peers
type PeerGroup struct {
	ID          string    `json:"id"`   // e.g. "group:exit-nodes"
	Name        string    `json:"name"` // e.g. "Exit Nodes Swarm"
	Description string    `json:"description"`
	Peers       []string  `json:"peers"`     // Node IDs
	IsSystem    bool      `json:"is_system"` // Built-in (e.g. group:all)
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
}

// CompiledFilterRule represents the low-level rule pushed to a client node
type CompiledFilterRule struct {
	AllowedPeerVIP net.IP      `json:"allowed_peer_vip"`
	Protocol       Protocol    `json:"protocol"`
	PortRanges     []PortRange `json:"port_ranges"`
	Action         Action      `json:"action"`
	IsDirectional  bool        `json:"is_directional"`
}

// CompiledPeerPolicy is the set of all rules applicable to a specific peer
type CompiledPeerPolicy struct {
	NodeID        string               `json:"node_id"`
	OverlayIPv4   net.IP               `json:"overlay_ipv4"`
	InboundRules  []CompiledFilterRule `json:"inbound_rules"`
	OutboundRules []CompiledFilterRule `json:"outbound_rules"`
	Epoch         uint64               `json:"epoch"`
}
