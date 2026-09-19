package crypto

import (
	"encoding/binary"
	"errors"
	"fmt"
)

// Magic constants for SovereignMesh Direct Wire Frames
const (
	DirectFrameMagic   uint32 = 0x5356524E // "SVRN"
	CurrentWireVersion uint8  = 0x04       // Version 4.0
	HeaderSize                = 18         // Magic (4) + Version (1) + MsgType (1) + SenderID (4) + ReceiverID (4) + Reserved (4)
	Poly1305TagSize           = 16
	CounterSize               = 8
	MinDirectFrameSize        = 4 + 1 + 1 + 4 + 4 + 8 + Poly1305TagSize // 38 bytes
)

// Message Type constants
const (
	MsgTypeHandshakeAct1   uint8 = 0x01
	MsgTypeHandshakeAct2   uint8 = 0x02
	MsgTypeRekeyInitiate   uint8 = 0x03
	MsgTypeRekeyResponse   uint8 = 0x04
	MsgTypeTransportData   uint8 = 0x05
	MsgTypeDiscoPing       uint8 = 0x06
	MsgTypeDiscoPong       uint8 = 0x07
	MsgTypeCircuitTeardown uint8 = 0x08
)

var (
	ErrInvalidMagic       = errors.New("invalid frame magic: expected SVRN")
	ErrUnsupportedVersion = errors.New("unsupported wire version")
	ErrFrameTooShort      = errors.New("frame data is too short")
	ErrPayloadCorrupted   = errors.New("payload authentication tag verification failed")
)

// DirectFrame represents a parsed SovereignMesh UDP Direct Wire Frame
type DirectFrame struct {
	Magic             uint32
	Version           uint8
	MsgType           uint8
	SenderSessionID   uint32
	ReceiverSessionID uint32
	SequenceCounter   uint64
	Ciphertext        []byte
	AuthTag           [Poly1305TagSize]byte
}

// EncodeDirectFrame serializes a DirectFrame into wire format.
// Layout:
// [Magic: 4B] [Version: 1B] [MsgType: 1B] [SenderID: 4B] [ReceiverID: 4B]
// [SequenceCounter: 8B] [Ciphertext: N-B] [AuthTag: 16B]
func EncodeDirectFrame(frame *DirectFrame) []byte {
	totalLen := 4 + 1 + 1 + 4 + 4 + 8 + len(frame.Ciphertext) + Poly1305TagSize
	buf := make([]byte, totalLen)

	binary.BigEndian.PutUint32(buf[0:4], frame.Magic)
	buf[4] = frame.Version
	buf[5] = frame.MsgType
	binary.BigEndian.PutUint32(buf[6:10], frame.SenderSessionID)
	binary.BigEndian.PutUint32(buf[10:14], frame.ReceiverSessionID)
	binary.BigEndian.PutUint64(buf[14:22], frame.SequenceCounter)

	copy(buf[22:22+len(frame.Ciphertext)], frame.Ciphertext)
	copy(buf[22+len(frame.Ciphertext):], frame.AuthTag[:])

	return buf
}

// DecodeDirectFrame parses raw wire bytes into a DirectFrame.
func DecodeDirectFrame(raw []byte) (*DirectFrame, error) {
	if len(raw) < MinDirectFrameSize {
		return nil, fmt.Errorf("%w: got %d bytes, min %d", ErrFrameTooShort, len(raw), MinDirectFrameSize)
	}

	magic := binary.BigEndian.Uint32(raw[0:4])
	if magic != DirectFrameMagic {
		return nil, fmt.Errorf("%w: 0x%08X", ErrInvalidMagic, magic)
	}

	version := raw[4]
	if version != CurrentWireVersion {
		return nil, fmt.Errorf("%w: version %d", ErrUnsupportedVersion, version)
	}

	msgType := raw[5]
	senderID := binary.BigEndian.Uint32(raw[6:10])
	receiverID := binary.BigEndian.Uint32(raw[10:14])
	seqCounter := binary.BigEndian.Uint64(raw[14:22])

	ciphertextLen := len(raw) - 22 - Poly1305TagSize
	ciphertext := make([]byte, ciphertextLen)
	copy(ciphertext, raw[22:22+ciphertextLen])

	var authTag [Poly1305TagSize]byte
	copy(authTag[:], raw[22+ciphertextLen:])

	return &DirectFrame{
		Magic:             magic,
		Version:           version,
		MsgType:           msgType,
		SenderSessionID:   senderID,
		ReceiverSessionID: receiverID,
		SequenceCounter:   seqCounter,
		Ciphertext:        ciphertext,
		AuthTag:           authTag,
	}, nil
}
