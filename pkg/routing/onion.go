package routing

import (
	"crypto/rand"
	"encoding/binary"
	"errors"
	"fmt"
	"math/big"
	"time"

	"github.com/sovereign/proxy/v4/pkg/crypto"
)

var (
	ErrCircuitHopMismatch = errors.New("3-hop onion circuit requires exactly 3 distinct hops")
	ErrPeelFailed         = errors.New("failed to peel onion layer: authentication tag mismatch")
	ErrLayerMalformed     = errors.New("peeled onion layer is malformed")
	ErrPayloadTooLarge    = errors.New("onion payload exceeds the maximum encodable length")
	ErrTargetAddrTooLong  = errors.New("onion target address exceeds the maximum encodable length")
)

const (
	// maxFieldLen is the largest value a 16-bit length prefix can carry.
	// Anything longer must be rejected rather than silently truncated.
	maxFieldLen = 0xFFFF

	// layerHeaderSize is the cleartext preamble of every layer payload:
	// the ephemeral public key for this hop, followed by this layer's nonce.
	layerHeaderSize = crypto.KeySize + crypto.XNonceSize
)

// OnionHop represents one hop in an onion circuit.
//
// EphemeralPub is the public half of the per-hop ephemeral keypair held by the
// client. It is deliberately NOT shared between hops: see Build3HopCircuit.
type OnionHop struct {
	HopIndex     int
	NodeID       string
	PublicKey    [crypto.KeySize]byte
	SharedKey    [crypto.KeySize]byte
	EphemeralPub [crypto.KeySize]byte
}

// OnionCircuit represents an established 3-hop obfuscation circuit
type OnionCircuit struct {
	CircuitID   uint32
	Hops        [3]*OnionHop
	EphemeralKP *crypto.Keypair // entry-hop ephemeral, retained for circuit teardown
	CreatedAt   time.Time
	MinJitterMs int
	MaxJitterMs int

	// ephemerals holds one ephemeral keypair per hop, index-aligned with Hops.
	ephemerals [3]*crypto.Keypair
}

// Build3HopCircuit constructs a layered circuit using per-hop ephemeral keys.
//
// Each hop gets its OWN ephemeral keypair. This matters more than it looks: if a
// single ephemeral public key is reused across all three hops it travels the whole
// circuit in the clear, and the entry and exit nodes both observe the same 32-byte
// value. That hands an adversary who controls both ends a trivial correlation
// identifier and destroys the unlinkability the circuit exists to provide.
//
// With distinct ephemerals the entry hop observes {eph[0], eph[1]} and the exit hop
// observes {eph[2]} -- disjoint sets, so no shared identifier links the two ends.
func Build3HopCircuit(circuitID uint32, entry, intermediate, exit *OnionHop) (*OnionCircuit, error) {
	if entry == nil || intermediate == nil || exit == nil {
		return nil, ErrCircuitHopMismatch
	}

	c := &OnionCircuit{
		CircuitID:   circuitID,
		Hops:        [3]*OnionHop{entry, intermediate, exit},
		CreatedAt:   time.Now(),
		MinJitterMs: 2,
		MaxJitterMs: 20,
	}

	for i, hop := range c.Hops {
		ephKP, err := crypto.GenerateKeypair()
		if err != nil {
			return nil, fmt.Errorf("failed to generate ephemeral keypair for hop %d: %w", i, err)
		}

		dh, err := crypto.DH(ephKP.PrivateKey, hop.PublicKey)
		if err != nil {
			return nil, fmt.Errorf("hop %d DH failed: %w", i, err)
		}

		sharedKey, err := deriveHopKey(dh, i)
		if err != nil {
			return nil, fmt.Errorf("hop %d key derivation failed: %w", i, err)
		}

		hop.SharedKey = sharedKey
		hop.EphemeralPub = ephKP.PublicKey
		c.ephemerals[i] = ephKP
	}

	c.EphemeralKP = c.ephemerals[0]

	return c, nil
}

// deriveHopKey turns a raw X25519 output into an AEAD key bound to this hop position.
//
// Using the DH output directly as a cipher key is the failure mode this guards
// against: it is a curve point rather than a uniform bit string, and it carries no
// binding to the role the key plays. Per-circuit separation is already guaranteed by
// the ephemeral keypair being freshly generated for every circuit, so the info string
// only needs to pin the hop position.
func deriveHopKey(dh [crypto.KeySize]byte, hopIndex int) ([crypto.KeySize]byte, error) {
	info := append([]byte("neronet-onion-v1|hop="), byte(hopIndex))
	return crypto.DeriveKey(dh[:], nil, info)
}

// Layer plaintext layouts:
//
//	Exit layer:         [IsExit=0x01 (1B)] [TargetLen (2B)] [TargetAddr] [DataLen (2B)] [Data]
//	Intermediate layer: [IsExit=0x00 (1B)] [NextHopPub (32B)] [next layer payload]
//
// Layer payload (what travels on the wire, and what PeelLayer receives):
//
//	[EphemeralPub for this hop (32B)] [XNonce (24B)] [Ciphertext]
//
// The nonce is per layer and drawn fresh from the CSPRNG for every cell. Each layer
// carries its own independent nonce, so the value seen by the entry hop reveals
// nothing about the value seen by the exit hop.

