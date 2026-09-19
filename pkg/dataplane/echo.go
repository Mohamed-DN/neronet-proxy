package dataplane

import (
	"encoding/binary"
	"errors"
	"io"
	"net"
	"strconv"
	"sync"
)

// The measurement protocol. The first byte of a connection selects what the
// responder does with it. One byte rather than a negotiation because the point is
// to measure the transport, and anything more would be measured along with it.
const (
	// ModeByteEcho copies every byte back. Used for round trip latency.
	ModeByteEcho byte = 'E'
	// ModeByteDrain reads until the peer closes its write side, then answers with
	// the byte count as eight bytes, big endian. Used for send throughput.
	ModeByteDrain byte = 'D'
	// ModeByteSource writes a fixed pattern until the peer closes. Used for
	// receive throughput.
	ModeByteSource byte = 'S'
)

// sourcePattern is what ModeByteSource writes. It is not zeroes: a stream of zeroes
// compresses in any layer that might be added later, and a throughput figure
// measured on it would not be the figure a real payload gets.
var sourcePattern = func() []byte {
	b := make([]byte, 64*1024)
	for i := range b {
		b[i] = byte(i*31 + 7)
	}
	return b
}()

// EchoResponder answers measurement connections on an overlay address.
//
// It exists for the WP-201 spike. It is started only when the spike configuration
// names a port, it is never reachable from outside the overlay, and it must not
// survive into a production node.
type EchoResponder struct {
	ln net.Listener

	mu     sync.Mutex
	closed bool
	wg     sync.WaitGroup

	// Logf receives one line per accepted connection. Nil discards them.
	Logf func(format string, args ...any)
}

// ListenEcho starts the responder on the device's overlay address.
func ListenEcho(d *Device, port uint16, logf func(format string, args ...any)) (*EchoResponder, error) {
	addr := d.LocalAddr()
	if !addr.IsValid() {
		return nil, ErrNoAddresses
	}
	ln, err := d.Listen("tcp", net.JoinHostPort(addr.String(), strconv.FormatUint(uint64(port), 10)))
	if err != nil {
		return nil, err
	}

	r := &EchoResponder{ln: ln, Logf: logf}
	r.wg.Add(1)
	go r.serve()
	return r, nil
}

// Addr reports where the responder is listening.
func (r *EchoResponder) Addr() net.Addr { return r.ln.Addr() }

func (r *EchoResponder) serve() {
	defer r.wg.Done()
	for {
		conn, err := r.ln.Accept()
		if err != nil {
			r.mu.Lock()
			closed := r.closed
			r.mu.Unlock()
			if closed {
				return
			}
			if errors.Is(err, net.ErrClosed) {
				return
			}
			continue
		}
		r.wg.Add(1)
		go func() {
			defer r.wg.Done()
			r.handle(conn)
		}()
	}
}

func (r *EchoResponder) handle(conn net.Conn) {
	defer conn.Close()

	var mode [1]byte
	if _, err := io.ReadFull(conn, mode[:]); err != nil {
		return
	}
	if r.Logf != nil {
		r.Logf("[dataplane] measurement connection from %s mode %q", conn.RemoteAddr(), string(mode[0]))
	}

	switch mode[0] {
	case ModeByteEcho:
		_, _ = io.Copy(conn, conn)
	case ModeByteDrain:
		n, _ := io.Copy(io.Discard, conn)
		var count [8]byte
		binary.BigEndian.PutUint64(count[:], uint64(n))
		_, _ = conn.Write(count[:])
	case ModeByteSource:
		for {
			if _, err := conn.Write(sourcePattern); err != nil {
				return
			}
		}
	}
}

// Close stops the responder and waits for its connections to finish.
func (r *EchoResponder) Close() error {
	r.mu.Lock()
	if r.closed {
		r.mu.Unlock()
		return nil
	}
	r.closed = true
	r.mu.Unlock()

	err := r.ln.Close()
	r.wg.Wait()
	return err
}
