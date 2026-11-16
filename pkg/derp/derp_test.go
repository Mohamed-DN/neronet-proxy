package derp

import (
	"bytes"
	"context"
	"crypto/rand"
	"fmt"
	"io"
	"net/http"
	"testing"
	"time"
)

func TestFrameEncodeDecode(t *testing.T) {
	var destPub [PubKeySize]byte
	var srcPub [PubKeySize]byte
	rand.Read(destPub[:])
	rand.Read(srcPub[:])

	payload := []byte("Sovereign DERP Frame Encrypted Ciphertext Payload")

	frame := &Frame{
		Type:       FrameSendPacket,
		DestPubKey: destPub,
		SrcPubKey:  srcPub,
		Payload:    payload,
	}

	encoded, err := EncodeFrame(frame)
	if err != nil {
		t.Fatalf("EncodeFrame failed: %v", err)
	}

	decoded, err := DecodeFrame(encoded)
	if err != nil {
		t.Fatalf("DecodeFrame failed: %v", err)
	}

	if decoded.Type != frame.Type {
		t.Fatalf("Frame type mismatch: %d != %d", decoded.Type, frame.Type)
	}
	if decoded.DestPubKey != frame.DestPubKey {
		t.Fatalf("DestPubKey mismatch")
	}
	if decoded.SrcPubKey != frame.SrcPubKey {
		t.Fatalf("SrcPubKey mismatch")
	}
	if !bytes.Equal(decoded.Payload, frame.Payload) {
		t.Fatalf("Payload mismatch: %s != %s", string(decoded.Payload), string(frame.Payload))
	}
}

func TestDecoyHandler(t *testing.T) {
	server := NewServer(ServerConfig{
		ListenAddr: "127.0.0.1:0",
		DecoyTitle: "Custom Cluster Node",
	})
	if err := server.Start(); err != nil {
		t.Fatalf("Server start failed: %v", err)
	}
	defer server.Close()

	addr := server.Addr().String()
	resp, err := http.Get(fmt.Sprintf("http://%s/", addr))
	if err != nil {
		t.Fatalf("GET / failed: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("Expected status 200, got %d", resp.StatusCode)
	}

	body, _ := io.ReadAll(resp.Body)
	if !bytes.Contains(body, []byte("Custom Cluster Node")) {
		t.Fatalf("Decoy body does not contain title")
	}
	if resp.Header.Get("Server") != "nginx/1.24.0 (Ubuntu)" {
		t.Fatalf("Expected nginx server header, got %s", resp.Header.Get("Server"))
	}
}

func TestRelayClientRouting(t *testing.T) {
	server := NewServer(ServerConfig{
		ListenAddr: "127.0.0.1:0",
		STUNAddr:   "127.0.0.1:0",
		DecoyTitle: "Relay Test",
	})
	if err := server.Start(); err != nil {
		t.Fatalf("Server start failed: %v", err)
	}
	defer server.Close()

	wsURL := fmt.Sprintf("ws://%s/ws/v4/relay", server.Addr().String())

	var alicePub [PubKeySize]byte
	var bobPub [PubKeySize]byte
	rand.Read(alicePub[:])
	rand.Read(bobPub[:])

	bobReceived := make(chan []byte, 1)
	aliceReceived := make(chan []byte, 1)

	aliceClient := NewClient(wsURL, alicePub, func(src [PubKeySize]byte, p []byte) {
		aliceReceived <- p
	}, nil)

	bobClient := NewClient(wsURL, bobPub, func(src [PubKeySize]byte, p []byte) {
		bobReceived <- p
	}, nil)

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	if err := aliceClient.Connect(ctx); err != nil {
		t.Fatalf("Alice connect failed: %v", err)
	}
	defer aliceClient.Close()

	if err := bobClient.Connect(ctx); err != nil {
		t.Fatalf("Bob connect failed: %v", err)
	}
	defer bobClient.Close()

	// Wait for registrations to settle in Router
	time.Sleep(50 * time.Millisecond)
	if count := server.Router().ActiveSessionsCount(); count != 2 {
		t.Fatalf("Expected 2 active sessions on relay, got %d", count)
	}

	// Alice sends packet to Bob
	msg1 := []byte("Encrypted Mesh Frame Alice -> Bob via DERP")
	if err := aliceClient.SendTo(bobPub, msg1); err != nil {
		t.Fatalf("Alice SendTo failed: %v", err)
	}

	select {
	case p := <-bobReceived:
		if !bytes.Equal(p, msg1) {
			t.Fatalf("Bob received payload mismatch: %s", string(p))
		}
	case <-time.After(2 * time.Second):
		t.Fatalf("Bob did not receive packet in time")
	}

	// Bob replies to Alice
	msg2 := []byte("Encrypted Mesh Reply Bob -> Alice via DERP")
	if err := bobClient.SendTo(alicePub, msg2); err != nil {
		t.Fatalf("Bob SendTo failed: %v", err)
	}

	select {
	case p := <-aliceReceived:
		if !bytes.Equal(p, msg2) {
			t.Fatalf("Alice received payload mismatch: %s", string(p))
		}
	case <-time.After(2 * time.Second):
		t.Fatalf("Alice did not receive reply in time")
	}

	// The router counts a packet after SendFrame returns, so the receiver can see the
	// reply a moment before the counter moves: wait for it instead of reading it once.
	routed, dropped := server.Router().Metrics()
	for deadline := time.Now().Add(2 * time.Second); routed < 2 && time.Now().Before(deadline); {
		time.Sleep(time.Millisecond)
		routed, dropped = server.Router().Metrics()
	}
	if routed < 2 {
		t.Fatalf("Expected at least 2 routed packets, got %d (dropped %d)", routed, dropped)
	}
}
