package derp

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// PacketHandler is called when a packet is delivered by the relay
type PacketHandler func(srcPub [PubKeySize]byte, payload []byte)

// Client coordinates connection and framing to a DERP-v4 relay server
type Client struct {
	mu        sync.Mutex
	serverURL string
	pubKey    [PubKeySize]byte
	conn      *websocket.Conn
	handler   PacketHandler
	closed    bool
	dialer    *websocket.Dialer
	tlsConfig *tls.Config
}

// NewClient creates a new DERP-v4 relay client
func NewClient(serverURL string, pubKey [PubKeySize]byte, handler PacketHandler, tlsCfg *tls.Config) *Client {
	return &Client{
		serverURL: serverURL,
		pubKey:    pubKey,
		handler:   handler,
		tlsConfig: tlsCfg,
		dialer: &websocket.Dialer{
			TLSClientConfig:  tlsCfg,
			HandshakeTimeout: 10 * time.Second,
		},
	}
}

// Connect dials the relay and completes registration
func (c *Client) Connect(ctx context.Context) error {
	header := http.Header{}
	header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36")

	conn, _, err := c.dialer.DialContext(ctx, c.serverURL, header)
	if err != nil {
		return fmt.Errorf("failed to dial DERP websocket %s: %w", c.serverURL, err)
	}

	c.conn = conn

	// Send FrameClientInfo registration
	regFrame := &Frame{
		Type:      FrameClientInfo,
		SrcPubKey: c.pubKey,
	}

	regBytes, err := EncodeFrame(regFrame)
	if err != nil {
		conn.Close()
		return err
	}

	if err := conn.WriteMessage(websocket.BinaryMessage, regBytes); err != nil {
		conn.Close()
		return fmt.Errorf("failed to send registration frame: %w", err)
	}

	// Read KeepAlive ack
	_, msg, err := conn.ReadMessage()
	if err != nil {
		conn.Close()
		return fmt.Errorf("failed to receive registration ack: %w", err)
	}

	ackFrame, err := DecodeFrame(msg)
	if err != nil || ackFrame.Type != FrameKeepAlive {
		conn.Close()
		return errors.New("invalid relay handshake ack")
	}

	go c.readLoop()
	return nil
}

func (c *Client) readLoop() {
	for {
		_, raw, err := c.conn.ReadMessage()
		if err != nil {
			break
		}

		frame, err := DecodeFrame(raw)
		if err != nil {
			continue
		}

		if frame.Type == FrameRecvPacket && c.handler != nil {
			c.handler(frame.SrcPubKey, frame.Payload)
		}
	}
}

// SendTo transmits an opaque payload to the target peer public key via the relay
func (c *Client) SendTo(destPub [PubKeySize]byte, payload []byte) error {
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.closed || c.conn == nil {
		return errors.New("derp client is closed or not connected")
	}

	frame := &Frame{
		Type:       FrameSendPacket,
		DestPubKey: destPub,
		SrcPubKey:  c.pubKey,
		Payload:    payload,
	}

	frameBytes, err := EncodeFrame(frame)
	if err != nil {
		return err
	}

	return c.conn.WriteMessage(websocket.BinaryMessage, frameBytes)
}

// Close disconnects the client
func (c *Client) Close() error {
	c.mu.Lock()
	defer c.mu.Unlock()

	c.closed = true
	if c.conn != nil {
		return c.conn.Close()
	}
	return nil
}
