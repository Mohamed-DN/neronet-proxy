package routing

import (
	"bytes"
	"testing"

	"github.com/sovereign/proxy/v4/pkg/crypto"
)

func FuzzDecodeCell(f *testing.F) {
	validCell := &OnionCell{
		CircuitID: 1001,
		Command:   CellCmdRelayData,
		StreamID:  42,
		Digest:    0x12345678,
		Payload:   []byte("test payload for onion cell"),
	}
	encoded, err := EncodeCell(validCell)
	if err == nil {
		f.Add(encoded)
	}

	f.Add(make([]byte, 1420))
	f.Add(make([]byte, 0))
	f.Add(make([]byte, 10))
	f.Add(make([]byte, 1419))
	f.Add(make([]byte, 1421))
	f.Add(bytes.Repeat([]byte{0xFF}, 1420))

	f.Fuzz(func(t *testing.T, data []byte) {
		cell, err := DecodeCell(data)
		if err != nil {
			return
		}
		if len(cell.Payload) > MaxCellPayloadSize {
			t.Fatalf("decoded cell payload exceeds MaxCellPayloadSize: %d", len(cell.Payload))
		}
	})
}

func FuzzPeelLayer(f *testing.F) {
	var privKey [crypto.KeySize]byte
	privKey[0] = 0x42

	f.Add(privKey[:], 1, []byte("short"))
	f.Add(privKey[:], 2, bytes.Repeat([]byte{0xAA}, 100))
	f.Add(privKey[:], 3, bytes.Repeat([]byte{0x55}, 1420))

	f.Fuzz(func(t *testing.T, keyBytes []byte, layerIndex int, payload []byte) {
		if len(keyBytes) != crypto.KeySize {
			return
		}
		var key [crypto.KeySize]byte
		copy(key[:], keyBytes)

		_, _ = PeelLayer(key, layerIndex, payload)
	})
}
