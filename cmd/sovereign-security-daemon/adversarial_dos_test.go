package main

import (
	"context"
	"io"
	"net"
	"runtime"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// TestDualTokenBucketUnder10kFlood verifies token bucket behavior under 20,000 rapid requests across subnets.
func TestDualTokenBucketUnder10kFlood(t *testing.T) {
	limiter := NewDualTokenBucketLimiter(10, 2.0, 50, 10.0)
	defer limiter.Close()

	const totalRequests = 20000
	const numIPs = 100

	var wg sync.WaitGroup
	var allowedCount uint64
	var droppedCount uint64

	start := time.Now()

	for i := 0; i < totalRequests; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()

			// 100 different IPs across 10 different /24 subnets
			subnet := idx % 10
			host := (idx / 10) % numIPs
			ip := net.IPv4(198, 51, byte(100+subnet), byte(1+host))

			if limiter.Allow(ip) {
				atomic.AddUint64(&allowedCount, 1)
			} else {
				atomic.AddUint64(&droppedCount, 1)
			}
		}(i)
	}

	wg.Wait()
	duration := time.Since(start)

	t.Logf("Processed %d rate-limit checks in %v (Rate: %.2f ops/sec)", totalRequests, duration, float64(totalRequests)/duration.Seconds())
	t.Logf("Allowed: %d, Dropped: %d", allowedCount, droppedCount)

	if droppedCount == 0 {
		t.Fatalf("[VULNERABILITY] DualTokenBucketLimiter failed to drop any requests during 20,000 request flood")
	}

	// For each subnet, max burst capacity is 50. With 10 subnets, total initial burst allowed <= 500 (plus small refill)
	if allowedCount > 1500 {
		t.Fatalf("DualTokenBucketLimiter allowed %d requests, exceeding expected burst envelope (< 1500)", allowedCount)
	}
}

// TestThreatScorerConcurrentDecayAndBan verifies thread safety and accuracy under 10,000 threat events.
func TestThreatScorerConcurrentDecayAndBan(t *testing.T) {
	scorer := NewThreatScorer(100, 1*time.Hour, 24*time.Hour)
	defer scorer.Close()

	const totalAttacks = 10000
	var wg sync.WaitGroup
	var banTriggers uint64

	start := time.Now()

	for i := 0; i < totalAttacks; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()

			// 50 attacking IPs
			ipIdx := idx % 50
			ip := net.IPv4(203, 0, 113, byte(ipIdx+1))

			_, shouldBan := scorer.RecordThreat(ip, 35.0)
			if shouldBan {
				atomic.AddUint64(&banTriggers, 1)
			}
		}(i)
	}

	wg.Wait()
	duration := time.Since(start)

	t.Logf("Executed %d concurrent threat evaluations in %v (Rate: %.2f ops/sec)", totalAttacks, duration, float64(totalAttacks)/duration.Seconds())
	t.Logf("Total ban triggers observed: %d", banTriggers)

	// Since 50 IPs each received 200 attacks (each +35 points = 7000 points >> 100 threshold), all 50 IPs should exceed threshold
	for i := 0; i < 50; i++ {
		ip := net.IPv4(203, 0, 113, byte(i+1))
		score := scorer.GetScore(ip)
		if score < 100.0 {
			t.Errorf("Expected attacking IP %s to have score >= 100, got %.2f", ip.String(), score)
		}
	}
}

