package stealth

import (
	"bytes"
	"crypto/rand"
	"encoding/binary"
	"strings"
	"testing"
)

func TestObfuscator_WrapUnwrap_Roundtrip(t *testing.T) {
	cfg := DefaultConfig()
	obf, err := NewObfuscator(cfg)
	if err != nil {
		t.Fatalf("Failed to create obfuscator: %v", err)
	}

	// 1. Handshake Initiation (Type 1)
	initPkt := make([]byte, SizeMessageInitiation)
	binary.LittleEndian.PutUint32(initPkt[:4], TypeMessageInitiation)
	_, _ = rand.Read(initPkt[4:])

	wrappedInit := obf.Wrap(initPkt)
	expectedInitLen := SizeMessageInitiation + int(cfg.S1)
	if len(wrappedInit) != expectedInitLen {
		t.Fatalf("Wrapped init length mismatch: got %d, want %d", len(wrappedInit), expectedInitLen)
	}
	if h := binary.LittleEndian.Uint32(wrappedInit[:4]); h != cfg.H1 {
		t.Fatalf("Wrapped init header mismatch: got 0x%x, want 0x%x", h, cfg.H1)
	}

	unwrappedInit, isJunk := obf.Unwrap(wrappedInit)
	if isJunk {
		t.Fatal("Unwrap identified valid init packet as junk")
	}
	if len(unwrappedInit) != SizeMessageInitiation {
		t.Fatalf("Unwrapped init length mismatch: got %d, want %d", len(unwrappedInit), SizeMessageInitiation)
	}
	if !bytes.Equal(unwrappedInit, initPkt) {
		t.Fatal("Unwrapped init packet payload does not match original")
	}

	// 2. Handshake Response (Type 2)
	respPkt := make([]byte, SizeMessageResponse)
	binary.LittleEndian.PutUint32(respPkt[:4], TypeMessageResponse)
	_, _ = rand.Read(respPkt[4:])

	wrappedResp := obf.Wrap(respPkt)
	expectedRespLen := SizeMessageResponse + int(cfg.S2)
	if len(wrappedResp) != expectedRespLen {
		t.Fatalf("Wrapped resp length mismatch: got %d, want %d", len(wrappedResp), expectedRespLen)
	}
	if h := binary.LittleEndian.Uint32(wrappedResp[:4]); h != cfg.H2 {
		t.Fatalf("Wrapped resp header mismatch: got 0x%x, want 0x%x", h, cfg.H2)
	}

	unwrappedResp, isJunk := obf.Unwrap(wrappedResp)
	if isJunk {
		t.Fatal("Unwrap identified valid resp packet as junk")
	}
	if len(unwrappedResp) != SizeMessageResponse {
		t.Fatalf("Unwrapped resp length mismatch: got %d, want %d", len(unwrappedResp), SizeMessageResponse)
	}
	if !bytes.Equal(unwrappedResp, respPkt) {
		t.Fatal("Unwrapped resp packet payload does not match original")
	}

	// 3. Cookie (Type 3)
	cookiePkt := make([]byte, SizeMessageCookie)
	binary.LittleEndian.PutUint32(cookiePkt[:4], TypeMessageCookie)
	_, _ = rand.Read(cookiePkt[4:])

	wrappedCookie := obf.Wrap(cookiePkt)
	if h := binary.LittleEndian.Uint32(wrappedCookie[:4]); h != cfg.H3 {
		t.Fatalf("Wrapped cookie header mismatch: got 0x%x, want 0x%x", h, cfg.H3)
	}
	unwrappedCookie, isJunk := obf.Unwrap(wrappedCookie)
	if isJunk || !bytes.Equal(unwrappedCookie, cookiePkt) {
		t.Fatal("Cookie unwrap failed")
	}

	// 4. Data (Type 4)
	dataPkt := make([]byte, 80)
	binary.LittleEndian.PutUint32(dataPkt[:4], TypeMessageData)
	_, _ = rand.Read(dataPkt[4:])

	wrappedData := obf.Wrap(dataPkt)
	if h := binary.LittleEndian.Uint32(wrappedData[:4]); h != cfg.H4 {
		t.Fatalf("Wrapped data header mismatch: got 0x%x, want 0x%x", h, cfg.H4)
	}
	unwrappedData, isJunk := obf.Unwrap(wrappedData)
	if isJunk || !bytes.Equal(unwrappedData, dataPkt) {
		t.Fatal("Data unwrap failed")
	}
}

