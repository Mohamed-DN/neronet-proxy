package nat

import (
	"crypto/rand"
	"encoding/binary"
	"errors"
	"fmt"
	"net"
	"time"
)

const (
	STUNMagicCookie      uint32 = 0x2112A442
	STUNHeaderSize              = 20
	STUNBindingRequest   uint16 = 0x0001
	STUNBindingResponse  uint16 = 0x0101
	AttrMappedAddress    uint16 = 0x0001
	AttrXORMappedAddress uint16 = 0x0020
	AttrSoftware         uint16 = 0x0022
	AttrFingerprint      uint16 = 0x8028
	FamilyIPv4           uint8  = 0x01
	FamilyIPv6           uint8  = 0x02
)

var (
	ErrInvalidSTUNHeader = errors.New("invalid STUN header or magic cookie")
	ErrSTUNTimeout       = errors.New("STUN request timed out")
	ErrAttributeNotFound = errors.New("required STUN attribute not found in response")
)

// STUNMessage represents an RFC 5389/8489 STUN packet
type STUNMessage struct {
	Type          uint16
	Length        uint16
	MagicCookie   uint32
	TransactionID [12]byte
	Attributes    map[uint16][]byte
}

// NewSTUNBindingRequest creates a new Binding Request with a randomized Transaction ID
func NewSTUNBindingRequest() (*STUNMessage, error) {
	var txID [12]byte
	if _, err := rand.Read(txID[:]); err != nil {
		return nil, fmt.Errorf("failed to generate STUN transaction ID: %w", err)
	}

	return &STUNMessage{
		Type:          STUNBindingRequest,
		Length:        0,
		MagicCookie:   STUNMagicCookie,
		TransactionID: txID,
		Attributes:    make(map[uint16][]byte),
	}, nil
}

// Encode converts the STUN message to wire format bytes
func (m *STUNMessage) Encode() []byte {
	attrBytes := make([]byte, 0, 128)
	for attrType, attrVal := range m.Attributes {
		var header [4]byte
		binary.BigEndian.PutUint16(header[0:2], attrType)
		binary.BigEndian.PutUint16(header[2:4], uint16(len(attrVal)))
		attrBytes = append(attrBytes, header[:]...)
		attrBytes = append(attrBytes, attrVal...)

		// 4-byte boundary padding
		pad := (4 - (len(attrVal) % 4)) % 4
		for p := 0; p < pad; p++ {
			attrBytes = append(attrBytes, 0x00)
		}
	}

	totalLen := STUNHeaderSize + len(attrBytes)
	buf := make([]byte, totalLen)

	binary.BigEndian.PutUint16(buf[0:2], m.Type)
	binary.BigEndian.PutUint16(buf[2:4], uint16(len(attrBytes)))
	binary.BigEndian.PutUint32(buf[4:8], m.MagicCookie)
	copy(buf[8:20], m.TransactionID[:])
	copy(buf[20:], attrBytes)

	return buf
}

// DecodeSTUN parses raw bytes into a STUNMessage
func DecodeSTUN(raw []byte) (*STUNMessage, error) {
	if len(raw) < STUNHeaderSize {
		return nil, ErrInvalidSTUNHeader
	}

	msgType := binary.BigEndian.Uint16(raw[0:2])
	length := binary.BigEndian.Uint16(raw[2:4])
	magic := binary.BigEndian.Uint32(raw[4:8])

	if magic != STUNMagicCookie {
		return nil, ErrInvalidSTUNHeader
	}

	var txID [12]byte
	copy(txID[:], raw[8:20])

	if len(raw) < STUNHeaderSize+int(length) {
		return nil, ErrInvalidSTUNHeader
	}

	attrs := make(map[uint16][]byte)
	offset := STUNHeaderSize
	end := STUNHeaderSize + int(length)

	for offset+4 <= end {
		attrType := binary.BigEndian.Uint16(raw[offset : offset+2])
		attrLen := int(binary.BigEndian.Uint16(raw[offset+2 : offset+4]))
		offset += 4

		if offset+attrLen > end {
			break
		}

		val := make([]byte, attrLen)
		copy(val, raw[offset:offset+attrLen])
		attrs[attrType] = val

		// Advance with padding
		pad := (4 - (attrLen % 4)) % 4
		offset += attrLen + pad
	}

	return &STUNMessage{
		Type:          msgType,
		Length:        length,
		MagicCookie:   magic,
		TransactionID: txID,
		Attributes:    attrs,
	}, nil
}

