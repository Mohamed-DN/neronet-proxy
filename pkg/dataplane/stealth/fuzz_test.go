package stealth

import (
	"bytes"
	"testing"
)

func FuzzObfuscator(f *testing.F) {
	cfg := DefaultConfig()
	obf, err := NewObfuscator(cfg)
	if err != nil {
		f.Fatalf("failed to create default obfuscator: %v", err)
	}

	initPkt := make([]byte, SizeMessageInitiation)
	initPkt[0] = TypeMessageInitiation
	f.Add(initPkt)

	respPkt := make([]byte, SizeMessageResponse)
	respPkt[0] = TypeMessageResponse
	f.Add(respPkt)

	dataPkt := make([]byte, MinMessageData+50)
	dataPkt[0] = TypeMessageData
	f.Add(dataPkt)

	f.Add(make([]byte, 0))
	f.Add(make([]byte, 3))
	f.Add(make([]byte, 4))
	f.Add(bytes.Repeat([]byte{0xDE, 0xAD, 0xBE, 0xEF}, 32))

	f.Fuzz(func(t *testing.T, data []byte) {
		wrapped := obf.Wrap(data)
		_, _ = obf.Unwrap(wrapped)
		_, _ = obf.Unwrap(data)
	})
}
