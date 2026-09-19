package routing

import (
	"crypto/rand"
	"encoding/binary"
	"errors"
	"fmt"
)

const (
	OnionCellFixedSize = 1420                                // Fixed cell size to neutralize size-based traffic analysis
	CellHeaderSize     = 4 + 1 + 3 + 4 + 2                   // 14 bytes: CircuitID (4) + Cmd (1) + StreamID (3) + Digest (4) + PayloadLen (2)
	MaxCellPayloadSize = OnionCellFixedSize - CellHeaderSize // 1406 bytes

	CellCmdCreate      uint8 = 0x01
	CellCmdCreated     uint8 = 0x02
	CellCmdRelayData   uint8 = 0x03
	CellCmdRelayExtend uint8 = 0x04
	CellCmdDestroy     uint8 = 0x05
)

var (
	ErrInvalidCellSize     = errors.New("onion cell size must be exactly 1420 bytes")
	ErrCellPayloadOverflow = errors.New("onion cell payload exceeds maximum capacity")
)

// OnionCell represents a constant-sized 1420-byte onion cell
type OnionCell struct {
	CircuitID uint32
	Command   uint8
	StreamID  uint32 // 24-bit
	Digest    uint32
	Payload   []byte // Layered ciphertext or command payload
}

// EncodeCell serializes an OnionCell into exactly 1420 bytes with cryptographic padding
func EncodeCell(cell *OnionCell) ([]byte, error) {
	if len(cell.Payload) > MaxCellPayloadSize {
		return nil, fmt.Errorf("%w: len %d, max %d", ErrCellPayloadOverflow, len(cell.Payload), MaxCellPayloadSize)
	}

	buf := make([]byte, OnionCellFixedSize)

	binary.BigEndian.PutUint32(buf[0:4], cell.CircuitID)
	buf[4] = cell.Command

	// 24-bit StreamID
	buf[5] = byte(cell.StreamID >> 16)
	buf[6] = byte(cell.StreamID >> 8)
	buf[7] = byte(cell.StreamID)

	binary.BigEndian.PutUint32(buf[8:12], cell.Digest)
	binary.BigEndian.PutUint16(buf[12:14], uint16(len(cell.Payload)))

	copy(buf[14:14+len(cell.Payload)], cell.Payload)

	// Fill remaining padding with pseudo-random bytes
	padLen := OnionCellFixedSize - (14 + len(cell.Payload))
	if padLen > 0 {
		_, _ = rand.Read(buf[14+len(cell.Payload):])
	}

	return buf, nil
}

// DecodeCell deserializes a 1420-byte buffer into an OnionCell
func DecodeCell(raw []byte) (*OnionCell, error) {
	if len(raw) != OnionCellFixedSize {
		return nil, fmt.Errorf("%w: got %d bytes", ErrInvalidCellSize, len(raw))
	}

	circuitID := binary.BigEndian.Uint32(raw[0:4])
	cmd := raw[4]
	streamID := uint32(raw[5])<<16 | uint32(raw[6])<<8 | uint32(raw[7])
	digest := binary.BigEndian.Uint32(raw[8:12])
	payloadLen := int(binary.BigEndian.Uint16(raw[12:14]))

	if payloadLen > MaxCellPayloadSize {
		return nil, ErrCellPayloadOverflow
	}

	payload := make([]byte, payloadLen)
	copy(payload, raw[14:14+payloadLen])

	return &OnionCell{
		CircuitID: circuitID,
		Command:   cmd,
		StreamID:  streamID,
		Digest:    digest,
		Payload:   payload,
	}, nil
}
