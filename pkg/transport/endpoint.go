package transport

import (
	"net/netip"
	"sync/atomic"

	"golang.zx2c4.com/wireguard/conn"
)

// endpoint is the conn.Endpoint wireguard-go sees. It names the transport a packet came
// from or goes to, wrapping the transport's own endpoint, so wireguard-go's roaming
// works across transports as it does within one: the first authenticated packet from a
// new place moves the peer there, whichever transport that place is on.
//
// Three kinds, told apart by their fields:
//
//	concrete   tr and inner are set: a place on one transport.
//	peer-level tr is empty and a peer is set: "this peer, wherever it is reachable". It
//	           is what the data plane hands wireguard-go as the peer's endpoint, and it
//	           is what lets the Mux race an initiation over every path of that peer.
//	none       tr is "none": the peer has no path. Sends fail.
type endpoint struct {
	tr    string
	inner conn.Endpoint

	// peer is set for a peer-level endpoint, and cached on a concrete one the first time
	// the Mux works out whose it is. Read from wireguard-go's sender goroutines and
	// written from the Mux, hence atomic.
	peer atomic.Pointer[peerState]
}

const trNone = "none"

func newConcrete(tr string, inner conn.Endpoint) *endpoint {
	return &endpoint{tr: tr, inner: inner}
}

func newPeerLevel(ps *peerState) *endpoint {
	e := &endpoint{}
	e.peer.Store(ps)
	return e
}

func (e *endpoint) isPeerLevel() bool { return e.inner == nil && e.tr == "" }

func (e *endpoint) ClearSrc() {
	if e.inner != nil {
		e.inner.ClearSrc()
	}
}

func (e *endpoint) SrcToString() string {
	if e.inner != nil {
		return e.inner.SrcToString()
	}
	return ""
}

// DstToString is what wireguard-go prints for the peer's endpoint, and what UAPI
// reports: "<transport>://<address>". The data plane reads the transport in use from it.
func (e *endpoint) DstToString() string {
	switch {
	case e.inner != nil:
		return e.tr + "://" + e.inner.DstToString()
	case e.tr == trNone:
		return trNone + "://"
	default:
		if ps := e.peer.Load(); ps != nil {
			return "peer://" + ps.key
		}
		return "peer://"
	}
}

func (e *endpoint) DstToBytes() []byte {
	if e.inner != nil {
		return e.inner.DstToBytes()
	}
	return nil
}

func (e *endpoint) DstIP() netip.Addr {
	if e.inner != nil {
		return e.inner.DstIP()
	}
	return netip.Addr{}
}

func (e *endpoint) SrcIP() netip.Addr {
	if e.inner != nil {
		return e.inner.SrcIP()
	}
	return netip.Addr{}
}

// Scheme returns the transport an endpoint string names, as UAPI reports it: the part
// before "://", or "udp" for a bare host:port. It is "" for a peer-level or empty
// endpoint, which names no transport yet.
func Scheme(endpoint string) string {
	for i := 0; i+2 < len(endpoint); i++ {
		if endpoint[i] == ':' && endpoint[i+1] == '/' && endpoint[i+2] == '/' {
			switch s := endpoint[:i]; s {
			case "peer", trNone:
				return ""
			default:
				return s
			}
		}
	}
	if endpoint == "" {
		return ""
	}
	return UDP
}
