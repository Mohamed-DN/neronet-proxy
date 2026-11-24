package clientcore

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"sync"
	"time"
)

// The local API: newline-delimited JSON over a local transport that is never TCP. One
// request per line, at most maxLine bytes; the answer is one line, except for state.watch,
// which keeps sending state lines until the connection closes.
//
//	{"v":1,"id":"1","cmd":"state.get"}
//	{"v":1,"id":"2","cmd":"order.set","args":{"methods":["wireguard","wireguard-wss"],"forced":false}}
//
// Every command is validated as untrusted input: an unknown field, an unknown command, a
// wrong version or an oversize line is refused and changes nothing. The only way to the
// Core is through this table.
const maxLine = 16 << 10

// Request is one command.
type Request struct {
	V    int             `json:"v"`
	ID   string          `json:"id"`
	Cmd  string          `json:"cmd"`
	Args json.RawMessage `json:"args,omitempty"`
}

// Response is the answer to one command.
type Response struct {
	V     int    `json:"v"`
	ID    string `json:"id,omitempty"`
	OK    bool   `json:"ok"`
	Error string `json:"error,omitempty"`
	Code  string `json:"code,omitempty"`
	State *State `json:"state,omitempty"`
}

// Peer is who is on the other end of a connection, as the transport established it.
type Peer struct {
	UID uint32
	GID uint32
	PID int32
}

// Transport is where the local API listens and how it knows who connected. The Linux and
// macOS transport is a unix socket with a peer-credential check; the Windows one is a named
// pipe whose ACL admits only the installation's interactive user and administrators (phase 1).
// Neither is a TCP listener, and a transport that cannot establish the peer must refuse.
type Transport interface {
	Listen() (net.Listener, error)
	// Authorize returns the peer of an accepted connection, or an error if it must be refused.
	Authorize(conn net.Conn) (Peer, error)
}

// Server serves the API on a Transport.
type Server struct {
	core  *Core
	tr    Transport
	mu    sync.Mutex
	ln    net.Listener
	wg    sync.WaitGroup
	conns map[net.Conn]struct{}
}

// shutdownGrace is how long Serve waits for handlers after it has closed every connection.
const shutdownGrace = 5 * time.Second

// NewServer builds a server for a core.
func NewServer(core *Core, tr Transport) *Server { return &Server{core: core, tr: tr} }

// Serve listens and handles connections until ctx ends. When it ends, the listener and every open
// connection are closed, so a client that holds a connection and says nothing cannot keep the
// service from stopping; handlers get a few seconds to finish and are then left behind.
func (s *Server) Serve(ctx context.Context) error {
	ln, err := s.tr.Listen()
	if err != nil {
		return err
	}
	s.mu.Lock()
	s.ln = ln
	s.conns = map[net.Conn]struct{}{}
	s.mu.Unlock()
	go func() {
		<-ctx.Done()
		_ = ln.Close()
		s.mu.Lock()
		for c := range s.conns {
			_ = c.Close()
		}
		s.mu.Unlock()
	}()
	for {
		conn, err := ln.Accept()
		if err != nil {
			s.waitHandlers()
			if ctx.Err() != nil {
				return nil
			}
			return err
		}
		s.mu.Lock()
		if ctx.Err() != nil {
			s.mu.Unlock()
			_ = conn.Close()
			continue
		}
		s.conns[conn] = struct{}{}
		s.mu.Unlock()
		s.wg.Add(1)
		go func() {
			defer s.wg.Done()
			defer func() {
				s.mu.Lock()
				delete(s.conns, conn)
				s.mu.Unlock()
			}()
			s.handle(ctx, conn)
		}()
	}
}

func (s *Server) waitHandlers() {
	done := make(chan struct{})
	go func() { s.wg.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(shutdownGrace):
	}
}

func (s *Server) handle(ctx context.Context, conn net.Conn) {
	defer func() { _ = conn.Close() }()
	if _, err := s.tr.Authorize(conn); err != nil {
		// Say nothing about why: a refused peer learns no more than that it was refused.
		return
	}
	r := bufio.NewReaderSize(conn, maxLine+1)
	enc := json.NewEncoder(conn)
	for {
		_ = conn.SetReadDeadline(time.Now().Add(5 * time.Minute))
		line, err := readLine(r)
		if err != nil {
			if errors.Is(err, errLineTooLong) {
				_ = enc.Encode(Response{V: APIVersion, Code: "too_long", Error: "request too long"})
			}
			return
		}
		_ = conn.SetReadDeadline(time.Time{})
		req, perr := parseRequest(line)
		if perr != nil {
			_ = enc.Encode(Response{V: APIVersion, ID: req.ID, Code: "bad_request", Error: perr.Error()})
			continue
		}
		if req.Cmd == "state.watch" {
			if err := noArgs(req.Args); err != nil {
				_ = enc.Encode(Response{V: APIVersion, ID: req.ID, Code: "bad_args", Error: err.Error()})
				continue
			}
			s.watch(ctx, conn, enc, req)
			return
		}
		_ = enc.Encode(s.dispatch(ctx, req))
	}
}

var errLineTooLong = errors.New("line too long")

func readLine(r *bufio.Reader) ([]byte, error) {
	var buf []byte
	for {
		chunk, isPrefix, err := r.ReadLine()
		if err != nil {
			return nil, err
		}
		buf = append(buf, chunk...)
		if len(buf) > maxLine {
			return nil, errLineTooLong
		}
		if !isPrefix {
			return buf, nil
		}
	}
}

