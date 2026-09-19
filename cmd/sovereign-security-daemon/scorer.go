package main

import (
	"math"
	"net"
	"sync"
	"time"
)

// ThreatEntry records the current threat score and last interaction time for an IP.
type ThreatEntry struct {
	Score      float64
	LastUpdate time.Time
	Offenses   int
}

// ThreatScorer implements stateful threat scoring with continuous exponential time decay.
type ThreatScorer struct {
	mu           sync.Mutex
	scores       map[string]*ThreatEntry
	banThreshold float64
	decayLambda  float64 // lambda = ln(2) / halfLifeSeconds
	banDuration  time.Duration
	stopChan     chan struct{}
}

// NewThreatScorer creates a new ThreatScorer instance.
func NewThreatScorer(banThreshold int, halfLife time.Duration, banDuration time.Duration) *ThreatScorer {
	if halfLife <= 0 {
		halfLife = 1 * time.Hour
	}
	halfLifeSeconds := halfLife.Seconds()
	lambda := math.Ln2 / halfLifeSeconds

	scorer := &ThreatScorer{
		scores:       make(map[string]*ThreatEntry),
		banThreshold: float64(banThreshold),
		decayLambda:  lambda,
		banDuration:  banDuration,
		stopChan:     make(chan struct{}),
	}

	go scorer.cleanupLoop()

	return scorer
}

// RecordThreat adds points for an IP and returns the new decayed score and whether ban threshold is exceeded.
func (ts *ThreatScorer) RecordThreat(ip net.IP, points float64) (newScore float64, shouldBan bool) {
	if ip == nil {
		return 0, false
	}

	ts.mu.Lock()
	defer ts.mu.Unlock()

	ipStr := ip.String()
	now := time.Now()

	entry, exists := ts.scores[ipStr]
	if !exists {
		entry = &ThreatEntry{
			Score:      0,
			LastUpdate: now,
			Offenses:   0,
		}
		ts.scores[ipStr] = entry
	}

	// Apply exponential decay: S(t) = S0 * e^(-lambda * dt)
	elapsedSeconds := now.Sub(entry.LastUpdate).Seconds()
	decayFactor := math.Exp(-ts.decayLambda * elapsedSeconds)
	decayedScore := entry.Score * decayFactor

	// Add new threat points
	newScore = decayedScore + points
	entry.Score = newScore
	entry.LastUpdate = now
	entry.Offenses++

	shouldBan = newScore >= ts.banThreshold
	return newScore, shouldBan
}

// GetScore returns the current decayed score for an IP without adding points.
func (ts *ThreatScorer) GetScore(ip net.IP) float64 {
	if ip == nil {
		return 0
	}

	ts.mu.Lock()
	defer ts.mu.Unlock()

	entry, exists := ts.scores[ip.String()]
	if !exists {
		return 0
	}

	elapsedSeconds := time.Since(entry.LastUpdate).Seconds()
	decayFactor := math.Exp(-ts.decayLambda * elapsedSeconds)
	return entry.Score * decayFactor
}

// ResetScore clears the threat score for an IP.
func (ts *ThreatScorer) ResetScore(ip net.IP) {
	if ip == nil {
		return
	}
	ts.mu.Lock()
	defer ts.mu.Unlock()
	delete(ts.scores, ip.String())
}

func (ts *ThreatScorer) cleanupLoop() {
	ticker := time.NewTicker(15 * time.Minute)
	defer ticker.Stop()

	for {
		select {
		case <-ts.stopChan:
			return
		case now := <-ticker.C:
			ts.mu.Lock()
			for k, entry := range ts.scores {
				elapsed := now.Sub(entry.LastUpdate).Seconds()
				decayed := entry.Score * math.Exp(-ts.decayLambda*elapsed)
				if decayed < 1.0 {
					delete(ts.scores, k)
				}
			}
			ts.mu.Unlock()
		}
	}
}

// Close stops background cleanup tasks.
func (ts *ThreatScorer) Close() {
	select {
	case <-ts.stopChan:
	default:
		close(ts.stopChan)
	}
}
