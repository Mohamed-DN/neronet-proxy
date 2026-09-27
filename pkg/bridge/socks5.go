package bridge

import (
	"context"
	"crypto/subtle"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"strings"
	"sync"
	"syscall"
	"time"
)

const (
	SOCKS5Version               uint8 = 0x05
	SOCKS5AuthNone              uint8 = 0x00
	SOCKS5AuthUserPass          uint8 = 0x02
	SOCKS5CmdConnect            uint8 = 0x01
	SOCKS5AtypIPv4              uint8 = 0x01
	SOCKS5AtypDomain            uint8 = 0x03
	SOCKS5AtypIPv6              uint8 = 0x04
	SOCKS5RepSuccess            uint8 = 0x00
	SOCKS5RepFailure            uint8 = 0x01
	SOCKS5RepNotAllowed         uint8 = 0x02
	SOCKS5RepHostUnreachable    uint8 = 0x04
	SOCKS5RepConnRefused        uint8 = 0x05
	SOCKS5RepCmdNotSupported    uint8 = 0x07
	SOCKS5RepAtypNotSupported   uint8 = 0x08
	SOCKS5AuthNoAcceptable      uint8 = 0xFF
	socks5UserPassVersion       uint8 = 0x01
	socks5UserPassFailure       uint8 = 0x01
	socks5DialTimeout                 = 15 * time.Second
	socks5HandshakeReadDeadline       = 30 * time.Second
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

	// With credentials set, a client must authenticate with them (RFC 1929). Without,
	// no authentication is asked for; a username a client sends anyway is read as a
	// routing hint and its password is not checked.
	username string
	password string
}

// SetCredentials makes the proxy require this username and password.
func (s *SOCKS5Server) SetCredentials(username, password string) {
	s.username = username
	s.password = password
}

func (s *SOCKS5Server) requiresAuth() bool { return s.username != "" || s.password != "" }

func constantTimeEqual(a, b string) bool {
	return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
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
	// A client that opens a connection and says nothing does not hold a goroutine
	// forever. Cleared once the tunnel is up.
	_ = conn.SetDeadline(time.Now().Add(socks5HandshakeReadDeadline))

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

	hasUserPass, hasNone := false, false
	for _, m := range methods {
		switch m {
		case SOCKS5AuthUserPass:
			hasUserPass = true
		case SOCKS5AuthNone:
			hasNone = true
		}
	}

	switch {
	case s.requiresAuth() && !hasUserPass:
		// The client offers nothing this proxy accepts (RFC 1928, X'FF').
		_, _ = conn.Write([]byte{SOCKS5Version, SOCKS5AuthNoAcceptable})
		return
	case hasUserPass && (s.requiresAuth() || !hasNone):
		_, _ = conn.Write([]byte{SOCKS5Version, SOCKS5AuthUserPass})
		uname, passwd, ok := readUserPass(conn)
		if !ok {
			return
		}
		// The credentials used to be read and discarded: any username and password
		// were accepted.
		if s.requiresAuth() && !(constantTimeEqual(uname, s.username) && constantTimeEqual(passwd, s.password)) {
			_, _ = conn.Write([]byte{socks5UserPassVersion, socks5UserPassFailure})
			return
		}
		_, _ = conn.Write([]byte{socks5UserPassVersion, 0x00})
	case hasNone:
		_, _ = conn.Write([]byte{SOCKS5Version, SOCKS5AuthNone})
	default:
		_, _ = conn.Write([]byte{SOCKS5Version, SOCKS5AuthNoAcceptable})
		return
	}

	// 2. Request Details
	var reqHeader [4]byte
	if _, err := io.ReadFull(conn, reqHeader[:]); err != nil {
		return
	}

	if reqHeader[0] != SOCKS5Version || reqHeader[1] != SOCKS5CmdConnect {
		writeSOCKSReply(conn, SOCKS5RepCmdNotSupported, nil)
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
		writeSOCKSReply(conn, SOCKS5RepAtypNotSupported, nil)
		return
	}

	var portBytes [2]byte
	if _, err := io.ReadFull(conn, portBytes[:]); err != nil {
		return
	}
	targetPort := int(binary.BigEndian.Uint16(portBytes[:]))

	// Connect first, answer second. The success reply used to be sent before the
	// outbound dial, so a client was told it was connected to a destination that was
	// unreachable, refused or forbidden, and saw the stream close instead of an error.
	dialCtx, cancel := context.WithTimeout(context.Background(), socks5DialTimeout)
	outbound, err := s.bridge.Dial(dialCtx, targetHost, targetPort)
	cancel()
	if err != nil {
		writeSOCKSReply(conn, socksReplyFor(err), nil)
		return
	}

	_ = conn.SetDeadline(time.Time{})
	if !writeSOCKSReply(conn, SOCKS5RepSuccess, outbound.LocalAddr()) {
		outbound.Close()
		return
	}

	// 3. Forward stream to bridge
	_ = s.bridge.Pipe(context.Background(), conn, outbound)
}

func readUserPass(conn net.Conn) (string, string, bool) {
	var authVer [1]byte
	if _, err := io.ReadFull(conn, authVer[:]); err != nil || authVer[0] != socks5UserPassVersion {
		return "", "", false
	}
	var ulen [1]byte
	if _, err := io.ReadFull(conn, ulen[:]); err != nil {
		return "", "", false
	}
	uname := make([]byte, ulen[0])
	if _, err := io.ReadFull(conn, uname); err != nil {
		return "", "", false
	}
	var plen [1]byte
	if _, err := io.ReadFull(conn, plen[:]); err != nil {
		return "", "", false
	}
	passwd := make([]byte, plen[0])
	if _, err := io.ReadFull(conn, passwd); err != nil {
		return "", "", false
	}
	return string(uname), string(passwd), true
}

// socksReplyFor maps a failed dial to the RFC 1928 reply a client can act on.
func socksReplyFor(err error) uint8 {
	switch {
	case errors.Is(err, ErrEgressNotPermitted), errors.Is(err, ErrBogonIPBlocked), errors.Is(err, ErrAbusePortBlocked),
		errors.Is(err, ErrBatteryLowBlocked), errors.Is(err, ErrQuotaExceeded):
		return SOCKS5RepNotAllowed
	case errors.Is(err, ErrDNSLookupFailed), errors.Is(err, context.DeadlineExceeded):
		return SOCKS5RepHostUnreachable
	case errors.Is(err, syscall.ECONNREFUSED):
		return SOCKS5RepConnRefused
	}
	var netErr net.Error
	if errors.As(err, &netErr) && netErr.Timeout() {
		return SOCKS5RepHostUnreachable
	}
	return SOCKS5RepFailure
}

// writeSOCKSReply sends a reply with the bound address when there is one.
func writeSOCKSReply(conn net.Conn, rep uint8, bound net.Addr) bool {
	reply := []byte{SOCKS5Version, rep, 0x00, SOCKS5AtypIPv4, 0, 0, 0, 0, 0, 0}
	if tcp, ok := bound.(*net.TCPAddr); ok && tcp != nil {
		if ip4 := tcp.IP.To4(); ip4 != nil {
			copy(reply[4:8], ip4)
			binary.BigEndian.PutUint16(reply[8:10], uint16(tcp.Port))
		} else if ip16 := tcp.IP.To16(); ip16 != nil {
			reply = append([]byte{SOCKS5Version, rep, 0x00, SOCKS5AtypIPv6}, ip16...)
			reply = binary.BigEndian.AppendUint16(reply, uint16(tcp.Port))
		}
	}
	_, err := conn.Write(reply)
	return err == nil
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
