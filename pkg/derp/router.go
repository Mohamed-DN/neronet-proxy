package derp

import (
	"errors"
	"sync"
	"sync/atomic"
)

var (
	ErrPeerNotFound = errors.New("destination peer not connected to relay")
)

// Session represents an active client connection on the relay
type Session interface {
	SendFrame(frame *Frame) error
	PublicKey() [PubKeySize]byte
	Close() error
}

// Router maintains the thread-safe map of active client sessions keyed by public key
type Router struct {
	mu             sync.RWMutex
	sessions       map[[PubKeySize]byte]Session
	routedPackets  uint64
	droppedPackets uint64
}

// NewRouter creates a new DERP-v4 packet router
func NewRouter() *Router {
	return &Router{
		sessions: make(map[[PubKeySize]byte]Session),
	}
}

// Register adds a client session to the routing table
func (r *Router) Register(sess Session) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.sessions[sess.PublicKey()] = sess
}

// Unregister removes a client session from the routing table
func (r *Router) Unregister(pubKey [PubKeySize]byte) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.sessions, pubKey)
}

// RouteForward forwards an opaque encrypted frame to the destination public key
func (r *Router) RouteForward(srcPub [PubKeySize]byte, destPub [PubKeySize]byte, payload []byte) error {
	r.mu.RLock()
	destSess, ok := r.sessions[destPub]
	r.mu.RUnlock()

	if !ok {
		atomic.AddUint64(&r.droppedPackets, 1)
		return ErrPeerNotFound
	}

	recvFrame := &Frame{
		Type:       FrameRecvPacket,
		DestPubKey: destPub,
		SrcPubKey:  srcPub,
		Payload:    payload,
	}

	err := destSess.SendFrame(recvFrame)
	if err != nil {
		atomic.AddUint64(&r.droppedPackets, 1)
		return err
	}

	atomic.AddUint64(&r.routedPackets, 1)
	return nil
}

// ActiveSessionsCount returns the number of connected peers
func (r *Router) ActiveSessionsCount() int {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return len(r.sessions)
}

// Metrics returns packet delivery counters
func (r *Router) Metrics() (routed uint64, dropped uint64) {
	return atomic.LoadUint64(&r.routedPackets), atomic.LoadUint64(&r.droppedPackets)
}
