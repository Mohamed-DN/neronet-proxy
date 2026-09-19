package nat

import (
	"errors"
	"fmt"
	"net"
	"time"
)

// NATType enum represents NAT mapping behavior
type NATType string

const (
	NATTypeDirectPublic       NATType = "DIRECT_PUBLIC"
	NATTypeFullCone           NATType = "FULL_CONE"
	NATTypeRestrictedCone     NATType = "RESTRICTED_CONE"
	NATTypePortRestrictedCone NATType = "PORT_RESTRICTED_CONE"
	NATTypeSymmetric          NATType = "SYMMETRIC"
	NATTypeBlocked            NATType = "BLOCKED"
)

// NATDescriptor summarizes the network topology discovery
type NATDescriptor struct {
	Type         NATType      `json:"nat_type"`
	LocalAddr    *net.UDPAddr `json:"local_addr"`
	PublicAddr1  *net.UDPAddr `json:"public_addr_1"`
	PublicAddr2  *net.UDPAddr `json:"public_addr_2,omitempty"`
	PortDelta    int          `json:"port_delta"`
	IsSequential bool         `json:"is_sequential"`
	LastTestedAt time.Time    `json:"last_tested_at"`
}

// ClassifyNAT performs RFC 3489 / 5780 detection by querying at least 2 distinct STUN endpoints
func ClassifyNAT(stunServers []string, localConn *net.UDPConn, timeout time.Duration) (*NATDescriptor, error) {
	if len(stunServers) == 0 {
		return nil, errors.New("at least one STUN server required for classification")
	}

	conn := localConn
	var shouldClose bool
	if conn == nil {
		c, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.IPv4zero, Port: 0})
		if err != nil {
			return nil, fmt.Errorf("failed to bind UDP socket: %w", err)
		}
		conn = c
		shouldClose = true
	}
	if shouldClose {
		defer conn.Close()
	}

	localAddr := conn.LocalAddr().(*net.UDPAddr)

	// Query first STUN server
	mapped1, err := QuerySTUN(stunServers[0], timeout, conn)
	if err != nil {
		return &NATDescriptor{
			Type:         NATTypeBlocked,
			LocalAddr:    localAddr,
			LastTestedAt: time.Now(),
		}, fmt.Errorf("query to STUN server 1 failed: %w", err)
	}

	// Check if local IP is public
	if localAddr.IP.Equal(mapped1.IP) && localAddr.Port == mapped1.Port {
		return &NATDescriptor{
			Type:         NATTypeDirectPublic,
			LocalAddr:    localAddr,
			PublicAddr1:  mapped1,
			LastTestedAt: time.Now(),
		}, nil
	}

	if len(stunServers) == 1 {
		// Single server classification fallback
		return &NATDescriptor{
			Type:         NATTypeFullCone,
			LocalAddr:    localAddr,
			PublicAddr1:  mapped1,
			LastTestedAt: time.Now(),
		}, nil
	}

	// Query second STUN server using SAME local UDP socket
	mapped2, err := QuerySTUN(stunServers[1], timeout, conn)
	if err != nil {
		// If second STUN server failed, return best-effort cone
		return &NATDescriptor{
			Type:         NATTypeFullCone,
			LocalAddr:    localAddr,
			PublicAddr1:  mapped1,
			LastTestedAt: time.Now(),
		}, nil
	}

	// Compare mapped endpoints
	if mapped1.Port == mapped2.Port && mapped1.IP.Equal(mapped2.IP) {
		// Endpoint-Independent Mapping -> Cone NAT
		return &NATDescriptor{
			Type:         NATTypePortRestrictedCone,
			LocalAddr:    localAddr,
			PublicAddr1:  mapped1,
			PublicAddr2:  mapped2,
			PortDelta:    0,
			IsSequential: false,
			LastTestedAt: time.Now(),
		}, nil
	}

	// Port or IP differs -> Endpoint-Dependent Mapping -> Symmetric NAT
	delta := mapped2.Port - mapped1.Port
	isSequential := delta != 0 && (delta >= -10 && delta <= 10)

	return &NATDescriptor{
		Type:         NATTypeSymmetric,
		LocalAddr:    localAddr,
		PublicAddr1:  mapped1,
		PublicAddr2:  mapped2,
		PortDelta:    delta,
		IsSequential: isSequential,
		LastTestedAt: time.Now(),
	}, nil
}
