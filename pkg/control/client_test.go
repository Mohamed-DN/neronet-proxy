package control

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/sovereign/proxy/v4/pkg/crypto"
	"golang.org/x/crypto/curve25519"
	"golang.org/x/crypto/hkdf"
)

func TestGetChallenge(t *testing.T) {
	nonce := "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	cpPub := "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210"

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v4/control/challenge" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(ChallengeResponse{
			Nonce:              nonce,
			ControlPlanePubHex: cpPub,
			ExpiresAt:          "2026-09-21T18:00:00Z",
		})
	}))
	defer server.Close()

	client := NewClient(server.URL)
	ch, err := client.GetChallenge(context.Background())
	if err != nil {
		t.Fatalf("GetChallenge failed: %v", err)
	}
	if ch.Nonce != nonce {
		t.Errorf("got nonce %s, want %s", ch.Nonce, nonce)
	}
	if ch.ControlPlanePubHex != cpPub {
		t.Errorf("got cp pub %s, want %s", ch.ControlPlanePubHex, cpPub)
	}
}

func TestRegisterWithProof(t *testing.T) {
	// Generate simulated Control Plane X25519 keypair
	var cpPriv, cpPub [crypto.KeySize]byte
	if _, err := io.ReadFull(rand.Reader, cpPriv[:]); err != nil {
		t.Fatal(err)
	}
	curve25519.ScalarBaseMult(&cpPub, &cpPriv)

	cpPubHex := hex.EncodeToString(cpPub[:])
	cpFpBytes := sha256.Sum256(cpPub[:])
	cpFingerprint := hex.EncodeToString(cpFpBytes[:])

	nonceBytes := make([]byte, 32)
	rand.Read(nonceBytes)
	nonceHex := hex.EncodeToString(nonceBytes)

	secretBytes := make([]byte, 24)
	rand.Read(secretBytes)
	preauthKeySecret := hex.EncodeToString(secretBytes)
	enrolmentString := "nnk1:" + preauthKeySecret + ":" + cpFingerprint

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/v4/control/challenge" {
			json.NewEncoder(w).Encode(ChallengeResponse{
				Nonce:              nonceHex,
				ControlPlanePubHex: cpPubHex,
				ExpiresAt:          "2026-09-21T18:00:00Z",
			})
			return
		}

		if r.URL.Path == "/v4/control/register" {
			var req RegisterRequest
			if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
				t.Fatalf("decode register: %v", err)
			}

			if req.PreAuthKey != preauthKeySecret {
				t.Errorf("got preauth key %s, want %s", req.PreAuthKey, preauthKeySecret)
			}
			if req.Nonce != nonceHex {
				t.Errorf("got nonce %s, want %s", req.Nonce, nonceHex)
			}

			// Verify proof on server side
			nodePubBytes, _ := hex.DecodeString(req.PublicKeyHex)
			sharedSecret, err := curve25519.X25519(cpPriv[:], nodePubBytes)
			if err != nil {
				t.Fatalf("DH on server failed: %v", err)
			}

			hkdfReader := hkdf.New(sha256.New, sharedSecret, nil, []byte("neronet/v4/register"))
			derivedKey := make([]byte, 32)
			io.ReadFull(hkdfReader, derivedKey)

			mac := hmac.New(sha256.New, derivedKey)
			mac.Write(append(nonceBytes, nodePubBytes...))
			mac.Write([]byte(req.Role))
			expectedProof := hex.EncodeToString(mac.Sum(nil))

			if req.Proof != expectedProof {
				t.Errorf("server proof mismatch: got %s, want %s", req.Proof, expectedProof)
			}

			json.NewEncoder(w).Encode(RegisterResponse{
				AssignedNodeID:      "pk_" + req.PublicKeyHex[:16],
				OverlayIPv4:         "100.64.0.5",
				OverlayIPv6:         "fd7a:115c:a1e0::5",
				Relays:              []*RelayDesc{},
				LeaseExpiryUTC:      1790000000,
				NetworkPSKHex:       "",
				PolicyEpoch:         1,
				RouteEpoch:          1,
				Credential:          "nnt1_mintedtoken12345",
				CredentialExpiresAt: "2026-09-22T18:00:00Z",
			})
			return
		}

		http.NotFound(w, r)
	}))
	defer server.Close()

	// Client node keypair
	var nodePriv, nodePub [crypto.KeySize]byte
	rand.Read(nodePriv[:])
	curve25519.ScalarBaseMult(&nodePub, &nodePriv)

	client := NewClient(server.URL)
	resp, err := client.RegisterWithProof(
		context.Background(),
		nodePriv,
		nodePub,
		"CLIENT_ORIGIN",
		nil,
		CapabilityDesc{},
		enrolmentString,
	)
	if err != nil {
		t.Fatalf("RegisterWithProof failed: %v", err)
	}

	if resp.AssignedNodeID != GenerateNodeID(nodePub) {
		t.Errorf("got assigned ID %s, want %s", resp.AssignedNodeID, GenerateNodeID(nodePub))
	}
	if resp.Credential != "nnt1_mintedtoken12345" {
		t.Errorf("got credential %s, want nnt1_mintedtoken12345", resp.Credential)
	}
	if client.authToken != "nnt1_mintedtoken12345" {
		t.Errorf("client authToken was not updated to minted credential: got %s", client.authToken)
	}
}

