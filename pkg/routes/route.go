package routes

import (
	"errors"
	"fmt"
	"net"
	"sort"
	"sync"
	"time"
)

var (
	ErrRouteNotFound    = errors.New("route not found")
	ErrNoHealthyGateway = errors.New("no healthy routing gateway peer available for subnet")
	ErrInvalidCIDR      = errors.New("invalid network CIDR prefix")
	ErrDuplicateRouteID = errors.New("route ID already exists")
)

// FailoverMode defines the routing redundancy strategy
type FailoverMode string

const (
	FailoverActivePassive FailoverMode = "ACTIVE_PASSIVE"
	FailoverActiveActive  FailoverMode = "ACTIVE_ACTIVE_ECMP"
)

// RoutingPeerSpec defines a routing gateway peer advertising the subnet
type RoutingPeerSpec struct {
	NodeID       string    `json:"node_id"`
	Priority     uint16    `json:"priority"` // 1 is highest priority
	IsHealthy    bool      `json:"is_healthy"`
	LastProbeAt  time.Time `json:"last_probe_at"`
	LatencyRTTms float64   `json:"latency_rtt_ms"`
	FailCount    uint32    `json:"fail_count"`
}

// NetworkRoute defines an advertised subnet and its routing peers
type NetworkRoute struct {
	ID           string             `json:"id"`
	NetworkID    string             `json:"network_id"` // e.g. "corp-vpc"
	Description  string             `json:"description"`
	NetworkCIDR  *net.IPNet         `json:"network_cidr"` // e.g. 10.100.0.0/24
	Masquerade   bool               `json:"masquerade"`   // Enable NAT masquerade at gateway
	Failover     FailoverMode       `json:"failover_mode"`
	RoutingPeers []*RoutingPeerSpec `json:"routing_peers"`
	Groups       []string           `json:"groups"` // Target client groups receiving route
	Enabled      bool               `json:"enabled"`
	CreatedAt    time.Time          `json:"created_at"`
	UpdatedAt    time.Time          `json:"updated_at"`
}

// RouteTable maintains all advertised network routes in the control plane
type RouteTable struct {
	mu     sync.RWMutex
	routes map[string]*NetworkRoute
	epoch  uint64
}

// NewRouteTable initializes the route table
func NewRouteTable() *RouteTable {
	return &RouteTable{
		routes: make(map[string]*NetworkRoute),
		epoch:  1,
	}
}

// AddRoute registers an advertised subnet
func (rt *RouteTable) AddRoute(id, netID, cidrStr string, peers []*RoutingPeerSpec, groups []string, masq bool, mode FailoverMode) (*NetworkRoute, error) {
	_, ipnet, err := net.ParseCIDR(cidrStr)
	if err != nil {
		return nil, fmt.Errorf("%w: %s", ErrInvalidCIDR, cidrStr)
	}

	rt.mu.Lock()
	defer rt.mu.Unlock()

	if _, exists := rt.routes[id]; exists {
		return nil, fmt.Errorf("%w: %s", ErrDuplicateRouteID, id)
	}

	if mode == "" {
		mode = FailoverActivePassive
	}

	peerList := make([]*RoutingPeerSpec, len(peers))
	now := time.Now()
	for i, p := range peers {
		pCopy := *p
		if !pCopy.IsHealthy && pCopy.FailCount == 0 {
			pCopy.IsHealthy = true
		}
		pCopy.LastProbeAt = now
		peerList[i] = &pCopy
	}

	route := &NetworkRoute{
		ID:           id,
		NetworkID:    netID,
		NetworkCIDR:  ipnet,
		Masquerade:   masq,
		Failover:     mode,
		RoutingPeers: peerList,
		Groups:       groups,
		Enabled:      true,
		CreatedAt:    now,
		UpdatedAt:    now,
	}

	rt.routes[id] = route
	rt.epoch++
	return route, nil
}

// UpsertRoute creates or updates a network route
func (rt *RouteTable) UpsertRoute(r *NetworkRoute) error {
	if r.ID == "" {
		return fmt.Errorf("route ID cannot be empty")
	}
	if r.NetworkCIDR == nil {
		return fmt.Errorf("%w: nil CIDR", ErrInvalidCIDR)
	}

	rt.mu.Lock()
	defer rt.mu.Unlock()

	now := time.Now()
	if existing, ok := rt.routes[r.ID]; ok {
		r.CreatedAt = existing.CreatedAt
	} else if r.CreatedAt.IsZero() {
		r.CreatedAt = now
	}
	r.UpdatedAt = now

	rt.routes[r.ID] = r
	rt.epoch++
	return nil
}

// GetRoute retrieves a single route by ID
func (rt *RouteTable) GetRoute(id string) (*NetworkRoute, bool) {
	rt.mu.RLock()
	defer rt.mu.RUnlock()

	r, ok := rt.routes[id]
	if !ok {
		return nil, false
	}
	return r, true
}

// ListRoutes returns all network routes sorted by ID
func (rt *RouteTable) ListRoutes() []*NetworkRoute {
	rt.mu.RLock()
	defer rt.mu.RUnlock()

	list := make([]*NetworkRoute, 0, len(rt.routes))
	for _, r := range rt.routes {
		list = append(list, r)
	}
	sort.Slice(list, func(i, j int) bool {
		return list[i].ID < list[j].ID
	})
	return list
}

