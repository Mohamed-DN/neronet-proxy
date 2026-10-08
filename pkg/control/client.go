package control

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/curve25519"
	"golang.org/x/crypto/hkdf"

	"github.com/sovereign/proxy/v4/pkg/acl"
	"github.com/sovereign/proxy/v4/pkg/crypto"
	"github.com/sovereign/proxy/v4/pkg/posture"
	"github.com/sovereign/proxy/v4/pkg/routes"
)

// ClientVersion is reported to the control plane on registration.
const ClientVersion = "v4.0.0"

// ErrNodeUnknown is returned when the control plane has no record of this node.
// It is recoverable: the node still holds its identity and can enrol again.
var ErrNodeUnknown = errors.New("control plane has no record of this node")

// ErrUnauthorized is returned when the control plane requires renewed registration:
// it expired, was revoked, or belongs to a registration the control plane no longer
// has. Also recoverable by enrolling again, which proves possession of the key.
// A restored database can also invalidate the server-issued observation session.
var ErrUnauthorized = errors.New("control plane requires renewed node registration")

// Client interacts with the SovereignMesh Control Plane Service
type Client struct {
	serverURL  string
	httpClient *http.Client

	// enrolToken is the fleet-wide enrolment token. It authorises enrolling a key
	// and listing exit bridges; it does not identify a node, and the control plane
	// refuses it on the per-node endpoints.
	enrolToken string

	// authToken is this node's own credential, issued by registration and rotated
	// by heartbeats. It is what the per-node endpoints accept.
	authToken string

	// The heartbeat loop and any caller that issues requests concurrently both
	// touch this, so it is guarded. Heartbeats are sent from one goroutine today,
	// which is exactly the kind of assumption that stops being true quietly.
	rttMu   sync.RWMutex
	lastRTT time.Duration

	telemetryMu      sync.Mutex
	telemetrySession string
	telemetrySeq     uint64
	telemetrySource  func() (*NativeTelemetry, error)
}

// SetTelemetrySource installs the native measurement provider. A control plane
// without a telemetry_session in registration receives the unchanged old wire body.
func (c *Client) SetTelemetrySource(source func() (*NativeTelemetry, error)) {
	c.telemetryMu.Lock()
	defer c.telemetryMu.Unlock()
	c.telemetrySource = source
}

func (c *Client) nativeTelemetry() (*NativeTelemetry, error) {
	c.telemetryMu.Lock()
	defer c.telemetryMu.Unlock()
	if c.telemetrySession == "" || c.telemetrySource == nil {
		return nil, nil
	}
	snapshot, err := c.telemetrySource()
	if err != nil || snapshot == nil {
		return nil, err
	}
	if c.telemetrySeq == ^uint64(0) {
		return nil, errors.New("native telemetry sequence exhausted")
	}
	c.telemetrySeq++
	copy := *snapshot
	copy.SessionID = c.telemetrySession
	copy.Sequence = fmt.Sprint(c.telemetrySeq)
	return &copy, nil
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

// NewClientWithCA is NewClient for a control plane whose TLS certificate is signed by
// the CA in caPEM rather than by one the system trusts: a deployment's own CA, or the
// development CA scripts/dev/gen-certs.sh writes.
//
// Only the CAs in caPEM are trusted, not the system roots as well. A node pinned to
// its control plane's CA must not accept a certificate some other CA issued for the
// same name, which is what adding to the system pool would allow.
func NewClientWithCA(serverURL string, caPEM []byte) (*Client, error) {
	if !strings.HasPrefix(serverURL, "https://") {
		return nil, fmt.Errorf("a control plane CA was given, but %s is not an https URL", serverURL)
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(caPEM) {
		return nil, errors.New("the control plane CA file holds no PEM certificate")
	}

	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.TLSClientConfig = &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12}

	c := NewClient(serverURL)
	c.httpClient.Transport = transport
	return c, nil
}

// newRequest builds a POST carrying the node credential, or the enrolment token
// until the node has a credential.
//
// The token travels in an Authorization header rather than in each request struct.
// Only RegisterRequest has an AuthToken field, so a body-only scheme would leave
// every other endpoint unauthenticated -- which is what left discovery open to any
// caller that could reach the port.
func (c *Client) newRequest(ctx context.Context, path string, body any) (*http.Request, error) {
	token := c.authToken
	if token == "" {
		token = c.enrolToken
	}
	return c.newRequestWithToken(ctx, path, body, token)
}

func (c *Client) newRequestWithToken(ctx context.Context, path string, body any, token string) (*http.Request, error) {
	data, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}

	req, err := http.NewRequestWithContext(ctx, "POST", fmt.Sprintf("%s%s", c.serverURL, path), bytes.NewReader(data))
	if err != nil {
		return nil, err
	}

	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}

	return req, nil
}

