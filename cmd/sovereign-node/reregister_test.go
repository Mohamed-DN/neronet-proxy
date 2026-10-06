package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/sovereign/proxy/v4/pkg/control"
	"github.com/sovereign/proxy/v4/pkg/crypto"
)

// A node that registers again (its credential stopped working: a lifted quarantine, an
// expired credential, a restored database) must tell the control plane where it can be
// reached. It used to send no endpoints, and the control plane wrote that empty list
// over the stored one, leaving every peer without an address to send a handshake to.
func TestReregisterSendsTheEndpointsTheNodeKnows(t *testing.T) {
	var received struct {
		Endpoints []control.EndpointDesc `json:"endpoints"`
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v4/control/challenge" {
			_, _ = w.Write([]byte(`{"nonce":"` + strings.Repeat("ab", 32) + `","cp_public_key":"` + strings.Repeat("09", 32) + `"}`))
			return
		}
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Errorf("reading the request body: %v", err)
		}
		if err := json.Unmarshal(body, &received); err != nil {
			t.Errorf("request body is not JSON: %v", err)
		}
		_, _ = w.Write([]byte(`{"assigned_node_id":"n1","overlay_ipv4":"100.64.0.2"}`))
	}))
	defer server.Close()

	keypair, err := crypto.GenerateKeypair()
	if err != nil {
		t.Fatal(err)
	}
	known := []control.EndpointDesc{{IPAddress: "198.51.100.4", Port: 51820, Protocol: "udp"}}

	if _, err := reregister(context.Background(), control.NewClient(server.URL), enrolmentFor(keypair, ""),
		"CLIENT_ORIGIN", control.CapabilityDesc{CountryCode: "IT"}, known); err != nil {
		t.Fatalf("reregister: %v", err)
	}

	if len(received.Endpoints) != 1 || received.Endpoints[0].IPAddress != "198.51.100.4" || received.Endpoints[0].Port != 51820 {
		t.Fatalf("the registration carried %+v, want the node's endpoint 198.51.100.4:51820", received.Endpoints)
	}
}
