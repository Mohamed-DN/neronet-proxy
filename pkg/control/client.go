package control

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sync"
	"time"

	"github.com/sovereign/proxy/v4/pkg/acl"
	"github.com/sovereign/proxy/v4/pkg/crypto"
	"github.com/sovereign/proxy/v4/pkg/posture"
	"github.com/sovereign/proxy/v4/pkg/routes"
)

// ClientVersion is reported to the control plane on registration.
const ClientVersion = "v4.0.0"

// Client interacts with the SovereignMesh Control Plane Service
type Client struct {
	serverURL  string
	httpClient *http.Client
	authToken  string

	// The heartbeat loop and any caller that issues requests concurrently both
	// touch this, so it is guarded. Heartbeats are sent from one goroutine today,
	// which is exactly the kind of assumption that stops being true quietly.
	rttMu   sync.RWMutex
	lastRTT time.Duration
}

func (c *Client) recordRTT(d time.Duration) {
	c.rttMu.Lock()
	c.lastRTT = d
	c.rttMu.Unlock()
}

// lastRTTMillis returns the previous round trip in whole milliseconds, rounded up
// so a sub-millisecond local round trip reports 1 rather than 0, which is the
// value reserved for "not measured yet".
func (c *Client) lastRTTMillis() uint32 {
	c.rttMu.RLock()
	d := c.lastRTT
	c.rttMu.RUnlock()

	if d <= 0 {
		return 0
	}

	ms := (d + time.Millisecond - 1) / time.Millisecond
	if ms > 60000 {
		return 60000
	}
	return uint32(ms)
}

// NewClient creates a new control plane API client
func NewClient(serverURL string) *Client {
	return &Client{
		serverURL: serverURL,
		httpClient: &http.Client{
			Timeout: 10 * time.Second,
		},
	}
}

// newRequest builds a POST carrying the enrolment token.
//
// The token travels in an Authorization header rather than in each request struct.
// Only RegisterRequest has an AuthToken field, so a body-only scheme would leave
// every other endpoint unauthenticated -- which is what left discovery open to any
// caller that could reach the port.
func (c *Client) newRequest(ctx context.Context, path string, body any) (*http.Request, error) {
	data, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}

	req, err := http.NewRequestWithContext(ctx, "POST", fmt.Sprintf("%s%s", c.serverURL, path), bytes.NewReader(data))
	if err != nil {
		return nil, err
	}

	req.Header.Set("Content-Type", "application/json")
	if c.authToken != "" {
		req.Header.Set("Authorization", "Bearer "+c.authToken)
	}

	return req, nil
}

// SetAuthToken sets the shared enrolment token sent with registration requests.
//
// RegisterRequest has always carried an AuthToken field, but nothing ever populated
// it, so the control plane had no way to tell an authorised node from any process
// that could reach the port.
func (c *Client) SetAuthToken(token string) {
	c.authToken = token
}