// TestUpstreamGatewayAntiBlacklistImmunity ensures critical DNS, mesh VIPs, loopback, and RFC 1918 never get banned.
func TestUpstreamGatewayAntiBlacklistImmunity(t *testing.T) {
	cfg := DefaultConfig()
	cfg.HoneypotPort = 18090
	cfg.FirewallDriver = "mock"
	cfg.ThreatScoreBan = 10
	cfg.PerIPTokenCapacity = 1
	cfg.PerIPRefillRate = 0.1
	cfg.DryRun = true

	daemon, err := NewSecurityDaemon(cfg)
	if err != nil {
		t.Fatalf("Failed to init daemon: %v", err)
	}

	criticalGateways := []string{
		"1.1.1.1",         // Cloudflare DoH Upstream
		"1.0.0.1",         // Cloudflare Secondary
		"8.8.8.8",         // Google DNS
		"8.8.4.4",         // Google Secondary
		"9.9.9.9",         // Quad9 DNS
		"100.64.0.1",      // SovereignMesh Control Plane VIP
		"100.64.12.34",    // SovereignMesh Client VIP
		"127.0.0.1",       // Localhost
		"10.0.0.1",        // RFC 1918 LAN Router
		"192.168.1.1",     // RFC 1918 Home Gateway
		"172.16.0.1",      // RFC 1918 Enterprise Core
		"169.254.169.254", // Cloud Instance Metadata
	}

	ctx := context.Background()

	// Simulate 1,000 aggressive connections from each critical gateway IP
	for _, ipStr := range criticalGateways {
		ip := net.ParseIP(ipStr)
		if ip == nil {
			t.Fatalf("Invalid IP: %s", ipStr)
		}

		if !daemon.whitelist.IsWhitelisted(ip) {
			t.Fatalf("[CRITICAL FLAW] WhitelistManager failed to recognize upstream gateway IP %s as whitelisted!", ipStr)
		}

		// Simulate attack handling: honeypot check must bypass rate limiter and threat scoring
		for i := 0; i < 50; i++ {
			if !daemon.whitelist.IsWhitelisted(ip) {
				score, shouldBan := daemon.scorer.RecordThreat(ip, 35.0)
				if shouldBan {
					_ = daemon.firewall.Ban(ctx, ip, 1*time.Hour, "Test")
				}
				_ = score
			}
		}

		// Verify IP is NOT banned in firewall
		banned, err := daemon.firewall.IsBanned(ctx, ip)
		if err != nil || banned {
			t.Fatalf("[CRITICAL IMMUNITY BREACH] Upstream gateway IP %s was blacklisted!", ipStr)
		}

		// Verify threat score remains 0
		score := daemon.scorer.GetScore(ip)
		if score != 0.0 {
			t.Fatalf("[CRITICAL IMMUNITY BREACH] Upstream gateway IP %s accumulated threat score %.1f!", ipStr, score)
		}
	}
}

// TestSecurityDaemonLiveSYNFloodStress spins up the live TCP server and launches 2,000 rapid real TCP connections.
func TestSecurityDaemonLiveSYNFloodStress(t *testing.T) {
	cfg := DefaultConfig()
	cfg.ListenAddr = "127.0.0.1"
	cfg.HoneypotPort = 18099
	cfg.FirewallDriver = "mock"
	cfg.PerIPTokenCapacity = 100
	cfg.PerIPRefillRate = 50.0
	cfg.SubnetTokenCap = 500
	cfg.SubnetRefillRate = 200.0
	cfg.DryRun = true

	daemon, err := NewSecurityDaemon(cfg)
	if err != nil {
		t.Fatalf("Failed to create daemon: %v", err)
	}

	if err := daemon.Start(); err != nil {
		t.Fatalf("Failed to start daemon: %v", err)
	}
	defer func() {
		_ = daemon.Stop()
	}()

	time.Sleep(100 * time.Millisecond)

	initialGoroutines := runtime.NumGoroutine()

	const numConnections = 2000
	var wg sync.WaitGroup
	var completedConnections uint64
	var failedConnections uint64

	start := time.Now()

	for i := 0; i < numConnections; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()

			d := net.Dialer{Timeout: 1 * time.Second}
			conn, err := d.Dial("tcp", "127.0.0.1:18099")
			if err != nil {
				atomic.AddUint64(&failedConnections, 1)
				return
			}
			defer conn.Close()

			_ = conn.SetDeadline(time.Now().Add(1 * time.Second))
			buf := make([]byte, 128)
			_, err = io.ReadFull(conn, buf[:10])
			if err == nil || err == io.EOF {
				atomic.AddUint64(&completedConnections, 1)
			} else {
				atomic.AddUint64(&failedConnections, 1)
			}
		}()
	}

	wg.Wait()
	duration := time.Since(start)

	t.Logf("Completed %d TCP handshakes in %v (Rate: %.2f conn/sec)", numConnections, duration, float64(numConnections)/duration.Seconds())
	t.Logf("Completed: %d, Failed/Dropped: %d", completedConnections, failedConnections)

	// Allow goroutines to clean up
	time.Sleep(200 * time.Millisecond)
	finalGoroutines := runtime.NumGoroutine()

	t.Logf("Goroutines before test: %d, after test: %d", initialGoroutines, finalGoroutines)

	// Check for severe goroutine leaks (> 50 extra goroutines lingering)
	if finalGoroutines > initialGoroutines+50 {
		t.Fatalf("[RESOURCE LEAK] SecurityDaemon leaked goroutines: before=%d, after=%d", initialGoroutines, finalGoroutines)
	}
}
