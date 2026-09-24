package stress

import (
	"crypto/rand"
	"github.com/sovereign/proxy/v4/pkg/dataplane/stealth"
	"testing"

	"github.com/sovereign/proxy/v4/pkg/crypto"
	"github.com/sovereign/proxy/v4/pkg/derp"
	"github.com/sovereign/proxy/v4/pkg/routing"
)

func BenchmarkNoiseIKpsk2Handshake(b *testing.B) {
	aliceKP, _ := crypto.GenerateKeypair()
	bobKP, _ := crypto.GenerateKeypair()
	var psk [crypto.KeySize]byte
	rand.Read(psk[:])
	payload0RTT := []byte("0-RTT-Payload")
	payloadAct2 := []byte("Act2-Response")

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		act1, initState, _ := crypto.InitHandshakeAct1(aliceKP, bobKP.PublicKey, psk, payload0RTT)
		act2, _, _, _ := crypto.ProcessHandshakeAct1(bobKP, psk, act1, payloadAct2)
		_, _, _ = crypto.ProcessHandshakeAct2(initState, act2)
	}
}

func BenchmarkAntiReplaySlidingWindow(b *testing.B) {
	window := crypto.NewAntiReplayWindow()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		window.CheckAndAdd(uint64(i + 1))
	}
}

func BenchmarkChaCha20Poly1305SealOpen(b *testing.B) {
	var key [crypto.KeySize]byte
	rand.Read(key[:])
	nonce := crypto.ConstructNonce(1)
	plaintext := make([]byte, 1024)
	rand.Read(plaintext)
	ad := []byte("authenticated-data")

	b.SetBytes(1024)
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		sealed, _ := crypto.ChaCha20Poly1305Seal(key, nonce, plaintext, ad)
		_, _ = crypto.ChaCha20Poly1305Open(key, nonce, sealed, ad)
	}
}

func Benchmark3HopOnionEncryptPeel(b *testing.B) {
	eKP, _ := crypto.GenerateKeypair()
	mKP, _ := crypto.GenerateKeypair()
	xKP, _ := crypto.GenerateKeypair()

	eHop := &routing.OnionHop{HopIndex: 0, NodeID: "e1", PublicKey: eKP.PublicKey}
	mHop := &routing.OnionHop{HopIndex: 1, NodeID: "m2", PublicKey: mKP.PublicKey}
	xHop := &routing.OnionHop{HopIndex: 2, NodeID: "x3", PublicKey: xKP.PublicKey}

	circuit, _ := routing.Build3HopCircuit(1, eHop, mHop, xHop)
	payload := []byte("GET /anti-censorship HTTP/1.1\r\nHost: target.onion\r\n\r\n")

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		raw, _ := circuit.EncryptLayeredData(uint32(i), "1.1.1.1:443", payload)
		cell, _ := routing.DecodeCell(raw)
		p1, _ := routing.PeelLayer(eKP.PrivateKey, 1, cell.Payload)
		p2, _ := routing.PeelLayer(mKP.PrivateKey, 2, p1.InnerPayload)
		_, _ = routing.PeelLayer(xKP.PrivateKey, 3, p2.InnerPayload)
	}
}

func BenchmarkDERPRouterForward(b *testing.B) {
	router := derp.NewRouter()
	var aPub, bPub [derp.PubKeySize]byte
	rand.Read(aPub[:])
	rand.Read(bPub[:])

	aSess := &mockDerpSession{pubKey: aPub, ch: make(chan *derp.Frame, 100000)}
	bSess := &mockDerpSession{pubKey: bPub, ch: make(chan *derp.Frame, 100000)}

	router.Register(aSess)
	router.Register(bSess)

	payload := make([]byte, 512)
	rand.Read(payload)

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_ = router.RouteForward(aPub, bPub, payload)
		select {
		case <-bSess.ch:
		default:
		}
	}
}

func BenchmarkAmneziaWGWrapUnwrap(b *testing.B) {
	cfg := stealth.DefaultConfig()
	obf, _ := stealth.NewObfuscator(cfg)
	packet := make([]byte, 148)
	packet[0] = stealth.TypeMessageInitiation

	b.SetBytes(148)
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		wrapped := obf.Wrap(packet)
		_, _ = obf.Unwrap(wrapped)
	}
}

func BenchmarkDAITAPadding(b *testing.B) {
	packet := make([]byte, 750)
	rand.Read(packet)
	padded := make([]byte, 1420)

	b.SetBytes(1420)
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		copy(padded, packet)
	}
}
