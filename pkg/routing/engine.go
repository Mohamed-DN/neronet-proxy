package routing

import (
	"crypto/rand"
	"encoding/binary"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"

	"github.com/sovereign/proxy/v4/pkg/crypto"
)

var (
	ErrNoCandidateFound = errors.New("no candidate bridge nodes match the requested criteria")
	ErrInsufficientHops = errors.New("insufficient candidate nodes to build diverse 3-hop onion circuit")
)

// NodeCandidate represents an active peer known to the routing engine
type NodeCandidate struct {
	NodeID      string
	PublicKey   [crypto.KeySize]byte
	CountryCode string
	ASN         uint32
	Role        string // "RELAY", "EXIT_BRIDGE", "HYBRID"
	Metrics     NodeMetrics
	Score       float64
}

// RoutingEngine coordinates mode-specific path selection and circuit builds
type RoutingEngine struct {
	mu         sync.RWMutex
	candidates map[string]*NodeCandidate
	circuitSeq uint32
}

// NewRoutingEngine creates an initialized routing engine
func NewRoutingEngine() *RoutingEngine {
	return &RoutingEngine{
		candidates: make(map[string]*NodeCandidate),
	}
}

// AddCandidate registers or updates a candidate node in the routing table
func (e *RoutingEngine) AddCandidate(c *NodeCandidate) {
	e.mu.Lock()
	defer e.mu.Unlock()

	c.Score = CalculatePathScore(c.Metrics)
	e.candidates[c.NodeID] = c
}

// RemoveCandidate deregisters a node
func (e *RoutingEngine) RemoveCandidate(nodeID string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	delete(e.candidates, nodeID)
}

// Mode 1: SelectByCountry finds the highest scoring eligible exit bridge in the target country
func (e *RoutingEngine) SelectByCountry(countryCode string) (*NodeCandidate, error) {
	e.mu.RLock()
	defer e.mu.RUnlock()

	targetCC := strings.ToUpper(countryCode)
	var matches []*NodeCandidate

	for _, c := range e.candidates {
		if strings.ToUpper(c.CountryCode) == targetCC && (c.Role == "EXIT_BRIDGE" || c.Role == "HYBRID") {
			if c.Score >= MinUsableScore {
				matches = append(matches, c)
			}
		}
	}

	if len(matches) == 0 {
		return nil, fmt.Errorf("%w for country %s", ErrNoCandidateFound, countryCode)
	}

	// Sort descending by quality score
	sort.Slice(matches, func(i, j int) bool {
		return matches[i].Score > matches[j].Score
	})

	return matches[0], nil
}

// Mode 2: SelectByHostID finds the explicit candidate by Node ID
func (e *RoutingEngine) SelectByHostID(hostID string) (*NodeCandidate, error) {
	e.mu.RLock()
	defer e.mu.RUnlock()

	c, ok := e.candidates[hostID]
	if !ok {
		return nil, fmt.Errorf("%w: node ID %s", ErrNoCandidateFound, hostID)
	}

	return c, nil
}

// Mode 3: BuildOnionCircuit selects Entry, Intermediate, and Exit hops to construct a 3-hop circuit
func (e *RoutingEngine) BuildOnionCircuit(targetCountry string) (*OnionCircuit, error) {
	e.mu.Lock()
	defer e.mu.Unlock()

	// 1. Select Exit Hop
	var exitMatches []*NodeCandidate
	targetCC := strings.ToUpper(targetCountry)

	for _, c := range e.candidates {
		if (targetCC == "" || strings.ToUpper(c.CountryCode) == targetCC) &&
			(c.Role == "EXIT_BRIDGE" || c.Role == "HYBRID") && c.Score >= MinUsableScore {
			exitMatches = append(exitMatches, c)
		}
	}

	if len(exitMatches) == 0 {
		return nil, fmt.Errorf("%w for exit hop", ErrNoCandidateFound)
	}

	sort.Slice(exitMatches, func(i, j int) bool {
		return exitMatches[i].Score > exitMatches[j].Score
	})
	exitNode := exitMatches[0]

	// 2. Select Entry Relay (must differ from Exit Node)
	var entryCandidates []*NodeCandidate
	for _, c := range e.candidates {
		if c.NodeID != exitNode.NodeID && (c.Role == "RELAY" || c.Role == "HYBRID") && c.Score >= MinUsableScore {
			entryCandidates = append(entryCandidates, c)
		}
	}

	if len(entryCandidates) == 0 {
		return nil, fmt.Errorf("%w: entry relay not found", ErrInsufficientHops)
	}
	entryNode := entryCandidates[0]

	// 3. Select Intermediate Hop (must differ from Entry and Exit)
	var interCandidates []*NodeCandidate
	for _, c := range e.candidates {
		if c.NodeID != exitNode.NodeID && c.NodeID != entryNode.NodeID && c.Score >= MinUsableScore {
			interCandidates = append(interCandidates, c)
		}
	}

	if len(interCandidates) == 0 {
		return nil, fmt.Errorf("%w: intermediate node not found", ErrInsufficientHops)
	}
	interNode := interCandidates[0]

	// Generate Circuit ID
	e.circuitSeq++
	var b [4]byte
	_, _ = rand.Read(b[:])
	circuitID := binary.BigEndian.Uint32(b[:]) | e.circuitSeq

	entryHop := &OnionHop{HopIndex: 1, NodeID: entryNode.NodeID, PublicKey: entryNode.PublicKey}
	interHop := &OnionHop{HopIndex: 2, NodeID: interNode.NodeID, PublicKey: interNode.PublicKey}
	exitHop := &OnionHop{HopIndex: 3, NodeID: exitNode.NodeID, PublicKey: exitNode.PublicKey}

	return Build3HopCircuit(circuitID, entryHop, interHop, exitHop)
}