func TestObfuscator_JunkGeneration(t *testing.T) {
	cfg := DefaultConfig()
	cfg.Jc = 5
	cfg.Jmin = 50
	cfg.Jmax = 100

	obf, err := NewObfuscator(cfg)
	if err != nil {
		t.Fatalf("Failed to create obfuscator: %v", err)
	}

	junk := obf.GenerateJunk()
	if len(junk) != 5 {
		t.Fatalf("Junk count mismatch: got %d, want 5", len(junk))
	}

	for i, pkt := range junk {
		if len(pkt) < 50 || len(pkt) > 100 {
			t.Fatalf("Junk packet %d size out of bounds: %d", i, len(pkt))
		}
		_, isJunk := obf.Unwrap(pkt)
		if !isJunk {
			t.Fatalf("Junk packet %d was not identified as junk by Unwrap", i)
		}
	}
}

func TestObfuscator_DisguiseEnvelopes(t *testing.T) {
	// DNS Disguise
	dnsCfg := DefaultConfig()
	dnsCfg.Disguise = "dns"
	dnsObf, _ := NewObfuscator(dnsCfg)

	pkt := make([]byte, SizeMessageInitiation)
	binary.LittleEndian.PutUint32(pkt[:4], TypeMessageInitiation)
	_, _ = rand.Read(pkt[4:])

	wrappedDNS := dnsObf.Wrap(pkt)
	if len(wrappedDNS) != SizeMessageInitiation+int(dnsCfg.S1)+12 {
		t.Fatalf("DNS wrapped length mismatch: got %d", len(wrappedDNS))
	}

	unwrappedDNS, isJunk := dnsObf.Unwrap(wrappedDNS)
	if isJunk || !bytes.Equal(unwrappedDNS, pkt) {
		t.Fatal("DNS disguise unwrap failed")
	}

	// QUIC Disguise
	quicCfg := DefaultConfig()
	quicCfg.Disguise = "quic"
	quicObf, _ := NewObfuscator(quicCfg)

	wrappedQUIC := quicObf.Wrap(pkt)
	if len(wrappedQUIC) != SizeMessageInitiation+int(quicCfg.S1)+1 {
		t.Fatalf("QUIC wrapped length mismatch: got %d", len(wrappedQUIC))
	}
	if wrappedQUIC[0] != 0x40 {
		t.Fatalf("QUIC flag missing on first byte: 0x%x", wrappedQUIC[0])
	}

	unwrappedQUIC, isJunk := quicObf.Unwrap(wrappedQUIC)
	if isJunk || !bytes.Equal(unwrappedQUIC, pkt) {
		t.Fatal("QUIC disguise unwrap failed")
	}
}

func TestTransportManager_Negotiation(t *testing.T) {
	localStealth := DefaultConfig()
	mgr := NewTransportManager(TransportWireGuard, localStealth)

	peer1 := "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	peer2 := "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

	// Peer 1 uses default (WireGuard)
	t1, _ := mgr.GetEffectiveTransport(peer1)
	if t1 != TransportWireGuard {
		t.Fatalf("Peer 1 transport mismatch: got %s, want %s", t1, TransportWireGuard)
	}

	// Peer 2 configured for AmneziaWG
	customStealth := DefaultConfig()
	customStealth.H1 = 0x11223344
	mgr.SetPeerTransport(peer2, TransportAmneziaWG, customStealth)

	t2, s2 := mgr.GetEffectiveTransport(peer2)
	if t2 != TransportAmneziaWG {
		t.Fatalf("Peer 2 transport mismatch: got %s, want %s", t2, TransportAmneziaWG)
	}
	if s2.H1 != 0x11223344 {
		t.Fatalf("Peer 2 custom H1 mismatch: got 0x%x", s2.H1)
	}
}

func TestFallbacks_OpenVPN_and_VLESS(t *testing.T) {
	// OpenVPN config verification
	ovpn := GenerateOpenVPNConfig(OpenVPNProfileConfig{
		RemoteHost: "mesh-gateway.neronet.internal",
		RemotePort: 1194,
		Proto:      "udp",
		Cipher:     "AES-256-GCM",
	})
	if !strings.Contains(ovpn, "remote mesh-gateway.neronet.internal 1194") {
		t.Fatalf("OpenVPN config missing remote: %s", ovpn)
	}
	if !strings.Contains(ovpn, "proto udp") {
		t.Fatalf("OpenVPN config missing proto: %s", ovpn)
	}

	// VLESS URI verification
	vless := GenerateVLESSURI(VLESSProfileConfig{
		UUID:       "12345678-1234-1234-1234-123456789abc",
		RemoteHost: "edge.neronet.internal",
		RemotePort: 443,
		Path:       "/vless-proxy",
		Sni:        "edge.neronet.internal",
	})
	if !strings.HasPrefix(vless, "vless://12345678-1234-1234-1234-123456789abc@edge.neronet.internal:443") {
		t.Fatalf("VLESS URI prefix mismatch: %s", vless)
	}
	if !strings.Contains(vless, "path=/vless-proxy") {
		t.Fatalf("VLESS URI path mismatch: %s", vless)
	}
}