func TestRegisterWithProof_FingerprintMismatch(t *testing.T) {
	cpPubHex := "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210"
	wrongFingerprint := "0000000000000000000000000000000000000000000000000000000000000000"
	enrolmentString := "nnk1:secretkey123:" + wrongFingerprint

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(ChallengeResponse{
			Nonce:              "1122334455667788112233445566778811223344556677881122334455667788",
			ControlPlanePubHex: cpPubHex,
			ExpiresAt:          "2026-09-21T18:00:00Z",
		})
	}))
	defer server.Close()

	var nodePriv, nodePub [crypto.KeySize]byte
	rand.Read(nodePriv[:])
	curve25519.ScalarBaseMult(&nodePub, &nodePriv)

	client := NewClient(server.URL)
	_, err := client.RegisterWithProof(
		context.Background(),
		nodePriv,
		nodePub,
		"CLIENT_ORIGIN",
		nil,
		CapabilityDesc{},
		enrolmentString,
	)

	if err == nil {
		t.Fatal("expected error on fingerprint mismatch, got nil")
	}
	if !strings.Contains(err.Error(), "control plane fingerprint mismatch") {
		t.Errorf("unexpected error message: %v", err)
	}
	// The error is logged. Nothing taken from the enrolment string belongs in it.
	if strings.Contains(err.Error(), wrongFingerprint) || strings.Contains(err.Error(), "secretkey123") {
		t.Errorf("error repeats the enrolment string: %v", err)
	}
}

func TestHeartbeatRotatesCredential(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth := r.Header.Get("Authorization")
		if auth != "Bearer nnt1_old_token" {
			t.Errorf("got header %s, want Bearer nnt1_old_token", auth)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(HeartbeatResponse{
			Acknowledged:        true,
			NewCredential:       "nnt1_rotated_token_new",
			CredentialExpiresAt: "2026-09-23T18:00:00Z",
		})
	}))
	defer server.Close()

	client := NewClient(server.URL)
	client.SetAuthToken("nnt1_old_token")

	resp, err := client.SendHeartbeat(context.Background(), "node-1", nil, 0, 0, 0, 100, false)
	if err != nil {
		t.Fatalf("SendHeartbeat failed: %v", err)
	}

	if resp.NewCredential != "nnt1_rotated_token_new" {
		t.Errorf("got new cred %s, want nnt1_rotated_token_new", resp.NewCredential)
	}
	if client.authToken != "nnt1_rotated_token_new" {
		t.Errorf("client authToken was not rotated: got %s", client.authToken)
	}
}

