package clientcore

import (
	"context"
	"errors"
	"fmt"

	"github.com/sovereign/proxy/v4/pkg/control"
	"github.com/sovereign/proxy/v4/pkg/crypto"
)

// ControlEnroller enrols with the node agent's own control client, so the app joins the mesh
// by exactly the path a node does: a challenge, a proof of possession of the installation
// key, and the single-use grant the console issued at approval.
type ControlEnroller struct {
	Client *control.Client
}

// Enrol registers the installation key as a client node.
func (e ControlEnroller) Enrol(ctx context.Context, key *crypto.Keypair, grant Grant) (*Enrolment, error) {
	if e.Client == nil {
		return nil, errors.New("clientcore: no control client")
	}
	if grant.Role != "" && grant.Role != "CLIENT_ORIGIN" {
		return nil, fmt.Errorf("clientcore: grant is for role %q, an app enrols as a client", grant.Role)
	}
	resp, err := e.Client.RegisterWithProof(ctx, key.PrivateKey, key.PublicKey, "CLIENT_ORIGIN", nil, control.CapabilityDesc{}, grant.PreauthKey)
	if err != nil {
		return nil, err
	}
	if resp.AssignedNodeID != grant.NodeID {
		// The console and the app must agree on which node this is.
		return nil, errors.New("clientcore: the console enrolled a different node than the grant named")
	}
	if resp.OverlayIPv4 == "" {
		return nil, errors.New("clientcore: the console assigned no overlay address")
	}
	return &Enrolment{NodeID: resp.AssignedNodeID, OverlayIPv4: resp.OverlayIPv4, OverlayIPv6: resp.OverlayIPv6}, nil
}