func parseRequest(line []byte) (Request, error) {
	var req Request
	dec := json.NewDecoder(bytes.NewReader(line))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil {
		return Request{}, errors.New("malformed request")
	}
	if dec.More() {
		return Request{}, errors.New("malformed request")
	}
	if len(req.ID) > 64 {
		req.ID = ""
		return req, errors.New("request id too long")
	}
	if req.V != APIVersion {
		return req, errors.New("unsupported api version")
	}
	return req, nil
}

// noArgs accepts no arguments at all: absent, null or an empty object.
func noArgs(raw json.RawMessage) error {
	var none struct{}
	return strictArgs(raw, &none)
}

func strictArgs(raw json.RawMessage, into any) error {
	if len(raw) == 0 {
		raw = []byte("{}")
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(into); err != nil {
		return errors.New("invalid arguments")
	}
	if dec.More() {
		return errors.New("invalid arguments")
	}
	return nil
}

func (s *Server) watch(ctx context.Context, conn net.Conn, enc *json.Encoder, req Request) {
	ch, cancel := s.core.Subscribe()
	defer cancel()
	// Watching never reads again; a closed peer is noticed by the failed write.
	for {
		select {
		case <-ctx.Done():
			return
		case st, ok := <-ch:
			if !ok {
				return
			}
			_ = conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			stc := st
			if err := enc.Encode(Response{V: APIVersion, ID: req.ID, OK: true, State: &stc}); err != nil {
				return
			}
		}
	}
}

func (s *Server) dispatch(ctx context.Context, req Request) Response {
	ok := func() Response {
		st := s.core.State()
		return Response{V: APIVersion, ID: req.ID, OK: true, State: &st}
	}
	fail := func(code string, err error) Response {
		return Response{V: APIVersion, ID: req.ID, Code: code, Error: err.Error()}
	}
	cctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	switch req.Cmd {
	case "state.get":
		if err := noArgs(req.Args); err != nil {
			return fail("bad_args", err)
		}
		return ok()
	case "signin.start":
		if err := noArgs(req.Args); err != nil {
			return fail("bad_args", err)
		}
		if err := s.core.SignIn(cctx); err != nil {
			return fail("signin_failed", err)
		}
		return ok()
	case "signin.cancel":
		if err := noArgs(req.Args); err != nil {
			return fail("bad_args", err)
		}
		s.core.CancelSignIn()
		return ok()
	case "connect":
		if err := noArgs(req.Args); err != nil {
			return fail("bad_args", err)
		}
		if err := s.core.Connect(cctx); err != nil {
			return fail("connect_failed", err)
		}
		return ok()
	case "disconnect":
		if err := noArgs(req.Args); err != nil {
			return fail("bad_args", err)
		}
		if err := s.core.Disconnect(cctx); err != nil {
			return fail("disconnect_failed", err)
		}
		return ok()
	case "exit.set":
		var a struct {
			Name string `json:"name"`
		}
		if err := strictArgs(req.Args, &a); err != nil {
			return fail("bad_args", err)
		}
		if err := s.core.SetExit(a.Name); err != nil {
			return fail("bad_args", err)
		}
		return ok()
	case "order.set":
		var a Order
		if err := strictArgs(req.Args, &a); err != nil {
			return fail("bad_args", err)
		}
		if err := s.core.SetOrder(a); err != nil {
			return fail("bad_args", err)
		}
		return ok()
	case "signout":
		var a struct {
			Force bool `json:"force"`
		}
		if err := strictArgs(req.Args, &a); err != nil {
			return fail("bad_args", err)
		}
		if err := s.core.SignOut(cctx, a.Force); err != nil {
			return fail("signout_failed", err)
		}
		return ok()
	}
	return fail("unknown_command", errors.New("unknown command"))
}

// Client is the other end, for interfaces written in Go and for tests.
type Client struct {
	conn net.Conn
	r    *bufio.Reader
	id   int
}

// NewClient wraps an established connection.
func NewClient(conn net.Conn) *Client { return &Client{conn: conn, r: bufio.NewReader(conn)} }

// Close closes the connection.
func (c *Client) Close() error { return c.conn.Close() }

// Do sends one command and reads one answer.
func (c *Client) Do(cmd string, args any) (*Response, error) {
	c.id++
	var raw json.RawMessage
	if args != nil {
		b, err := json.Marshal(args)
		if err != nil {
			return nil, err
		}
		raw = b
	}
	line, err := json.Marshal(Request{V: APIVersion, ID: itoa(c.id), Cmd: cmd, Args: raw})
	if err != nil {
		return nil, err
	}
	if _, err := c.conn.Write(append(line, '\n')); err != nil {
		return nil, err
	}
	return c.read()
}

// Raw sends bytes as they are, for tests of how the server treats malformed input. The write
// runs alongside the read: a server that refuses a request early answers before it has
// consumed all of it, and a synchronous transport would otherwise deadlock both ends.
func (c *Client) Raw(b []byte) (*Response, error) {
	go func() { _, _ = c.conn.Write(b) }()
	return c.read()
}

func (c *Client) read() (*Response, error) {
	_ = c.conn.SetReadDeadline(time.Now().Add(30 * time.Second))
	line, err := c.r.ReadBytes('\n')
	if err != nil {
		if errors.Is(err, io.EOF) && len(line) == 0 {
			return nil, io.EOF
		}
		return nil, err
	}
	var resp Response
	if err := json.Unmarshal(line, &resp); err != nil {
		return nil, err
	}
	return &resp, nil
}

func itoa(n int) string {
	b, _ := json.Marshal(n)
	return string(b)
}
