package control

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
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

	preauthKeySecret := "nnk1_0123456789abcdef0123456789abcdef"
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
