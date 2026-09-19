package nat

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"sync"
	"time"
)

const (
	DefaultDiscoveryMulticastGroup = "239.255.42.99:51830"
	DefaultDiscoveryBroadcastPort  = 51830
	BeaconMagic                    = "SVRN-BEACON-v4"
)

// PeerBeacon represents the payload broadcasted across local LAN
type PeerBeacon struct {
	Magic       string    `json:"magic"`
	NodeID      string    `json:"node_id"`
	PublicKey   string    `json:"public_key"`
	OverlayIP   string    `json:"overlay_ip"`
	Endpoints   []string  `json:"endpoints"`
	NetworkName string    `json:"network_name"`
	Timestamp   time.Time `json:"timestamp"`
	Nonce       [8]byte   `json:"nonce"`
}

// DiscoveredPeer tracks a neighbor node discovered on the local broadcast domain
type DiscoveredPeer struct {
	NodeID      string
	PublicKey   string
	OverlayIP   string
	LocalAddr   *net.UDPAddr
	Endpoints   []string
	NetworkName string
	LastSeen    time.Time
	IsLocalLAN  bool
}

// LANDiscoveryManager manages periodic beacon broadcast and listener on local networks
type LANDiscoveryManager struct {
	mu            sync.RWMutex
	nodeID        string
	publicKey     string
	overlayIP     string
	endpoints     []string
	networkName   string
	multicastAddr *net.UDPAddr
	broadcastAddr *net.UDPAddr
	discovered    map[string]*DiscoveredPeer
	closed        bool
	onPeerFound   func(peer DiscoveredPeer)
}

// NewLANDiscoveryManager creates a local LAN peer discovery coordinator
func NewLANDiscoveryManager(
	nodeID, publicKey, overlayIP string,
	endpoints []string,
	networkName string,
) (*LANDiscoveryManager, error) {
	mAddr, err := net.ResolveUDPAddr("udp4", DefaultDiscoveryMulticastGroup)
	if err != nil {
		return nil, err
	}

	bAddr, err := net.ResolveUDPAddr("udp4", fmt.Sprintf("255.255.255.255:%d", DefaultDiscoveryBroadcastPort))
	if err != nil {
		return nil, err
	}

	return &LANDiscoveryManager{
		nodeID:        nodeID,
		publicKey:     publicKey,
		overlayIP:     overlayIP,
		endpoints:     endpoints,
		networkName:   networkName,
		multicastAddr: mAddr,
		broadcastAddr: bAddr,
		discovered:    make(map[string]*DiscoveredPeer),
	}, nil
}

// SetOnPeerFound registers a callback invoked whenever a new LAN peer is discovered
func (d *LANDiscoveryManager) SetOnPeerFound(callback func(peer DiscoveredPeer)) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.onPeerFound = callback
}

// CreateBeacon constructs a fresh PeerBeacon instance
func (d *LANDiscoveryManager) CreateBeacon() (*PeerBeacon, error) {
	var nonce [8]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		return nil, err
	}

	d.mu.RLock()
	defer d.mu.RUnlock()

	return &PeerBeacon{
		Magic:       BeaconMagic,
		NodeID:      d.nodeID,
		PublicKey:   d.publicKey,
		OverlayIP:   d.overlayIP,
		Endpoints:   d.endpoints,
		NetworkName: d.networkName,
		Timestamp:   time.Now().UTC(),
		Nonce:       nonce,
	}, nil
}

// BroadcastBeacon sends a beacon over UDP socket
func (d *LANDiscoveryManager) BroadcastBeacon(conn *net.UDPConn) error {
	beacon, err := d.CreateBeacon()
	if err != nil {
		return err
	}

	data, err := json.Marshal(beacon)
	if err != nil {
		return err
	}

	if conn == nil {
		c, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4zero, Port: 0})
		if err != nil {
			return err
		}
		defer c.Close()
		conn = c
	}

	// Send to multicast group
	_, _ = conn.WriteToUDP(data, d.multicastAddr)
	// Send to broadcast
	_, _ = conn.WriteToUDP(data, d.broadcastAddr)
	return nil
}

// ProcessInboundBeacon parses an incoming beacon and records the peer if valid
func (d *LANDiscoveryManager) ProcessInboundBeacon(data []byte, srcAddr *net.UDPAddr) (*DiscoveredPeer, error) {
	var beacon PeerBeacon
	if err := json.Unmarshal(data, &beacon); err != nil {
		return nil, err
	}

	if beacon.Magic != BeaconMagic {
		return nil, errors.New("invalid beacon magic identifier")
	}

	// Ignore beacons from self
	d.mu.RLock()
	selfNodeID := d.nodeID
	d.mu.RUnlock()

	if beacon.NodeID == selfNodeID {
		return nil, nil
	}

	peer := &DiscoveredPeer{
		NodeID:      beacon.NodeID,
		PublicKey:   beacon.PublicKey,
		OverlayIP:   beacon.OverlayIP,
		LocalAddr:   srcAddr,
		Endpoints:   beacon.Endpoints,
		NetworkName: beacon.NetworkName,
		LastSeen:    time.Now(),
		IsLocalLAN:  true,
	}

	d.mu.Lock()
	var cb func(peer DiscoveredPeer)
	_, exists := d.discovered[beacon.NodeID]
	d.discovered[beacon.NodeID] = peer
	if !exists && d.onPeerFound != nil {
		cb = d.onPeerFound
	}
	d.mu.Unlock()

	if cb != nil {
		cb(*peer)
	}

	return peer, nil
}

// GetDiscoveredPeers returns a snapshot of all active local peers
func (d *LANDiscoveryManager) GetDiscoveredPeers() []DiscoveredPeer {
	d.mu.RLock()
	defer d.mu.RUnlock()

	list := make([]DiscoveredPeer, 0, len(d.discovered))
	for _, p := range d.discovered {
		list = append(list, *p)
	}
	return list
}

// StartDiscoveryLoop launches background beacon transmitter and receiver
func (d *LANDiscoveryManager) StartDiscoveryLoop(ctx context.Context, interval time.Duration) error {
	conn, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4zero, Port: 0})
	if err != nil {
		return fmt.Errorf("failed to bind UDP discovery listener: %w", err)
	}

	// Ticker for periodic broadcast
	go func() {
		defer conn.Close()
		ticker := time.NewTicker(interval)
		defer ticker.Stop()

		// Initial broadcast
		_ = d.BroadcastBeacon(conn)

		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				_ = d.BroadcastBeacon(conn)
			}
		}
	}()

	return nil
}
