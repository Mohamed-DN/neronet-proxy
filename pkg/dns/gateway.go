package dns

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"sync"
	"time"
)

// ServiceRoute defines a service exposed through the In-Mesh Service Gateway.
type ServiceRoute struct {
	Name        string   `json:"name"`
	Hostname    string   `json:"hostname"`     // e.g. "api.alpha.corp.neronet"
	TargetURL   *url.URL `json:"target_url"`   // e.g. "http://127.0.0.1:8080"
	AllowGroups []string `json:"allow_groups"` // optional ACL integration
}

// Gateway implements an In-Mesh virtual host HTTP/TLS reverse proxy.
type Gateway struct {
	dnsServer *Server

	mu     sync.RWMutex
	routes map[string]*ServiceRoute // lowercase hostname -> route
	proxy  map[string]*httputil.ReverseProxy

	listener net.Listener
	server   *http.Server
}

// NewGateway creates an In-Mesh Service Gateway attached to a MagicDNS server.
func NewGateway(dnsServer *Server) *Gateway {
	gw := &Gateway{
		dnsServer: dnsServer,
		routes:    make(map[string]*ServiceRoute),
		proxy:     make(map[string]*httputil.ReverseProxy),
	}
	return gw
}

// RegisterService registers a service route and advertises its hostname in MagicDNS.
func (gw *Gateway) RegisterService(route ServiceRoute, nodeIPv4, nodeIPv6 net.IP) error {
	if route.Name == "" {
		return errors.New("service name is required")
	}
	if route.Hostname == "" {
		return errors.New("service hostname is required")
	}
	if route.TargetURL == nil {
		return errors.New("target URL is required")
	}

	host := strings.ToLower(strings.Trim(route.Hostname, "."))

	targetURL := route.TargetURL
	proxy := httputil.NewSingleHostReverseProxy(targetURL)
	originalDirector := proxy.Director
	proxy.Director = func(req *http.Request) {
		originalDirector(req)
		req.Host = targetURL.Host
		req.Header.Set("X-Forwarded-Host", host)
		req.Header.Set("X-Mesh-Service", route.Name)
	}

	gw.mu.Lock()
	gw.routes[host] = &route
	gw.proxy[host] = proxy
	gw.mu.Unlock()

	// Register hostname in MagicDNS so mesh peers can resolve it
	if gw.dnsServer != nil {
		gw.dnsServer.SetRecord(host, nodeIPv4, nodeIPv6)
	}

	return nil
}

// UnregisterService removes a service route.
func (gw *Gateway) UnregisterService(hostname string) {
	host := strings.ToLower(strings.Trim(hostname, "."))

	gw.mu.Lock()
	delete(gw.routes, host)
	delete(gw.proxy, host)
	gw.mu.Unlock()
}

// ServeHTTP routes incoming requests by Host header to the target service.
func (gw *Gateway) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	reqHost := strings.ToLower(r.Host)
	if colonIdx := strings.Index(reqHost, ":"); colonIdx != -1 {
		reqHost = reqHost[:colonIdx]
	}

	gw.mu.RLock()
	proxy, ok := gw.proxy[reqHost]
	gw.mu.RUnlock()

	if !ok {
		http.Error(w, fmt.Sprintf("In-Mesh Gateway: No route configured for host '%s'", reqHost), http.StatusNotFound)
		return
	}

	proxy.ServeHTTP(w, r)
}

// StartHTTP starts listening for in-mesh HTTP connections on the specified listener.
func (gw *Gateway) StartHTTP(ln net.Listener) error {
	gw.listener = ln
	gw.server = &http.Server{
		Handler:      gw,
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 15 * time.Second,
	}

	go func() {
		_ = gw.server.Serve(ln)
	}()
	return nil
}

// Close gracefully stops the gateway server.
func (gw *Gateway) Close() error {
	if gw.server != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		return gw.server.Shutdown(ctx)
	}
	return nil
}
