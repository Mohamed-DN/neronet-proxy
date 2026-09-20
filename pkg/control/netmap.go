package control

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
)

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
