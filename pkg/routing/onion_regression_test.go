package routing

import (
	"bytes"
	"encoding/binary"
	"errors"
	"testing"

	"github.com/sovereign/proxy/v4/pkg/crypto"
)

// buildTestCircuit returns a circuit plus the three hop keypairs held by the relays.
func buildTestCircuit(t *testing.T) (*OnionCircuit, [3]*crypto.Keypair) {
	t.Helper()

	var kps [3]*crypto.Keypair
	var hops [3]*OnionHop
	for i := range kps {
		kp, err := crypto.GenerateKeypair()
		if err != nil {
			t.Fatalf("GenerateKeypair hop %d: %v", i, err)
		}
		kps[i] = kp
		hops[i] = &OnionHop{HopIndex: i, NodeID: "hop", PublicKey: kp.PublicKey}
	}

	circuit, err := Build3HopCircuit(0xABCD1234, hops[0], hops[1], hops[2])
	if err != nil {
		t.Fatalf("Build3HopCircuit: %v", err)
	}

	return circuit, kps
}

// layerNonce extracts the nonce from a layer payload's cleartext header.
func layerNonce(payload []byte) []byte {
	return payload[crypto.KeySize:layerHeaderSize]
}

// layerEphPub extracts the ephemeral public key from a layer payload's cleartext header.
func layerEphPub(payload []byte) []byte {
	return payload[0:crypto.KeySize]
}

// TestNonceNeverRepeatsAcrossCells is the regression test for the nonce reuse defect.
//
// The original implementation derived every hop key once at circuit construction and
// then sealed every cell with ConstructNonce(0). Reusing an (key, nonce) pair under
// ChaCha20-Poly1305 leaks the XOR of the plaintexts and exposes the Poly1305 key,
// which costs both confidentiality and integrity. One cell is never enough to catch
// this: the test has to send several over the same circuit.
func TestNonceNeverRepeatsAcrossCells(t *testing.T) {
	circuit, kps := buildTestCircuit(t)

	const cellCount = 256
	seen := make(map[string]int, cellCount*3)

	for i := 0; i < cellCount; i++ {
		raw, err := circuit.EncryptLayeredData(uint32(i), "1.1.1.1:443", []byte("identical payload"))
		if err != nil {
			t.Fatalf("EncryptLayeredData cell %d: %v", i, err)
		}

		cell, err := DecodeCell(raw)
		if err != nil {
			t.Fatalf("DecodeCell cell %d: %v", i, err)
		}

		// Walk the three layers, collecting every nonce that travels on the wire.
		payload := cell.Payload
		for layer := 1; layer <= 3; layer++ {
			nonce := string(layerNonce(payload))
			if prev, dup := seen[nonce]; dup {
				t.Fatalf("nonce reused: cell %d layer %d repeats a nonce first seen at index %d", i, layer, prev)
			}
			seen[nonce] = i

			res, err := PeelLayer(kps[layer-1].PrivateKey, layer, payload)
			if err != nil {
				t.Fatalf("PeelLayer cell %d layer %d: %v", i, layer, err)
			}
			if res.IsExit {
				break
			}
			payload = res.InnerPayload
		}
	}

	if len(seen) != cellCount*3 {
		t.Fatalf("expected %d distinct nonces, collected %d", cellCount*3, len(seen))
	}
}

// TestIdenticalPayloadsProduceDifferentCiphertext catches keystream reuse directly.
//
// With a fixed nonce, sealing the same plaintext twice under the same key produces
// byte-identical ciphertext, which is itself an observable leak.
func TestIdenticalPayloadsProduceDifferentCiphertext(t *testing.T) {
	circuit, _ := buildTestCircuit(t)

	payload := []byte("the same secret, twice")

	rawA, err := circuit.EncryptLayeredData(7, "example.com:443", payload)
	if err != nil {
		t.Fatalf("first EncryptLayeredData: %v", err)
	}
	rawB, err := circuit.EncryptLayeredData(7, "example.com:443", payload)
	if err != nil {
		t.Fatalf("second EncryptLayeredData: %v", err)
	}

	cellA, err := DecodeCell(rawA)
	if err != nil {
		t.Fatalf("DecodeCell A: %v", err)
	}
	cellB, err := DecodeCell(rawB)
	if err != nil {
		t.Fatalf("DecodeCell B: %v", err)
	}

	ctA := cellA.Payload[layerHeaderSize:]
	ctB := cellB.Payload[layerHeaderSize:]

	if bytes.Equal(ctA, ctB) {
		t.Fatal("identical plaintexts produced identical ciphertext: the nonce is not varying")
	}
}

