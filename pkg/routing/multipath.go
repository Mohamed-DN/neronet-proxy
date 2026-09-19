package routing

import (
	"errors"
	"math"
	"net"
	"sort"
	"sync"
	"time"
)

// PathType classifies the transport media
type PathType string

const (
	PathTypeDirectP2P PathType = "DIRECT_P2P"
	PathTypeLocalLAN  PathType = "LOCAL_LAN"
	PathTypeDERPRelay PathType = "DERP_RELAY"
	PathTypeCellular  PathType = "CELLULAR"
	PathTypeWiFi      PathType = "WIFI"
)

// NetworkPath represents an individual candidate route to a peer
type NetworkPath struct {
	ID              string       `json:"id"`
	Type            PathType     `json:"type"`
	RemoteAddr      *net.UDPAddr `json:"remote_addr"`
	LocalInterface  string       `json:"local_interface"`
	Priority        int          `json:"priority"`
	Active          bool         `json:"active"`
	RTTms           float64      `json:"rtt_ms"`
	JitterMs        float64      `json:"jitter_ms"`
	PacketLossRate  float64      `json:"loss_rate"` // 0.0 - 1.0
	Score           float64      `json:"score"`
	LastSampleAt    time.Time    `json:"last_sample_at"`
	ConsecutiveFail int          `json:"consecutive_fail"`
}

// MultiPathManager maintains multi-candidate routing tables and dynamic path selection
type MultiPathManager struct {
	mu               sync.RWMutex
	peerID           string
	paths            map[string]*NetworkPath
	activePathID     string
	hysteresisMargin float64 // score delta required to trigger route switch
	onPathSwitch     func(fromPath, toPath *NetworkPath)
}

// NewMultiPathManager creates an adaptive multipath manager for a peer
func NewMultiPathManager(peerID string) *MultiPathManager {
	return &MultiPathManager{
		peerID:           peerID,
		paths:            make(map[string]*NetworkPath),
		hysteresisMargin: 5.0, // 5 points hysteresis to avoid route flapping
	}
}

// RegisterPath registers or updates a candidate path
func (m *MultiPathManager) RegisterPath(path *NetworkPath) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if path.Score == 0 {
		path.Score = m.calculateScore(path)
	}
	if path.LastSampleAt.IsZero() {
		path.LastSampleAt = time.Now()
	}

	m.paths[path.ID] = path
	if m.activePathID == "" {
		m.activePathID = path.ID
		path.Active = true
	}
}

// RemovePath removes a path
func (m *MultiPathManager) RemovePath(pathID string) {
	m.mu.Lock()
	defer m.mu.Unlock()

	delete(m.paths, pathID)
	if m.activePathID == pathID {
		m.activePathID = ""
	}
}

// calculateScore computes adaptive score: Base (PathType) + RTT bonus - Loss penalty - Jitter penalty
func (m *MultiPathManager) calculateScore(p *NetworkPath) float64 {
	if p.ConsecutiveFail >= 3 || p.PacketLossRate >= 0.8 {
		return 0.0
	}

	// 1. Base Preference
	basePref := 50.0
	switch p.Type {
	case PathTypeLocalLAN:
		basePref = 90.0
	case PathTypeDirectP2P:
		basePref = 80.0
	case PathTypeWiFi:
		basePref = 70.0
	case PathTypeCellular:
		basePref = 60.0
	case PathTypeDERPRelay:
		basePref = 30.0
	}

	// 2. RTT Component: lower RTT -> higher score (up to +40 points)
	rttScore := 40.0 * (100.0 / (p.RTTms + 100.0))

	// 3. Loss Penalty: heavy penalty for packet loss (up to -60 points)
	lossPenalty := p.PacketLossRate * 60.0

	// 4. Jitter Penalty: standard deviation deduction
	jitterPenalty := math.Min(p.JitterMs*0.5, 20.0)

	score := basePref + rttScore - lossPenalty - jitterPenalty
	if score < 0.0 {
		score = 0.0
	}
	if score > 100.0 {
		score = 100.0
	}
	return score
}

// RecordTelemetry updates performance metrics with EWMA smoothing and re-scores path
func (m *MultiPathManager) RecordTelemetry(pathID string, sampleRTT time.Duration, isLoss bool) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	path, ok := m.paths[pathID]
	if !ok {
		return errors.New("path not found")
	}

	rttMs := float64(sampleRTT.Microseconds()) / 1000.0
	path.LastSampleAt = time.Now()

	if isLoss {
		path.ConsecutiveFail++
		// Increase loss rate EWMA
		path.PacketLossRate = (0.7 * path.PacketLossRate) + (0.3 * 1.0)
	} else {
		path.ConsecutiveFail = 0
		// Decrease loss rate EWMA
		path.PacketLossRate = (0.85 * path.PacketLossRate) + (0.15 * 0.0)

		// EWMA for RTT
		if path.RTTms == 0 {
			path.RTTms = rttMs
		} else {
			diff := math.Abs(rttMs - path.RTTms)
			path.JitterMs = (0.8 * path.JitterMs) + (0.2 * diff)
			path.RTTms = (0.8 * path.RTTms) + (0.2 * rttMs)
		}
	}

	path.Score = m.calculateScore(path)
	return nil
}

// SelectBestPath evaluates all paths and switches active path if a superior path exceeds hysteresis margin
func (m *MultiPathManager) SelectBestPath() (*NetworkPath, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if len(m.paths) == 0 {
		return nil, false
	}

	var candidates []*NetworkPath
	for _, p := range m.paths {
		candidates = append(candidates, p)
	}

	sort.Slice(candidates, func(i, j int) bool {
		return candidates[i].Score > candidates[j].Score
	})

	best := candidates[0]
	if best.Score <= 0.0 {
		return nil, false
	}

	currentActive := m.paths[m.activePathID]
	switched := false

	if currentActive == nil || best.ID != currentActive.ID {
		// Only switch if current is dead OR new best exceeds current score by hysteresisMargin
		if currentActive == nil || currentActive.Score <= 0.0 || (best.Score-currentActive.Score) > m.hysteresisMargin {
			if currentActive != nil {
				currentActive.Active = false
			}
			best.Active = true
			m.activePathID = best.ID
			switched = true

			if m.onPathSwitch != nil {
				go m.onPathSwitch(currentActive, best)
			}
		}
	}

	return m.paths[m.activePathID], switched
}

// GetActivePath returns the currently active forwarding path
func (m *MultiPathManager) GetActivePath() (*NetworkPath, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	if m.activePathID == "" {
		return nil, errors.New("no active path selected")
	}

	path, ok := m.paths[m.activePathID]
	if !ok {
		return nil, errors.New("active path not found")
	}
	return path, nil
}

// GetAllPaths returns all candidate paths
func (m *MultiPathManager) GetAllPaths() []*NetworkPath {
	m.mu.RLock()
	defer m.mu.RUnlock()

	list := make([]*NetworkPath, 0, len(m.paths))
	for _, p := range m.paths {
		list = append(list, p)
	}
	return list
}
