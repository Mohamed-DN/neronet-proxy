package bridge

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

// HTTPProxyServer handles inbound HTTP CONNECT proxy requests
type HTTPProxyServer struct {
	mu         sync.Mutex
	listenAddr string
	server     *http.Server
	bridge     *NetstackBridge
	listener   net.Listener
	closed     bool

	// With credentials set, a request must carry them in Proxy-Authorization (Basic).
	username string
	password string

	// requestTimeout bounds reading and answering a request; zero means 30 seconds.
	// It does not apply to a tunnel once it is established.
	requestTimeout time.Duration
}

// SetCredentials makes the proxy require this username and password.
func (s *HTTPProxyServer) SetCredentials(username, password string) {
	s.username = username
	s.password = password
}

func (s *HTTPProxyServer) authorised(r *http.Request) bool {
	if s.username == "" && s.password == "" {
		return true
	}
	scheme, encoded, ok := strings.Cut(r.Header.Get("Proxy-Authorization"), " ")
	if !ok || !strings.EqualFold(scheme, "Basic") {
		return false
	}
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(encoded))
	if err != nil {
		return false
	}
	user, pass, ok := strings.Cut(string(raw), ":")
	return ok && constantTimeEqual(user, s.username) && constantTimeEqual(pass, s.password)
}

// NewHTTPProxyServer creates a new HTTP proxy server instance
func NewHTTPProxyServer(listenAddr string, bridge *NetstackBridge) *HTTPProxyServer {
	return &HTTPProxyServer{
		listenAddr: listenAddr,
		bridge:     bridge,
	}
}

// Start launches the HTTP proxy server
func (s *HTTPProxyServer) Start() error {
	ln, err := net.Listen("tcp", s.listenAddr)
	if err != nil {
		return fmt.Errorf("failed to listen on HTTP proxy %s: %w", s.listenAddr, err)
	}

	s.listener = ln
	timeout := s.requestTimeout
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	s.server = &http.Server{
		Handler:      http.HandlerFunc(s.handleHTTP),
		ReadTimeout:  timeout,
		WriteTimeout: timeout,
	}

	go func() {
		_ = s.server.Serve(ln)
	}()

	return nil
}

func (s *HTTPProxyServer) handleHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodConnect {
		http.Error(w, "Only HTTP CONNECT tunneling is supported", http.StatusMethodNotAllowed)
		return
	}

	host, portStr, err := net.SplitHostPort(r.Host)
	if err != nil {
		http.Error(w, "Invalid host:port specification", http.StatusBadRequest)
		return
	}

	port, err := strconv.Atoi(portStr)
	if err != nil {
		http.Error(w, "Invalid port number", http.StatusBadRequest)
		return
	}

	if !s.authorised(r) {
		w.Header().Set("Proxy-Authenticate", `Basic realm="neronet"`)
		http.Error(w, "Proxy authentication required", http.StatusProxyAuthRequired)
		return
	}

	// Connect first, answer second: "200 Connection Established" used to be sent
	// before the outbound dial, whatever its outcome.
	dialCtx, cancel := context.WithTimeout(r.Context(), socks5DialTimeout)
	outbound, err := s.bridge.Dial(dialCtx, host, port)
	cancel()
	if err != nil {
		status := http.StatusBadGateway
		switch socksReplyFor(err) {
		case SOCKS5RepNotAllowed:
			status = http.StatusForbidden
		case SOCKS5RepHostUnreachable:
			if errors.Is(err, context.DeadlineExceeded) {
				status = http.StatusGatewayTimeout
			}
		}
		http.Error(w, "The destination could not be reached", status)
		return
	}

	hijacker, ok := w.(http.Hijacker)
	if !ok {
		outbound.Close()
		http.Error(w, "Hijacking not supported", http.StatusInternalServerError)
		return
	}

	clientConn, _, err := hijacker.Hijack()
	if err != nil {
		outbound.Close()
		http.Error(w, err.Error(), http.StatusServiceUnavailable)
		return
	}
	defer clientConn.Close()

	// The server's read and write timeouts stay on the connection after the hijack,
	// which closed every tunnel 30 seconds after it was opened.
	_ = clientConn.SetDeadline(time.Time{})

	if _, err := clientConn.Write([]byte("HTTP/1.1 200 Connection Established\r\n\r\n")); err != nil {
		outbound.Close()
		return
	}

	_ = s.bridge.Pipe(context.Background(), clientConn, outbound)
}

// Addr returns the listening address
func (s *HTTPProxyServer) Addr() net.Addr {
	if s.listener != nil {
		return s.listener.Addr()
	}
	return nil
}

// Close shuts down the HTTP proxy server
func (s *HTTPProxyServer) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.closed = true
	if s.server != nil {
		return s.server.Close()
	}
	return nil
}
