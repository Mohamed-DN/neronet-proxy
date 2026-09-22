package dns

import (
	"context"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
)

func TestGateway(t *testing.T) {
	// Start mock backend service
	backendHit := false
	backendServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		backendHit = true
		if r.Header.Get("X-Forwarded-Host") != "app.corp.neronet" {
			t.Errorf("expected X-Forwarded-Host: app.corp.neronet, got: %s", r.Header.Get("X-Forwarded-Host"))
		}
		if r.Header.Get("X-Mesh-Service") != "billing-api" {
			t.Errorf("expected X-Mesh-Service: billing-api, got: %s", r.Header.Get("X-Mesh-Service"))
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("backend response ok"))
	}))
	defer backendServer.Close()

	backendURL, err := url.Parse(backendServer.URL)
	if err != nil {
		t.Fatalf("failed to parse backend URL: %v", err)
	}

	dnsSrv := NewServer(Config{ListenAddr: "127.0.0.1:0"})
	if err := dnsSrv.Start(); err != nil {
		t.Fatalf("failed to start dns: %v", err)
	}
	defer dnsSrv.Close()

	gw := NewGateway(dnsSrv)

	nodeV4 := net.ParseIP("100.64.0.15")
	nodeV6 := net.ParseIP("fd00::15")

	route := ServiceRoute{
		Name:      "billing-api",
		Hostname:  "app.corp.neronet",
		TargetURL: backendURL,
	}

	if err := gw.RegisterService(route, nodeV4, nodeV6); err != nil {
		t.Fatalf("RegisterService failed: %v", err)
	}

	// 1. Verify MagicDNS resolved the service hostname to the node overlay IPs
	ips, err := dnsSrv.Lookup(context.Background(), "app.corp.neronet")
	if err != nil {
		t.Fatalf("MagicDNS lookup for service failed: %v", err)
	}
	if len(ips) == 0 || !ips[0].Equal(nodeV4) {
		t.Fatalf("expected resolved IP %v, got %v", nodeV4, ips)
	}

	// 2. Test HTTP Gateway routing
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "http://app.corp.neronet/v1/status", nil)
	gw.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected HTTP 200, got %d", rec.Code)
	}
	if !backendHit {
		t.Errorf("expected backend service to be reached")
	}
	body, _ := io.ReadAll(rec.Body)
	if string(body) != "backend response ok" {
		t.Errorf("unexpected body: %s", string(body))
	}

	// 3. Test HTTP 404 for unconfigured virtual host
	rec404 := httptest.NewRecorder()
	req404 := httptest.NewRequest("GET", "http://unknown.corp.neronet/", nil)
	gw.ServeHTTP(rec404, req404)

	if rec404.Code != http.StatusNotFound {
		t.Errorf("expected HTTP 404, got %d", rec404.Code)
	}

	// 4. Test UnregisterService
	gw.UnregisterService("app.corp.neronet")
	recUnreg := httptest.NewRecorder()
	gw.ServeHTTP(recUnreg, req)
	if recUnreg.Code != http.StatusNotFound {
		t.Errorf("expected HTTP 404 after unregister, got %d", recUnreg.Code)
	}
}