// SetAuthToken sets the fleet-wide enrolment token.
//
// It is sent when enrolling and when listing exit bridges. Once registration has
// issued this node its own credential, every other request carries that instead:
// the enrolment token names no node, and the control plane does not accept it as
// one.
func (c *Client) SetAuthToken(token string) {
	c.enrolToken = token
}

// errorFromResponse turns a refused request into an error that carries the control
// plane's reason, so an operator reading the node log sees "this key has been
// revoked" rather than a bare status code.
func errorFromResponse(what string, resp *http.Response) error {
	var body struct {
		Error string `json:"error"`
	}
	_ = json.NewDecoder(io.LimitReader(resp.Body, 4096)).Decode(&body)
	if body.Error != "" {
		return fmt.Errorf("%s: status %d: %s", what, resp.StatusCode, body.Error)
	}
	return fmt.Errorf("%s: status %d", what, resp.StatusCode)
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
	telemetry, err := c.nativeTelemetry()
	if err != nil {
		// A measurement failure must not suppress liveness, policy or revocations.
		// Omit the observation so its server freshness expires independently.
		log.Printf("[CONTROL] Native telemetry unavailable: %v", err)
	}
	reqBody := HeartbeatRequest{
		Telemetry:       telemetry,
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

	// The control plane answers 404 when it has no row for this node. That happens
	// after the control plane database is rebuilt, restored from a backup taken
	// before this node enrolled, or wiped. The node used to log "did not acknowledge
	// heartbeat" once every fifteen seconds forever with no way back: its identity
	// was still valid and nothing ever tried to enrol it again. Naming the condition
	// is what lets the caller recover from it.
	if resp.StatusCode == http.StatusNotFound {
		return nil, ErrNodeUnknown
	}
	if resp.StatusCode == http.StatusUnauthorized {
		c.authToken = ""
		return nil, ErrUnauthorized
	}
	if resp.StatusCode == http.StatusConflict {
		var conflict struct {
			Error string `json:"error"`
			Code  string `json:"code"`
		}
		_ = json.NewDecoder(io.LimitReader(resp.Body, 4096)).Decode(&conflict)
		if conflict.Code == "native_telemetry_session_changed" {
			return nil, fmt.Errorf("%w: native telemetry session changed", ErrUnauthorized)
		}
		return nil, fmt.Errorf("heartbeat refused: status 409: %s", conflict.Error)
	}
	if resp.StatusCode != http.StatusOK {
		return nil, errorFromResponse("heartbeat refused", resp)
	}

	var hbResp HeartbeatResponse
	if err := json.NewDecoder(resp.Body).Decode(&hbResp); err != nil {
		return nil, err
	}

	if hbResp.NewCredential != "" {
		c.authToken = hbResp.NewCredential
	}

	return &hbResp, nil
}

// GetChallenge requests a single-use challenge nonce from the control plane
func (c *Client) GetChallenge(ctx context.Context) (*ChallengeResponse, error) {
	req, err := c.newRequest(ctx, "/v4/control/challenge", ChallengeRequest{})
	if err != nil {
		return nil, err
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("control plane challenge request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("control plane challenge returned status %d", resp.StatusCode)
	}

	var chResp ChallengeResponse
	if err := json.NewDecoder(resp.Body).Decode(&chResp); err != nil {
		return nil, err
	}

	return &chResp, nil
}

// registrationProof is HMAC-SHA256(key, nonce || node public key || role). The role
// is covered so that a proof made for one role cannot enrol the key as another.
func registrationProof(derivedKey, nonce []byte, nodePub [crypto.KeySize]byte, role string) []byte {
	mac := hmac.New(sha256.New, derivedKey)
	mac.Write(nonce)
	mac.Write(nodePub[:])
	mac.Write([]byte(role))
	return mac.Sum(nil)
}

// RegisterWithProof enrols a node using the ADR 0017 challenge-response proof of
// possession. It is the only way to register: the control plane refuses a
// registration that does not prove the node holds its private key.
//
// enrolmentString is a pre-auth key, optionally as "nnk1:<key>:<control plane
// fingerprint>". It may be empty when the fleet enrolment token is set, or when this
// key is already enrolled.
func (c *Client) RegisterWithProof(
	ctx context.Context,
	nodePriv [crypto.KeySize]byte,
	nodePub [crypto.KeySize]byte,
	role string,
	endpoints []EndpointDesc,
	capability CapabilityDesc,
	enrolmentString string,
) (*RegisterResponse, error) {
	var preauthKey string
	var expectedFingerprint string

	trimmedEnrol := strings.TrimSpace(enrolmentString)
	if strings.HasPrefix(trimmedEnrol, "nnk1:") {
		parts := strings.Split(trimmedEnrol, ":")
		if len(parts) >= 2 {
			preauthKey = parts[1]
		}
		if len(parts) >= 3 {
			expectedFingerprint = parts[2]
		}
	} else {
		preauthKey = trimmedEnrol
	}

	ch, err := c.GetChallenge(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed fetching challenge: %w", err)
	}

	rawCpPub, err := hex.DecodeString(ch.ControlPlanePubHex)
	if err != nil || len(rawCpPub) != 32 {
		return nil, fmt.Errorf("invalid control plane public key: %v", err)
	}

	if expectedFingerprint != "" {
		hash := sha256.Sum256(rawCpPub)
		actualFingerprint := hex.EncodeToString(hash[:])
		if !strings.EqualFold(actualFingerprint, expectedFingerprint) {
			// The expected value comes from the enrolment string, which also carries the
			// pre-auth key, so it is not repeated in an error that ends up in the log.
			return nil, fmt.Errorf("control plane fingerprint mismatch: %s is not the one in the enrolment string", actualFingerprint)
		}
	}

	sharedSecret, err := curve25519.X25519(nodePriv[:], rawCpPub)
	if err != nil {
		return nil, fmt.Errorf("Diffie-Hellman derivation failed: %w", err)
	}

	hkdfReader := hkdf.New(sha256.New, sharedSecret, nil, []byte("neronet/v4/register"))
	derivedKey := make([]byte, 32)
	if _, err := io.ReadFull(hkdfReader, derivedKey); err != nil {
		return nil, fmt.Errorf("HKDF key derivation failed: %w", err)
	}

	nonceBytes, err := hex.DecodeString(ch.Nonce)
	if err != nil {
		return nil, fmt.Errorf("invalid nonce hex: %w", err)
	}

	proofHex := hex.EncodeToString(registrationProof(derivedKey, nonceBytes, nodePub, role))

	reqBody := RegisterRequest{
		PublicKeyHex:  hex.EncodeToString(nodePub[:]),
		Role:          role,
		Endpoints:     endpoints,
		AuthToken:     c.enrolToken,
		ClientVersion: ClientVersion,
		Capability:    capability,
		PreAuthKey:    preauthKey,
		Nonce:         ch.Nonce,
		Proof:         proofHex,
	}

	// Registration always carries the enrolment token, never a credential from an
	// earlier registration: that one may belong to a registration the control plane
	// no longer has, and the proof, not the credential, is what identifies the node.
	req, err := c.newRequestWithToken(ctx, "/v4/control/register", reqBody, c.enrolToken)
	if err != nil {
		return nil, err
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("control plane register failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, errorFromResponse("control plane refused registration", resp)
	}

	var regResp RegisterResponse
	if err := json.NewDecoder(resp.Body).Decode(&regResp); err != nil {
		return nil, err
	}

	if regResp.Credential != "" {
		c.authToken = regResp.Credential
	}
	c.telemetryMu.Lock()
	c.telemetrySession = regResp.TelemetrySession
	c.telemetrySeq = 0
	c.telemetryMu.Unlock()

	return &regResp, nil
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