// TestEntryAndExitShareNoIdentifier is the regression test for the linkability defect.
//
// The original implementation carried one client ephemeral public key through the
// whole circuit and re-prefixed it at each hop, so the entry and exit relays observed
// the same 32-byte value. An adversary holding both ends could correlate traffic by
// simple equality, which is precisely what onion routing is supposed to prevent.
func TestEntryAndExitShareNoIdentifier(t *testing.T) {
	circuit, kps := buildTestCircuit(t)

	raw, err := circuit.EncryptLayeredData(1, "10.0.0.1:80", []byte("payload"))
	if err != nil {
		t.Fatalf("EncryptLayeredData: %v", err)
	}
	cell, err := DecodeCell(raw)
	if err != nil {
		t.Fatalf("DecodeCell: %v", err)
	}

	// What the entry relay can see: its own layer header, and the layer it hands on.
	entryLayer := cell.Payload
	entryVisible := [][]byte{layerEphPub(entryLayer), layerNonce(entryLayer)}

	peel1, err := PeelLayer(kps[0].PrivateKey, 1, entryLayer)
	if err != nil {
		t.Fatalf("PeelLayer entry: %v", err)
	}
	entryVisible = append(entryVisible, layerEphPub(peel1.InnerPayload), layerNonce(peel1.InnerPayload))

	// What the exit relay can see.
	peel2, err := PeelLayer(kps[1].PrivateKey, 2, peel1.InnerPayload)
	if err != nil {
		t.Fatalf("PeelLayer intermediate: %v", err)
	}
	exitLayer := peel2.InnerPayload
	exitVisible := [][]byte{layerEphPub(exitLayer), layerNonce(exitLayer)}

	for _, e := range entryVisible {
		for _, x := range exitVisible {
			if bytes.Equal(e, x) {
				t.Fatalf("entry and exit relays both observe the same %d-byte value: circuit is linkable", len(e))
			}
		}
	}

	// Sanity: the circuit still delivers the payload end to end.
	peel3, err := PeelLayer(kps[2].PrivateKey, 3, exitLayer)
	if err != nil {
		t.Fatalf("PeelLayer exit: %v", err)
	}
	if !peel3.IsExit || peel3.TargetAddr != "10.0.0.1:80" || string(peel3.InnerPayload) != "payload" {
		t.Fatalf("exit layer did not round-trip: %+v", peel3)
	}
}

// TestPeelLayerRejectsOverrunLengths is the regression test for the unchecked slice
// bounds in the exit layer parser.
//
// The forged cell below carries a valid authentication tag -- built with the hop's
// real derived key -- so it reaches the parser exactly as a malicious relay could
// deliver it. The old parser sliced on the declared length without checking it and
// panicked, taking down the relay process rather than dropping one cell.
func TestPeelLayerRejectsOverrunLengths(t *testing.T) {
	hopKP, err := crypto.GenerateKeypair()
	if err != nil {
		t.Fatalf("GenerateKeypair: %v", err)
	}
	ephKP, err := crypto.GenerateKeypair()
	if err != nil {
		t.Fatalf("GenerateKeypair ephemeral: %v", err)
	}

	dh, err := crypto.DH(ephKP.PrivateKey, hopKP.PublicKey)
	if err != nil {
		t.Fatalf("DH: %v", err)
	}
	key, err := deriveHopKey(dh, 2) // layer 3 == hop index 2
	if err != nil {
		t.Fatalf("deriveHopKey: %v", err)
	}

	cases := []struct {
		name      string
		plaintext []byte
	}{
		{
			name: "target length overruns buffer",
			plaintext: func() []byte {
				p := make([]byte, 3+4)
				p[0] = 0x01
				binary.BigEndian.PutUint16(p[1:3], 0xFFFF) // declares 65535 bytes of address
				return p
			}(),
		},
		{
			name: "data length overruns buffer",
			plaintext: func() []byte {
				addr := "a.b:80"
				p := make([]byte, 3+len(addr)+2)
				p[0] = 0x01
				binary.BigEndian.PutUint16(p[1:3], uint16(len(addr)))
				copy(p[3:], addr)
				binary.BigEndian.PutUint16(p[3+len(addr):], 0xFFFF) // declares 65535 bytes of data
				return p
			}(),
		},
		{
			name:      "exit layer truncated below length prefix",
			plaintext: []byte{0x01, 0x00},
		},
		{
			name:      "intermediate layer truncated below next-hop header",
			plaintext: []byte{0x00, 0x01, 0x02},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			nonce, err := crypto.RandomXNonce()
			if err != nil {
				t.Fatalf("RandomXNonce: %v", err)
			}
			ciphertext, err := crypto.XChaCha20Poly1305Seal(key, nonce, tc.plaintext, layerAD(3))
			if err != nil {
				t.Fatalf("Seal: %v", err)
			}

			forged := make([]byte, layerHeaderSize+len(ciphertext))
			copy(forged[0:crypto.KeySize], ephKP.PublicKey[:])
			copy(forged[crypto.KeySize:layerHeaderSize], nonce[:])
			copy(forged[layerHeaderSize:], ciphertext)

			// Must return an error, and must not panic.
			res, err := PeelLayer(hopKP.PrivateKey, 3, forged)
			if err == nil {
				t.Fatalf("expected a malformed-layer error, got result %+v", res)
			}
			if !errors.Is(err, ErrLayerMalformed) {
				t.Fatalf("expected ErrLayerMalformed, got %v", err)
			}
		})
	}
}