// GetXORMappedAddress extracts the IP and Port from XOR-MAPPED-ADDRESS attribute
func (m *STUNMessage) GetXORMappedAddress() (*net.UDPAddr, error) {
	attr, ok := m.Attributes[AttrXORMappedAddress]
	if !ok {
		// Fallback to MAPPED-ADDRESS if XOR not present
		if mapAttr, ok2 := m.Attributes[AttrMappedAddress]; ok2 && len(mapAttr) >= 8 {
			family := mapAttr[1]
			port := binary.BigEndian.Uint16(mapAttr[2:4])
			if family == FamilyIPv4 {
				ip := net.IPv4(mapAttr[4], mapAttr[5], mapAttr[6], mapAttr[7])
				return &net.UDPAddr{IP: ip, Port: int(port)}, nil
			}
		}
		return nil, ErrAttributeNotFound
	}

	if len(attr) < 8 {
		return nil, ErrInvalidSTUNHeader
	}

	family := attr[1]
	xport := binary.BigEndian.Uint16(attr[2:4])
	port := xport ^ uint16(STUNMagicCookie>>16)

	if family == FamilyIPv4 {
		xip := binary.BigEndian.Uint32(attr[4:8])
		ipInt := xip ^ STUNMagicCookie
		ip := net.IPv4(byte(ipInt>>24), byte(ipInt>>16), byte(ipInt>>8), byte(ipInt))
		return &net.UDPAddr{IP: ip, Port: int(port)}, nil
	} else if family == FamilyIPv6 && len(attr) >= 20 {
		var ipBytes [16]byte
		var cookieAndTx [16]byte
		binary.BigEndian.PutUint32(cookieAndTx[0:4], STUNMagicCookie)
		copy(cookieAndTx[4:16], m.TransactionID[:])

		for i := 0; i < 16; i++ {
			ipBytes[i] = attr[4+i] ^ cookieAndTx[i]
		}
		return &net.UDPAddr{IP: net.IP(ipBytes[:]), Port: int(port)}, nil
	}

	return nil, errors.New("unsupported IP family in STUN response")
}

// SetXORMappedAddress encodes an IP:Port into XOR-MAPPED-ADDRESS attribute
func (m *STUNMessage) SetXORMappedAddress(addr *net.UDPAddr) {
	ip4 := addr.IP.To4()
	if ip4 != nil {
		buf := make([]byte, 8)
		buf[0] = 0x00
		buf[1] = FamilyIPv4
		xport := uint16(addr.Port) ^ uint16(STUNMagicCookie>>16)
		binary.BigEndian.PutUint16(buf[2:4], xport)

		ipInt := binary.BigEndian.Uint32(ip4)
		xip := ipInt ^ STUNMagicCookie
		binary.BigEndian.PutUint32(buf[4:8], xip)

		m.Attributes[AttrXORMappedAddress] = buf
	}
}

// QuerySTUN sends a STUN Binding Request to the target STUN server and returns the mapped public address
func QuerySTUN(serverAddr string, timeout time.Duration, existingConn *net.UDPConn) (*net.UDPAddr, error) {
	raddr, err := net.ResolveUDPAddr("udp", serverAddr)
	if err != nil {
		return nil, fmt.Errorf("failed to resolve STUN server addr %s: %w", serverAddr, err)
	}

	conn := existingConn
	var shouldClose bool
	if conn == nil {
		c, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.IPv4zero, Port: 0})
		if err != nil {
			return nil, fmt.Errorf("failed to bind local UDP socket: %w", err)
		}
		conn = c
		shouldClose = true
	}
	if shouldClose {
		defer conn.Close()
	}

	req, err := NewSTUNBindingRequest()
	if err != nil {
		return nil, err
	}

	reqBytes := req.Encode()
	if _, err := conn.WriteToUDP(reqBytes, raddr); err != nil {
		return nil, fmt.Errorf("failed to write STUN request: %w", err)
	}

	conn.SetReadDeadline(time.Now().Add(timeout))
	buf := make([]byte, 1024)

	for {
		n, from, err := conn.ReadFromUDP(buf)
		if err != nil {
			return nil, ErrSTUNTimeout
		}

		if from.IP.Equal(raddr.IP) || from.Port == raddr.Port {
			resp, err := DecodeSTUN(buf[:n])
			if err != nil {
				continue
			}

			if resp.Type == STUNBindingResponse && resp.TransactionID == req.TransactionID {
				return resp.GetXORMappedAddress()
			}
		}
	}
}

// STUNServer provides an integrated lightweight STUN reflection responder
type STUNServer struct {
	conn   *net.UDPConn
	closed bool
}

// StartSTUNServer launches a STUN responder on the given bind address
func StartSTUNServer(bindAddr string) (*STUNServer, error) {
	laddr, err := net.ResolveUDPAddr("udp", bindAddr)
	if err != nil {
		return nil, err
	}

	conn, err := net.ListenUDP("udp", laddr)
	if err != nil {
		return nil, err
	}

	server := &STUNServer{conn: conn}
	go server.serve()
	return server, nil
}

func (s *STUNServer) serve() {
	buf := make([]byte, 2048)
	for {
		n, remoteAddr, err := s.conn.ReadFromUDP(buf)
		if err != nil {
			if s.closed {
				return
			}
			continue
		}

		msg, err := DecodeSTUN(buf[:n])
		if err != nil || msg.Type != STUNBindingRequest {
			continue
		}

		// Create Binding Success Response
		resp := &STUNMessage{
			Type:          STUNBindingResponse,
			MagicCookie:   STUNMagicCookie,
			TransactionID: msg.TransactionID,
			Attributes:    make(map[uint16][]byte),
		}
		resp.SetXORMappedAddress(remoteAddr)
		resp.Attributes[AttrSoftware] = []byte("NeroNet-STUN-v4")

		respBytes := resp.Encode()
		_, _ = s.conn.WriteToUDP(respBytes, remoteAddr)
	}
}

// Addr returns the local listening UDP address
func (s *STUNServer) Addr() *net.UDPAddr {
	return s.conn.LocalAddr().(*net.UDPAddr)
}

// Close terminates the STUN server listener
func (s *STUNServer) Close() error {
	s.closed = true
	return s.conn.Close()
}