// Register registers a local node with the control plane
func (c *Client) Register(
	ctx context.Context,
	pubKey [crypto.KeySize]byte,
	role string,
	endpoints []EndpointDesc,
	capability CapabilityDesc,
) (*RegisterResponse, error) {
	reqBody := RegisterRequest{
		PublicKeyHex:  hex.EncodeToString(pubKey[:]),
		Role:          role,
		Endpoints:     endpoints,
		AuthToken:     c.authToken,
		ClientVersion: ClientVersion,
		Capability:    capability,
	}

	req, err := c.newRequest(ctx, "/v4/control/register", reqBody)
	if err != nil {
		return nil, err
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("control plane register failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("control plane returned error status %d", resp.StatusCode)
	}

	var regResp RegisterResponse
	if err := json.NewDecoder(resp.Body).Decode(&regResp); err != nil {
		return nil, err
	}

	return &regResp, nil
}

// SendHeartbeat sends periodic telemetry and liveness heartbeats
func (c *Client) SendHeartbeat(
	ctx context.Context,
	nodeID string,
	endpoints []EndpointDesc,
	circuits uint32,
	cpu uint32,
	mem uint32,
	bat uint32,
	onBat bool,
) (*HeartbeatResponse, error) {
	return c.SendHeartbeatWithPosture(ctx, nodeID, endpoints, circuits, cpu, mem, bat, onBat, nil)
}

// SendHeartbeatWithPosture sends heartbeat including continuous posture attestation telemetry
func (c *Client) SendHeartbeatWithPosture(
	ctx context.Context,
	nodeID string,
	endpoints []EndpointDesc,
	circuits uint32,
	cpu uint32,
	mem uint32,
	bat uint32,
	onBat bool,
	post *posture.PeerAttestation,
) (*HeartbeatResponse, error) {
	reqBody := HeartbeatRequest{
		NodeID:          nodeID,
		Endpoints:       endpoints,
		ActiveCircuits:  circuits,
		CPUUsagePct:     cpu,
		MemoryUsageMB:   mem,
		BatteryLevelPct: bat,
		OnBatteryPower:  onBat,
		RTTMillis:       c.lastRTTMillis(),
		Posture:         post,
	}

	req, err := c.newRequest(ctx, "/v4/control/heartbeat", reqBody)
	if err != nil {
		return nil, err
	}

	// Measured around the request itself, so it covers the network path plus the
	// control plane's own handling. The result is carried on the next heartbeat:
	// this one's body is already sealed.
	sentAt := time.Now()
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	c.recordRTT(time.Since(sentAt))
	defer resp.Body.Close()

	var hbResp HeartbeatResponse
	if err := json.NewDecoder(resp.Body).Decode(&hbResp); err != nil {
		return nil, err
	}

	return &hbResp, nil
}

// DiscoverExitBridges queries candidate exit bridges
func (c *Client) DiscoverExitBridges(
	ctx context.Context,
	country string,
	asn uint32,
	ipClass string,
	limit int,
) ([]DiscoveredBridgeInfo, error) {
	reqBody := DiscoverRequest{
		TargetCountry: country,
		TargetASN:     asn,
		IPClass:       ipClass,
		Limit:         limit,
	}

	req, err := c.newRequest(ctx, "/v4/control/discover", reqBody)
	if err != nil {
		return nil, err
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	var discResp DiscoverResponse
	if err := json.NewDecoder(resp.Body).Decode(&discResp); err != nil {
		return nil, err
	}

	return discResp.Bridges, nil
}

// RequestCircuitPath obtains a 3-hop onion circuit path from the control plane
func (c *Client) RequestCircuitPath(ctx context.Context, country string) (*CircuitResponse, error) {
	reqBody := CircuitRequest{
		TargetCountry: country,
		HopCount:      3,
	}

	req, err := c.newRequest(ctx, "/v4/control/circuit", reqBody)
	if err != nil {
		return nil, err
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, errors.New("failed to build circuit path from control plane")
	}

	var circResp CircuitResponse
	if err := json.NewDecoder(resp.Body).Decode(&circResp); err != nil {
		return nil, err
	}

	return &circResp, nil
}

// SyncACLs retrieves compiled ACL filter table for a client node
func (c *Client) SyncACLs(ctx context.Context, nodeID string, currentEpoch uint64) (*acl.CompiledPeerPolicy, uint64, error) {
	reqBody := ACLSyncRequest{
		NodeID:      nodeID,
		PolicyEpoch: currentEpoch,
	}

	req, err := c.newRequest(ctx, "/v4/control/sync-acls", reqBody)
	if err != nil {
		return nil, 0, err
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, 0, fmt.Errorf("sync ACLs failed with status %d", resp.StatusCode)
	}

	var syncResp ACLSyncResponse
	if err := json.NewDecoder(resp.Body).Decode(&syncResp); err != nil {
		return nil, 0, err
	}

	return syncResp.Policy, syncResp.NewPolicyEpoch, nil
}

// SyncRoutes retrieves advertised subnet routes for a client node
func (c *Client) SyncRoutes(ctx context.Context, nodeID string, currentEpoch uint64) ([]*routes.NetworkRoute, uint64, error) {
	reqBody := RouteSyncRequest{
		NodeID:     nodeID,
		RouteEpoch: currentEpoch,
	}

	req, err := c.newRequest(ctx, "/v4/control/sync-routes", reqBody)
	if err != nil {
		return nil, 0, err
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, 0, fmt.Errorf("sync routes failed with status %d", resp.StatusCode)
	}

	var syncResp RouteSyncResponse
	if err := json.NewDecoder(resp.Body).Decode(&syncResp); err != nil {
		return nil, 0, err
	}

	return syncResp.Routes, syncResp.NewRouteEpoch, nil
}
