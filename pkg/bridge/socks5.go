package bridge

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"strings"
	"sync"
)

const (
	SOCKS5Version       uint8 = 0x05
	SOCKS5AuthNone      uint8 = 0x00
	SOCKS5AuthUserPass  uint8 = 0x02
	SOCKS5CmdConnect    uint8 = 0x01
	SOCKS5AtypIPv4      uint8 = 0x01
	SOCKS5AtypDomain    uint8 = 0x03
	SOCKS5AtypIPv6      uint8 = 0x04
	SOCKS5RepSuccess    uint8 = 0x00
	SOCKS5RepNotAllowed uint8 = 0x02
	SOCKS5RepFailure    uint8 = 0x01
)

var (
	ErrUnsupportedSOCKSVersion = errors.New("unsupported SOCKS version")
	ErrUnsupportedCommand      = errors.New("unsupported SOCKS command: only CONNECT (0x01) is supported")
	ErrUnsupportedAddressType  = errors.New("unsupported SOCKS address type")
)

// RoutingIntent specifies target egress parameters requested via proxy credentials
type RoutingIntent struct {
	Mode        string // "DIRECT", "COUNTRY", "HOST", "ONION"
	TargetParam string // Country Code or Host ID
}

// SOCKS5Server handles inbound SOCKS5 proxy connections
type SOCKS5Server struct {
	mu         sync.Mutex
	listenAddr string
	listener   net.Listener
	bridge     *NetstackBridge
	closed     bool
}

// NewSOCKS5Server creates a new SOCKS5 proxy server
func NewSOCKS5Server(listenAddr string, bridge *NetstackBridge) *SOCKS5Server {
	return &SOCKS5Server{
		listenAddr: listenAddr,
		bridge:     bridge,
	}
}

// Start launches the SOCKS5 proxy listener
func (s *SOCKS5Server) Start() error {
	ln, err := net.Listen("tcp", s.listenAddr)
	if err != nil {
		return fmt.Errorf("failed to listen on SOCKS5 addr %s: %w", s.listenAddr, err)
	}

	s.listener = ln
	go s.serve()
	return nil
}

func (s *SOCKS5Server) serve() {
	for {
		conn, err := s.listener.Accept()
		if err != nil {
			if s.closed {
				return
			}
			continue
		}

		go s.handleConnection(conn)
	}
}

// ParseUserIntent extracts routing mode from proxy username (e.g. user-country-US, user-host-pk9a...)
func ParseUserIntent(username string) RoutingIntent {
	lower := strings.ToLower(username)
	if strings.HasPrefix(lower, "user-country-") {
		country := strings.ToUpper(strings.TrimPrefix(lower, "user-country-"))
		return RoutingIntent{Mode: "COUNTRY", TargetParam: country}
	} else if strings.HasPrefix(lower, "user-host-") {
		hostID := strings.TrimPrefix(lower, "user-host-")
		return RoutingIntent{Mode: "HOST", TargetParam: hostID}
	} else if strings.Contains(lower, "onion") {
		return RoutingIntent{Mode: "ONION", TargetParam: "3hop"}
	}
	return RoutingIntent{Mode: "DIRECT", TargetParam: ""}
}

func (s *SOCKS5Server) handleConnection(conn net.Conn) {
	defer conn.Close()

	// 1. Handshake & Auth Method Selection
	var header [2]byte
	if _, err := io.ReadFull(conn, header[:]); err != nil {
		return
	}

	if header[0] != SOCKS5Version {
		return
	}

	nMethods := int(header[1])
	methods := make([]byte, nMethods)
	if _, err := io.ReadFull(conn, methods); err != nil {
		return
	}

	// Prefer User/Pass if offered, else NoAuth
	hasUserPass := false
	for _, m := range methods {
		if m == SOCKS5AuthUserPass {
			hasUserPass = true
			break
		}
	}

	if hasUserPass {
		_, _ = conn.Write([]byte{SOCKS5Version, SOCKS5AuthUserPass})
		// Read UserPass Auth (RFC 1929)
		var authVer [1]byte
		if _, err := io.ReadFull(conn, authVer[:]); err != nil || authVer[0] != 0x01 {
			return
		}

		var ulen [1]byte
		if _, err := io.ReadFull(conn, ulen[:]); err != nil {
			return
		}
		uname := make([]byte, ulen[0])
		if _, err := io.ReadFull(conn, uname); err != nil {
			return
		}

		var plen [1]byte
		if _, err := io.ReadFull(conn, plen[:]); err != nil {
			return
		}
		passwd := make([]byte, plen[0])
		if _, err := io.ReadFull(conn, passwd); err != nil {
			return
		}

		// Auth success
		_, _ = conn.Write([]byte{0x01, 0x00})
	} else {
		_, _ = conn.Write([]byte{SOCKS5Version, SOCKS5AuthNone})
	}

	// 2. Request Details
	var reqHeader [4]byte
	if _, err := io.ReadFull(conn, reqHeader[:]); err != nil {
		return
	}

	if reqHeader[0] != SOCKS5Version || reqHeader[1] != SOCKS5CmdConnect {
		_, _ = conn.Write([]byte{SOCKS5Version, SOCKS5RepNotAllowed, 0x00, SOCKS5AtypIPv4, 0, 0, 0, 0, 0, 0})
		return
	}

	var targetHost string
	atyp := reqHeader[3]

	switch atyp {
	case SOCKS5AtypIPv4:
		var ip [4]byte
		if _, err := io.ReadFull(conn, ip[:]); err != nil {
			return
		}
		targetHost = net.IP(ip[:]).String()
	case SOCKS5AtypDomain:
		var domainLen [1]byte
		if _, err := io.ReadFull(conn, domainLen[:]); err != nil {
			return
		}
		domain := make([]byte, domainLen[0])
		if _, err := io.ReadFull(conn, domain); err != nil {
			return
		}
		targetHost = string(domain)
	case SOCKS5AtypIPv6:
		var ip [16]byte
		if _, err := io.ReadFull(conn, ip[:]); err != nil {
			return
		}
		targetHost = net.IP(ip[:]).String()
	default:
		_, _ = conn.Write([]byte{SOCKS5Version, SOCKS5RepNotAllowed, 0x00, SOCKS5AtypIPv4, 0, 0, 0, 0, 0, 0})
		return
	}

	var portBytes [2]byte
	if _, err := io.ReadFull(conn, portBytes[:]); err != nil {
		return
	}
	targetPort := int(binary.BigEndian.Uint16(portBytes[:]))

	// Acknowledge connection success to client
	resp := []byte{SOCKS5Version, SOCKS5RepSuccess, 0x00, SOCKS5AtypIPv4, 127, 0, 0, 1, 0x04, 0x38}
	if _, err := conn.Write(resp); err != nil {
		return
	}

	// 3. Forward stream to bridge
	_ = s.bridge.DialAndPipe(context.Background(), conn, targetHost, targetPort)
}

// Addr returns the listening address
func (s *SOCKS5Server) Addr() net.Addr {
	if s.listener != nil {
		return s.listener.Addr()
	}
	return nil
}

// Close terminates the SOCKS5 server
func (s *SOCKS5Server) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.closed = true
	if s.listener != nil {
		return s.listener.Close()
	}
	return nil
}