// The control plane computes the proof in Node (ControlPlaneKeyService.verifyProof);
// these values come from its computeClientProof for the same keys, nonce and role.
// A difference in byte order, key derivation or role encoding between the two
// implementations fails here rather than as every node in the fleet being refused.
func TestRegisterWithProofMatchesControlPlaneVector(t *testing.T) {
	const (
		cpPubHex   = "0faa684ed28867b97f4a6a2dee5df8ce974e76b7018e3f22a1c4cf2678570f20"
		nodePubHex = "7b4e909bbe7ffe44c465a220037d608ee35897d31ef972f07f74892cb0f73f13"
		nonceHex   = "3333333333333333333333333333333333333333333333333333333333333333"
	)
	want := map[string]string{
		"CLIENT_ORIGIN": "0153baf887b10fd732e798dc3bae799a994b679afa5c1a6c72dbb0a7781d391a",
		"EXIT_BRIDGE":   "18fef69fed9fa1a0b2c777eaf57350000571528c6622a8a7579d1217738f4121",
	}

	var nodePriv, nodePub [crypto.KeySize]byte
	for i := range nodePriv {
		nodePriv[i] = 0x11
	}
	curve25519.ScalarBaseMult(&nodePub, &nodePriv)
	if got := hex.EncodeToString(nodePub[:]); got != nodePubHex {
		t.Fatalf("node public key %s, want %s", got, nodePubHex)
	}

	for role, proof := range want {
		var sent RegisterRequest
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			if r.URL.Path == "/v4/control/challenge" {
				_ = json.NewEncoder(w).Encode(ChallengeResponse{Nonce: nonceHex, ControlPlanePubHex: cpPubHex})
				return
			}
			_ = json.NewDecoder(r.Body).Decode(&sent)
			_ = json.NewEncoder(w).Encode(RegisterResponse{AssignedNodeID: "pk_x", OverlayIPv4: "100.64.0.9"})
		}))

		_, err := NewClient(server.URL).RegisterWithProof(context.Background(), nodePriv, nodePub, role, nil, CapabilityDesc{}, "")
		server.Close()
		if err != nil {
			t.Fatalf("%s: %v", role, err)
		}
		if sent.Proof != proof {
			t.Errorf("%s: proof %s, control plane expects %s", role, sent.Proof, proof)
		}
	}
}

// After registration the node authenticates as itself. The fleet token stays for
// the next enrolment and is never sent where a node credential is expected.
func TestCredentialReplacesEnrolmentTokenAfterRegistration(t *testing.T) {
	var cpPriv, cpPub [crypto.KeySize]byte
	cpPriv[0] = 9
	curve25519.ScalarBaseMult(&cpPub, &cpPriv)

	seen := map[string]string{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen[r.URL.Path] = r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v4/control/challenge":
			_ = json.NewEncoder(w).Encode(ChallengeResponse{Nonce: strings.Repeat("ab", 32), ControlPlanePubHex: hex.EncodeToString(cpPub[:])})
		case "/v4/control/register":
			_ = json.NewEncoder(w).Encode(RegisterResponse{AssignedNodeID: "pk_x", OverlayIPv4: "100.64.0.9", Credential: "nnt1_node"})
		case "/v4/control/heartbeat":
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"error":"node credential has expired"}`))
		}
	}))
	defer server.Close()

	var priv, pub [crypto.KeySize]byte
	priv[0] = 7
	curve25519.ScalarBaseMult(&pub, &priv)

	client := NewClient(server.URL)
	client.SetAuthToken("fleet-token")
	if _, err := client.RegisterWithProof(context.Background(), priv, pub, "CLIENT_ORIGIN", nil, CapabilityDesc{}, ""); err != nil {
		t.Fatal(err)
	}
	if seen["/v4/control/register"] != "Bearer fleet-token" {
		t.Errorf("register sent %q", seen["/v4/control/register"])
	}

	_, err := client.SendHeartbeat(context.Background(), "pk_x", nil, 0, 0, 0, 0, false)
	if seen["/v4/control/heartbeat"] != "Bearer nnt1_node" {
		t.Errorf("heartbeat sent %q, want the node credential", seen["/v4/control/heartbeat"])
	}
	if !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("a refused credential must surface as ErrUnauthorized, got %v", err)
	}

	// The refused credential is dropped, and the next registration still carries the
	// enrolment token rather than the stale credential.
	if _, err := client.RegisterWithProof(context.Background(), priv, pub, "CLIENT_ORIGIN", nil, CapabilityDesc{}, ""); err != nil {
		t.Fatal(err)
	}
	if seen["/v4/control/register"] != "Bearer fleet-token" {
		t.Errorf("re-registration sent %q", seen["/v4/control/register"])
	}
}