// DeleteRoute removes a route by ID
func (rt *RouteTable) DeleteRoute(id string) error {
	rt.mu.Lock()
	defer rt.mu.Unlock()

	if _, ok := rt.routes[id]; !ok {
		return ErrRouteNotFound
	}
	delete(rt.routes, id)
	rt.epoch++
	return nil
}

// SelectNextHop resolves the destination IP against LPM routes and selects the healthiest peer
func (rt *RouteTable) SelectNextHop(destIP net.IP, clientGroups []string) (*RoutingPeerSpec, *NetworkRoute, error) {
	rt.mu.RLock()
	defer rt.mu.RUnlock()

	groupSet := make(map[string]bool)
	for _, g := range clientGroups {
		groupSet[g] = true
	}
	groupSet["group:all"] = true

	var bestRoute *NetworkRoute
	var bestMaskSize int = -1

	// Longest Prefix Match (LPM)
	for _, route := range rt.routes {
		if !route.Enabled || route.NetworkCIDR == nil {
			continue
		}

		// Verify client group access
		authorized := false
		if len(route.Groups) == 0 {
			authorized = true
		} else {
			for _, rg := range route.Groups {
				if groupSet[rg] {
					authorized = true
					break
				}
			}
		}
		if !authorized {
			continue
		}

		if route.NetworkCIDR.Contains(destIP) {
			ones, _ := route.NetworkCIDR.Mask.Size()
			if ones > bestMaskSize {
				bestMaskSize = ones
				bestRoute = route
			}
		}
	}

	if bestRoute == nil {
		return nil, nil, ErrRouteNotFound
	}

	// Select healthy routing peer based on failover mode
	healthyPeers := make([]*RoutingPeerSpec, 0, len(bestRoute.RoutingPeers))
	for _, p := range bestRoute.RoutingPeers {
		if p.IsHealthy {
			healthyPeers = append(healthyPeers, p)
		}
	}

	if len(healthyPeers) == 0 {
		return nil, bestRoute, ErrNoHealthyGateway
	}

	if bestRoute.Failover == FailoverActivePassive {
		// Sort ascending by priority (1 is highest priority)
		sort.Slice(healthyPeers, func(i, j int) bool {
			if healthyPeers[i].Priority != healthyPeers[j].Priority {
				return healthyPeers[i].Priority < healthyPeers[j].Priority
			}
			return healthyPeers[i].LatencyRTTms < healthyPeers[j].LatencyRTTms
		})
		return healthyPeers[0], bestRoute, nil
	}

	// Active-Active (ECMP): Consistent hash flow by destination IP
	hash := 0
	ipBytes := destIP.To16()
	if ipBytes == nil {
		ipBytes = destIP
	}
	for _, b := range ipBytes {
		hash = (hash*31 + int(b))
	}
	if hash < 0 {
		hash = -hash
	}
	idx := hash % len(healthyPeers)
	return healthyPeers[idx], bestRoute, nil
}

// UpdatePeerHealth updates the health probe status of a routing peer across routes
func (rt *RouteTable) UpdatePeerHealth(routeID, nodeID string, isHealthy bool, rttMs float64) bool {
	rt.mu.Lock()
	defer rt.mu.Unlock()

	route, ok := rt.routes[routeID]
	if !ok {
		return false
	}

	stateChanged := false
	for _, p := range route.RoutingPeers {
		if p.NodeID == nodeID {
			if isHealthy {
				p.FailCount = 0
				if !p.IsHealthy {
					p.IsHealthy = true
					stateChanged = true
				}
				p.LatencyRTTms = rttMs
			} else {
				p.FailCount++
				if p.FailCount >= 3 && p.IsHealthy {
					p.IsHealthy = false
					stateChanged = true
				}
			}
			p.LastProbeAt = time.Now()
			break
		}
	}

	if stateChanged {
		route.UpdatedAt = time.Now()
		rt.epoch++
	}

	return stateChanged
}

// GetRoutesForNode returns all routes authorized for a client or advertised by a routing peer
func (rt *RouteTable) GetRoutesForNode(nodeID string, clientGroups []string) []*NetworkRoute {
	rt.mu.RLock()
	defer rt.mu.RUnlock()

	groupSet := make(map[string]bool)
	for _, g := range clientGroups {
		groupSet[g] = true
	}
	groupSet["group:all"] = true

	var matched []*NetworkRoute
	for _, r := range rt.routes {
		if !r.Enabled {
			continue
		}

		// Check if node is one of the routing peers
		isRoutingPeer := false
		for _, p := range r.RoutingPeers {
			if p.NodeID == nodeID {
				isRoutingPeer = true
				break
			}
		}

		// Check if node's groups are in target groups
		isAuthorizedClient := false
		if len(r.Groups) == 0 {
			isAuthorizedClient = true
		} else {
			for _, rg := range r.Groups {
				if groupSet[rg] {
					isAuthorizedClient = true
					break
				}
			}
		}

		if isRoutingPeer || isAuthorizedClient {
			matched = append(matched, r)
		}
	}

	return matched
}

// Epoch returns current route table epoch
func (rt *RouteTable) Epoch() uint64 {
	rt.mu.RLock()
	defer rt.mu.RUnlock()
	return rt.epoch
}
