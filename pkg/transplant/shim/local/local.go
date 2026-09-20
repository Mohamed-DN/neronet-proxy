// Package local replaces tailscale.com/client/local for the carved DERP server.
//
// The upstream package talks to a local tailscaled over its Unix socket, which
// NeroNet does not run. The DERP server uses it in one place, to ask whether a
// connecting client key belongs to the tailnet. Here every such query fails, so a
// server configured to verify clients against a local daemon rejects every
// client (fail closed). Admission is done with the server's URL-based check
// (verifyClientsURL), which the control plane answers from the netmap.
package local

import (
	"context"
	"errors"

	"github.com/sovereign/proxy/v4/third_party/tailscale/types/key"
)

// ErrPeerNotFound is returned by WhoIsNodeKey for an unknown key. The DERP server
// compares against it by identity.
var ErrPeerNotFound = errors.New("peer not found")

// ErrNoLocalDaemon is returned by every query.
var ErrNoLocalDaemon = errors.New("no local tailscaled in NeroNet: verify clients with an admission URL")

// Client mirrors the two fields the DERP server sets.
type Client struct {
	Socket        string
	UseSocketOnly bool
}

// WhoIsResponse is the subset of the upstream response the DERP server reads,
// which is none of it: the server only looks at the error.
type WhoIsResponse struct{}

// Status carries the node's own key, which the server's health check reads.
type Status struct {
	Self struct{ PublicKey key.NodePublic }
}

// WhoIsNodeKey always fails.
func (c *Client) WhoIsNodeKey(ctx context.Context, k key.NodePublic) (*WhoIsResponse, error) {
	return nil, ErrNoLocalDaemon
}

// StatusWithoutPeers always fails.
func (c *Client) StatusWithoutPeers(ctx context.Context) (*Status, error) {
	return nil, ErrNoLocalDaemon
}
