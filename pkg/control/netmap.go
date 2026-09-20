package control

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/sovereign/proxy/v4/pkg/acl"
	"github.com/sovereign/proxy/v4/pkg/routes"
)

// The netmap is one complete, versioned document per node: this node's overlay
// addresses, the peers it may talk to with their keys and endpoints, the compiled
// policy its filter enforces, the routes it installs and the keys it must drop.
//
// It replaces, on the node side, the two separate epochs the node used to reconcile.
// The control plane still keeps both internally and still answers /v4/control/sync-acls
// and /v4/control/sync-routes for a node running without a data plane; a node with one
// sees one number.
//
// The struct tags are the contract. See README.md: the Node.js bridge follows them.

// NetmapRequest asks for the document. Version is what the node currently holds, 0
// when it holds none.
type NetmapRequest struct {
	NodeID  string `json:"node_id"`
	Version uint64 `json:"version"`
}

// NetmapSelf is how this node is addressed inside the overlay.
type NetmapSelf struct {
	OverlayIPv4 string `json:"overlay_ipv4"`
	OverlayIPv6 string `json:"overlay_ipv6"`

	// MTU is a configured constant, not a discovered one. A path that cannot carry
	// it will black-hole large packets; there is no MTU discovery yet.
	MTU int `json:"mtu"`

	// ListenPort is the UDP port every node in the deployment binds for WireGuard.
	ListenPort uint16 `json:"listen_port"`
}

// NetmapPeer is one node this node may talk to.
type NetmapPeer struct {
	NodeID string `json:"node_id"`

	// PublicKeyHex is the peer's X25519 identity key, which is also its WireGuard
	// key. There is no second key hierarchy.
	PublicKeyHex string `json:"public_key_hex"`

	// AllowedIPs are the prefixes this peer may use as a source address and that are
	// routed to it: its overlay /32 and /128, plus any subnet the policy lets this
	// node reach through it.
	AllowedIPs []string `json:"allowed_ips"`

	// Endpoints are candidate "ip:port" addresses, IPv6 bracketed. Empty means the
	// peer is only reachable once it has spoken first.
	Endpoints []string `json:"endpoints"`

	// DERPRegion is empty until something records one: no column holds it and
	// nothing measures it. The control plane sends null rather than a plausible
	// region name.
	DERPRegion string `json:"derp_region"`

	KeepaliveSeconds uint16 `json:"keepalive_seconds"`
}

// NetmapResponse is the document. When Unchanged is true the node already holds this
// version and every other field is absent.
type NetmapResponse struct {
	Version   uint64 `json:"version"`
	Unchanged bool   `json:"unchanged"`

	Self        NetmapSelf              `json:"self"`
	Peers       []NetmapPeer            `json:"peers"`
	ACL         *acl.CompiledPeerPolicy `json:"acl"`
	Routes      []*routes.NetworkRoute  `json:"routes"`
	RevokedKeys []string                `json:"revoked_keys"`

	// GeneratedAtUnix is the control plane's clock when the document was built. The
	// node measures staleness against it.
	GeneratedAtUnix int64 `json:"generated_at_unix"`

	// MaxStalenessSeconds is how long the node may keep running on this document
	// with the control plane unreachable. Past it the node removes every peer.
	MaxStalenessSeconds int64 `json:"max_staleness_seconds"`
}

// Netmap fetches the document for one node.
//
// A 404 is returned as ErrNodeUnknown, for the same reason the heartbeat does: the
// control plane's database was rebuilt or restored and the node has to enrol again
// rather than retry forever.
func (c *Client) Netmap(ctx context.Context, nodeID string, version uint64) (*NetmapResponse, error) {
	req, err := c.newRequest(ctx, "/v4/control/netmap", NetmapRequest{NodeID: nodeID, Version: version})
	if err != nil {
		return nil, err
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNotFound {
		return nil, ErrNodeUnknown
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("netmap fetch failed with status %d", resp.StatusCode)
	}

	var netmap NetmapResponse
	if err := json.NewDecoder(resp.Body).Decode(&netmap); err != nil {
		return nil, err
	}

	return &netmap, nil
}
