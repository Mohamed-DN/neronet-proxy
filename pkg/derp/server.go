package derp

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"net"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/sovereign/proxy/v4/pkg/nat"
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  65536,
	WriteBufferSize: 65536,
	CheckOrigin: func(r *http.Request) bool {
		return true // Allow all mesh connections with valid crypto auth
	},
}

// WebSocketSession implements the Session interface for a WebSocket connection
type WebSocketSession struct {
	mu     sync.Mutex
	conn   *websocket.Conn
	pubKey [PubKeySize]byte
	router *Router
	closed bool
}

func (s *WebSocketSession) SendFrame(frame *Frame) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.closed {
		return errors.New("websocket session closed")
	}

	data, err := EncodeFrame(frame)
	if err != nil {
		return err
	}

	return s.conn.WriteMessage(websocket.BinaryMessage, data)
}

func (s *WebSocketSession) PublicKey() [PubKeySize]byte {
	return s.pubKey
}

func (s *WebSocketSession) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.closed = true
	return s.conn.Close()
}

// ServerConfig configures the DERP-v4 relay server
type ServerConfig struct {
	ListenAddr    string
	STUNAddr      string
	TLSConfig     *tls.Config
	DecoyTitle    string
	Region        string
	ServerKeypair [PubKeySize]byte
}

// Server represents a complete DERP-v4 and STUN relay coordinator
type Server struct {
	config     ServerConfig
	router     *Router
	stunServer *nat.STUNServer
	httpServer *http.Server
	listener   net.Listener
}

// NewServer creates a new DERP relay server instance
func NewServer(cfg ServerConfig) *Server {
	return &Server{
		config: cfg,
		router: NewRouter(),
	}
}

// Start launches both the HTTP/WebSocket relay listener and the STUN reflection responder
func (s *Server) Start() error {
	// 1. Start STUN Server
	if s.config.STUNAddr != "" {
		stunSrv, err := nat.StartSTUNServer(s.config.STUNAddr)
		if err != nil {
			return fmt.Errorf("failed to start STUN server on %s: %w", s.config.STUNAddr, err)
		}
		s.stunServer = stunSrv
	}

	// 2. Setup HTTP Mux with Decoy and WebSocket endpoints
	mux := http.NewServeMux()
	decoy := NewDecoyHandler(s.config.DecoyTitle)

	mux.HandleFunc(RelayWebSocketPath, s.handleWebSocket)
	mux.Handle("/", decoy)

	var ln net.Listener
	var err error

	if s.config.TLSConfig != nil {
		ln, err = tls.Listen("tcp", s.config.ListenAddr, s.config.TLSConfig)
	} else {
		ln, err = net.Listen("tcp", s.config.ListenAddr)
	}
	if err != nil {
		return fmt.Errorf("failed to listen on %s: %w", s.config.ListenAddr, err)
	}

	s.listener = ln
	s.httpServer = &http.Server{
		Handler:      mux,
		ReadTimeout:  30 * time.Second,
		WriteTimeout: 30 * time.Second,
		IdleTimeout:  120 * time.Second,
	}

	go func() {
		_ = s.httpServer.Serve(ln)
	}()

	return nil
}

func (s *Server) handleWebSocket(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}

	// Read initial registration frame
	_, msg, err := conn.ReadMessage()
	if err != nil {
		conn.Close()
		return
	}

	initFrame, err := DecodeFrame(msg)
	if err != nil || initFrame.Type != FrameClientInfo {
		conn.Close()
		return
	}

	session := &WebSocketSession{
		conn:   conn,
		pubKey: initFrame.SrcPubKey,
		router: s.router,
	}

	s.router.Register(session)
	defer func() {
		s.router.Unregister(session.PublicKey())
		_ = session.Close()
	}()

	// Send KeepAlive ack back
	ackFrame := &Frame{
		Type:       FrameKeepAlive,
		DestPubKey: session.PublicKey(),
	}
	_ = session.SendFrame(ackFrame)

	// Pump incoming frames
	for {
		_, raw, err := conn.ReadMessage()
		if err != nil {
			break
		}

		frame, err := DecodeFrame(raw)
		if err != nil {
			continue
		}

		switch frame.Type {
		case FrameSendPacket:
			// Route packet to destination peer
			_ = s.router.RouteForward(session.PublicKey(), frame.DestPubKey, frame.Payload)
		case FrameKeepAlive:
			// Echo back keepalive
			_ = session.SendFrame(&Frame{Type: FrameKeepAlive, DestPubKey: session.PublicKey()})
		}
	}
}

// Addr returns the relay listening address
func (s *Server) Addr() net.Addr {
	if s.listener != nil {
		return s.listener.Addr()
	}
	return nil
}

// Router returns the internal Router
func (s *Server) Router() *Router {
	return s.router
}

// Close gracefully stops the relay server
func (s *Server) Close() error {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	if s.httpServer != nil {
		_ = s.httpServer.Shutdown(ctx)
	}
	if s.stunServer != nil {
		_ = s.stunServer.Close()
	}
	return nil
}