// EncryptLayeredData seals data into a 3-hop onion cell.
func (c *OnionCircuit) EncryptLayeredData(streamID uint32, targetAddr string, payload []byte) ([]byte, error) {
	if len(targetAddr) > maxFieldLen {
		return nil, fmt.Errorf("%w: %d bytes", ErrTargetAddrTooLong, len(targetAddr))
	}
	if len(payload) > maxFieldLen {
		return nil, fmt.Errorf("%w: %d bytes", ErrPayloadTooLarge, len(payload))
	}

	// 1. Layer 3 (Exit Hop)
	layer3Plain := make([]byte, 1+2+len(targetAddr)+2+len(payload))
	layer3Plain[0] = 0x01 // IsExit
	binary.BigEndian.PutUint16(layer3Plain[1:3], uint16(len(targetAddr)))
	copy(layer3Plain[3:3+len(targetAddr)], targetAddr)
	dataOffset := 3 + len(targetAddr)
	binary.BigEndian.PutUint16(layer3Plain[dataOffset:dataOffset+2], uint16(len(payload)))
	copy(layer3Plain[dataOffset+2:], payload)

	layer3Payload, err := c.sealLayer(2, layer3Plain)
	if err != nil {
		return nil, fmt.Errorf("layer 3 seal failed: %w", err)
	}

	// 2. Layer 2 (Intermediate Hop)
	layer2Plain := make([]byte, 1+crypto.KeySize+len(layer3Payload))
	layer2Plain[0] = 0x00 // Not exit
	copy(layer2Plain[1:33], c.Hops[2].PublicKey[:])
	copy(layer2Plain[33:], layer3Payload)

	layer2Payload, err := c.sealLayer(1, layer2Plain)
	if err != nil {
		return nil, fmt.Errorf("layer 2 seal failed: %w", err)
	}

	// 3. Layer 1 (Entry Hop)
	layer1Plain := make([]byte, 1+crypto.KeySize+len(layer2Payload))
	layer1Plain[0] = 0x00 // Not exit
	copy(layer1Plain[1:33], c.Hops[1].PublicKey[:])
	copy(layer1Plain[33:], layer2Payload)

	layer1Payload, err := c.sealLayer(0, layer1Plain)
	if err != nil {
		return nil, fmt.Errorf("layer 1 seal failed: %w", err)
	}

	cell := &OnionCell{
		CircuitID: c.CircuitID,
		Command:   CellCmdRelayData,
		StreamID:  streamID,
		Digest:    0,
		Payload:   layer1Payload,
	}

	return EncodeCell(cell)
}

// sealLayer encrypts one layer and prefixes it with the hop's ephemeral key and a fresh nonce.
func (c *OnionCircuit) sealLayer(hopIndex int, plaintext []byte) ([]byte, error) {
	hop := c.Hops[hopIndex]

	nonce, err := crypto.RandomXNonce()
	if err != nil {
		return nil, err
	}

	ciphertext, err := crypto.XChaCha20Poly1305Seal(hop.SharedKey, nonce, plaintext, layerAD(hopIndex+1))
	if err != nil {
		return nil, err
	}

	out := make([]byte, layerHeaderSize+len(ciphertext))
	copy(out[0:crypto.KeySize], hop.EphemeralPub[:])
	copy(out[crypto.KeySize:layerHeaderSize], nonce[:])
	copy(out[layerHeaderSize:], ciphertext)

	return out, nil
}

// layerAD builds the additional-authenticated-data string binding a ciphertext to its layer.
func layerAD(layerIndex int) []byte {
	return []byte(fmt.Sprintf("onion-layer-%d", layerIndex))
}

// PeelResult represents peeled layer output at each intermediate or exit hop
type PeelResult struct {
	IsExit       bool
	NextHopPub   [crypto.KeySize]byte
	TargetAddr   string
	InnerPayload []byte
}

