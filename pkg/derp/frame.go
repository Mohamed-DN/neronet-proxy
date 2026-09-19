package derp

import (
	"errors"
	"fmt"
	"sync"
)

const (
	PubKeySize = 32

	FrameClientInfo uint8 = 0x10
	FrameSendPacket uint8 = 0x11
	FrameRecvPacket uint8 = 0x12
	FrameKeepAlive  uint8 = 0x13
	FramePeerGone   uint8 = 0x14

	FrameHeaderSize = 1 + 3 + PubKeySize + PubKeySize // 68 bytes
	MaxPayloadSize  = 65535
)

var (
	ErrFrameTooSmall    = errors.New("derp frame too small")
	ErrPayloadTooLarge  = errors.New("derp frame payload exceeds max size")
	ErrUnknownFrameType = errors.New("unknown derp frame type")
)

// Frame represents a DERP-v4 packet frame
type Frame struct {
	Type       uint8
	DestPubKey [PubKeySize]byte
	SrcPubKey  [PubKeySize]byte
	Payload    []byte
}

var framePool = sync.Pool{
	New: func() interface{} {
		return make([]byte, FrameHeaderSize+MaxPayloadSize)
	},
}

// EncodeFrame serializes a DERP Frame into wire bytes
func EncodeFrame(f *Frame) ([]byte, error) {
	payloadLen := len(f.Payload)
	if payloadLen > MaxPayloadSize {
		return nil, ErrPayloadTooLarge
	}

	totalLen := FrameHeaderSize + payloadLen
	buf := make([]byte, totalLen)

	buf[0] = f.Type
	// 24-bit payload length
	buf[1] = byte(payloadLen >> 16)
	buf[2] = byte(payloadLen >> 8)
	buf[3] = byte(payloadLen)

	copy(buf[4:36], f.DestPubKey[:])
	copy(buf[36:68], f.SrcPubKey[:])
	copy(buf[68:], f.Payload)

	return buf, nil
}

// DecodeFrame deserializes raw bytes into a DERP Frame
func DecodeFrame(raw []byte) (*Frame, error) {
	if len(raw) < FrameHeaderSize {
		return nil, ErrFrameTooSmall
	}

	frameType := raw[0]
	payloadLen := int(raw[1])<<16 | int(raw[2])<<8 | int(raw[3])

	if len(raw) < FrameHeaderSize+payloadLen {
		return nil, fmt.Errorf("%w: expected %d bytes, got %d", ErrFrameTooSmall, FrameHeaderSize+payloadLen, len(raw))
	}

	var destPub [PubKeySize]byte
	var srcPub [PubKeySize]byte
	copy(destPub[:], raw[4:36])
	copy(srcPub[:], raw[36:68])

	payload := make([]byte, payloadLen)
	copy(payload, raw[68:68+payloadLen])

	return &Frame{
		Type:       frameType,
		DestPubKey: destPub,
		SrcPubKey:  srcPub,
		Payload:    payload,
	}, nil
}
