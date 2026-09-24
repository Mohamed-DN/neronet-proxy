package derp

import (
	"bytes"
	"testing"
)

func FuzzDecodeFrame(f *testing.F) {
	var src, dst [PubKeySize]byte
	src[0] = 0x01
	dst[0] = 0x02

	validSend := &Frame{
		Type:       FrameSendPacket,
		DestPubKey: dst,
		SrcPubKey:  src,
		Payload:    []byte("hello derp relay"),
	}
	encoded, err := EncodeFrame(validSend)
	if err == nil {
		f.Add(encoded)
	}

	validKeepAlive := &Frame{
		Type: FrameKeepAlive,
	}
	encodedKa, err := EncodeFrame(validKeepAlive)
	if err == nil {
		f.Add(encodedKa)
	}

	f.Add(make([]byte, 0))
	f.Add(make([]byte, FrameHeaderSize-1))
	f.Add(make([]byte, FrameHeaderSize))
	f.Add(bytes.Repeat([]byte{0xFF}, FrameHeaderSize+100))

	f.Fuzz(func(t *testing.T, data []byte) {
		frame, err := DecodeFrame(data)
		if err != nil {
			return
		}
		if len(frame.Payload) > MaxPayloadSize {
			t.Fatalf("decoded frame payload exceeds max size: %d", len(frame.Payload))
		}
	})
}