// TestOversizedFieldsRejectedNotTruncated covers the silent uint16 truncation.
//
// The old code cast len(payload) to uint16, so a 70000-byte payload was advertised as
// 4464 bytes and silently reassembled as corrupt data at the exit.
func TestOversizedFieldsRejectedNotTruncated(t *testing.T) {
	circuit, _ := buildTestCircuit(t)

	_, err := circuit.EncryptLayeredData(1, "1.1.1.1:443", make([]byte, maxFieldLen+1))
	if !errors.Is(err, ErrPayloadTooLarge) {
		t.Fatalf("expected ErrPayloadTooLarge for an oversized payload, got %v", err)
	}

	longAddr := string(bytes.Repeat([]byte("a"), maxFieldLen+1))
	_, err = circuit.EncryptLayeredData(1, longAddr, []byte("x"))
	if !errors.Is(err, ErrTargetAddrTooLong) {
		t.Fatalf("expected ErrTargetAddrTooLong for an oversized address, got %v", err)
	}
}

// TestJitterStaysInRangeAndCoversIt guards the unbiased jitter sampling.
//
// The old implementation reduced a uniform uint16 modulo the range, which skews toward
// the low end whenever the range does not divide 65536 -- and a skewed delay
// distribution is the signal timing-correlation analysis looks for.
func TestJitterStaysInRangeAndCoversIt(t *testing.T) {
	circuit, _ := buildTestCircuit(t)
	circuit.MinJitterMs = 2
	circuit.MaxJitterMs = 20

	counts := make(map[int]int)
	const samples = 20000

	for i := 0; i < samples; i++ {
		d := int(circuit.ComputeJitterDelay().Milliseconds())
		if d < circuit.MinJitterMs || d >= circuit.MaxJitterMs {
			t.Fatalf("jitter %dms outside [%d, %d)", d, circuit.MinJitterMs, circuit.MaxJitterMs)
		}
		counts[d]++
	}

	buckets := circuit.MaxJitterMs - circuit.MinJitterMs
	if len(counts) != buckets {
		t.Fatalf("expected all %d delay values to occur, saw %d distinct", buckets, len(counts))
	}

	// Uniform sampling puts samples/buckets in each bucket. Allow a generous 25%
	// band: this is here to catch a systematic skew, not to police normal variance.
	expected := samples / buckets
	low, high := expected*3/4, expected*5/4
	for delay, n := range counts {
		if n < low || n > high {
			t.Fatalf("delay %dms occurred %d times, expected roughly %d (band %d..%d): distribution is skewed",
				delay, n, expected, low, high)
		}
	}
}

// TestWipeClearsCircuitKeyMaterial checks that teardown actually zeroizes.
func TestWipeClearsCircuitKeyMaterial(t *testing.T) {
	circuit, _ := buildTestCircuit(t)

	circuit.Wipe()

	var zero [crypto.KeySize]byte
	for i, hop := range circuit.Hops {
		if hop.SharedKey != zero {
			t.Fatalf("hop %d shared key survived Wipe", i)
		}
	}
	for i, kp := range circuit.ephemerals {
		if kp.PrivateKey != zero {
			t.Fatalf("ephemeral %d private key survived Wipe", i)
		}
	}
}