// PeelLayer decrypts one layer of the onion at an intermediate or exit hop.
//
// Every length field in the peeled plaintext is bounds checked before use. The
// plaintext is authenticated, so forging a field requires a valid tag -- but
// "authenticated" is not "trusted", and an out-of-range slice here would panic the
// whole relay process rather than drop one cell.
func PeelLayer(hopPrivKey [crypto.KeySize]byte, layerIndex int, cellPayload []byte) (*PeelResult, error) {
	if layerIndex < 1 || layerIndex > 3 {
		return nil, fmt.Errorf("%w: layer index %d out of range", ErrLayerMalformed, layerIndex)
	}
	if len(cellPayload) < layerHeaderSize {
		return nil, fmt.Errorf("%w: payload too small to contain ephemeral key and nonce", ErrLayerMalformed)
	}

	var clientEphPub [crypto.KeySize]byte
	copy(clientEphPub[:], cellPayload[0:crypto.KeySize])

	var nonce [crypto.XNonceSize]byte
	copy(nonce[:], cellPayload[crypto.KeySize:layerHeaderSize])

	ciphertext := cellPayload[layerHeaderSize:]

	dh, err := crypto.DH(hopPrivKey, clientEphPub)
	if err != nil {
		return nil, fmt.Errorf("DH computation failed during peel: %w", err)
	}

	sharedKey, err := deriveHopKey(dh, layerIndex-1)
	if err != nil {
		return nil, fmt.Errorf("hop key derivation failed during peel: %w", err)
	}

	plaintext, err := crypto.XChaCha20Poly1305Open(sharedKey, nonce, ciphertext, layerAD(layerIndex))
	if err != nil {
		return nil, fmt.Errorf("%w: layer %d", ErrPeelFailed, layerIndex)
	}

	if len(plaintext) < 1 {
		return nil, fmt.Errorf("%w: empty peeled plaintext", ErrLayerMalformed)
	}

	if plaintext[0] == 0x01 {
		return parseExitLayer(plaintext)
	}

	return parseIntermediateLayer(plaintext)
}

// parseExitLayer decodes the innermost layer: target address plus application data.
func parseExitLayer(plaintext []byte) (*PeelResult, error) {
	// [IsExit 1B] [TargetLen 2B] [TargetAddr] [DataLen 2B] [Data]
	if len(plaintext) < 3 {
		return nil, fmt.Errorf("%w: exit layer shorter than target length prefix", ErrLayerMalformed)
	}

	targetLen := int(binary.BigEndian.Uint16(plaintext[1:3]))
	dataLenOffset := 3 + targetLen
	if dataLenOffset+2 > len(plaintext) {
		return nil, fmt.Errorf("%w: exit target length %d overruns buffer of %d", ErrLayerMalformed, targetLen, len(plaintext))
	}

	targetAddr := string(plaintext[3:dataLenOffset])

	dataLen := int(binary.BigEndian.Uint16(plaintext[dataLenOffset : dataLenOffset+2]))
	dataOffset := dataLenOffset + 2
	if dataOffset+dataLen > len(plaintext) {
		return nil, fmt.Errorf("%w: exit data length %d overruns buffer of %d", ErrLayerMalformed, dataLen, len(plaintext))
	}

	data := make([]byte, dataLen)
	copy(data, plaintext[dataOffset:dataOffset+dataLen])

	return &PeelResult{
		IsExit:       true,
		TargetAddr:   targetAddr,
		InnerPayload: data,
	}, nil
}

// parseIntermediateLayer decodes a relay layer: next hop identity plus the next layer payload.
func parseIntermediateLayer(plaintext []byte) (*PeelResult, error) {
	// [IsExit 1B] [NextHopPub 32B] [next layer payload]
	if len(plaintext) < 1+crypto.KeySize+layerHeaderSize {
		return nil, fmt.Errorf("%w: intermediate layer shorter than next-hop header", ErrLayerMalformed)
	}

	var nextHopPub [crypto.KeySize]byte
	copy(nextHopPub[:], plaintext[1:1+crypto.KeySize])

	// The inner payload already carries the next hop's own ephemeral key and nonce.
	// Nothing from this layer is forwarded, which is what keeps the hops unlinkable.
	inner := make([]byte, len(plaintext)-(1+crypto.KeySize))
	copy(inner, plaintext[1+crypto.KeySize:])

	return &PeelResult{
		IsExit:       false,
		NextHopPub:   nextHopPub,
		InnerPayload: inner,
	}, nil
}

// ComputeJitterDelay generates a uniform random delay between min and max ms to
// frustrate timing correlation.
//
// Uniformity is the point: a modulo reduction over a power-of-two random value biases
// short delays whenever the range does not divide evenly, and a skewed jitter
// distribution is exactly the signal a traffic analyst looks for. crypto/rand.Int
// performs rejection sampling and is unbiased by construction.
func (c *OnionCircuit) ComputeJitterDelay() time.Duration {
	if c.MaxJitterMs <= c.MinJitterMs {
		return time.Duration(c.MinJitterMs) * time.Millisecond
	}

	rangeMs := int64(c.MaxJitterMs - c.MinJitterMs)
	n, err := rand.Int(rand.Reader, big.NewInt(rangeMs))
	if err != nil {
		// A CSPRNG failure must not collapse the jitter to a constant.
		return time.Duration(c.MaxJitterMs) * time.Millisecond
	}

	return time.Duration(int64(c.MinJitterMs)+n.Int64()) * time.Millisecond
}

// Wipe zeroizes every ephemeral private key and derived hop key held by the circuit.
func (c *OnionCircuit) Wipe() {
	for _, kp := range c.ephemerals {
		if kp != nil {
			kp.Wipe()
		}
	}
	for _, hop := range c.Hops {
		if hop != nil {
			crypto.Wipe(hop.SharedKey[:])
		}
	}
}
