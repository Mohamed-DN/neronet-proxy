package main

import (
	"encoding/json"
	"os"
	"strconv"
	"strings"
	"time"
)

// Config defines the operational parameters for Sovereign Security Daemon.
type Config struct {
	ListenAddr         string        `json:"listen_addr"`
	HoneypotPort       int           `json:"honeypot_port"`
	FirewallDriver     string        `json:"firewall_driver"`    // "mock", "ipset", "nftables", "ufw-batch"
	BanDuration        time.Duration `json:"ban_duration"`       // e.g. 24h
	ThreatScoreBan     int           `json:"threat_score_ban"`   // Score required to trigger ban (default: 100)
	ScoreHalfLife      time.Duration `json:"score_half_life"`    // Decay half-life (default: 1h)
	PerIPTokenCapacity int           `json:"per_ip_token_cap"`   // Burst capacity per IP (default: 5)
	PerIPRefillRate    float64       `json:"per_ip_refill_rate"` // Refill tokens/sec per IP (default: 1.0)
	SubnetTokenCap     int           `json:"subnet_token_cap"`   // Burst capacity per /24 subnet (default: 20)
	SubnetRefillRate   float64       `json:"subnet_refill_rate"` // Refill tokens/sec per subnet (default: 5.0)
	WhitelistedCIDRs   []string      `json:"whitelisted_cidrs"`
	NtfyURL            string        `json:"ntfy_url"`
	NtfyTopic          string        `json:"ntfy_topic"`
	WorkerPoolSize     int           `json:"worker_pool_size"`
	EventQueueCapacity int           `json:"event_queue_capacity"`
	DryRun             bool          `json:"dry_run"`
}

// DefaultConfig returns safe, high-performance default configurations.
func DefaultConfig() *Config {
	return &Config{
		ListenAddr:         "0.0.0.0",
		HoneypotPort:       8080,
		FirewallDriver:     "mock",
		BanDuration:        24 * time.Hour,
		ThreatScoreBan:     100,
		ScoreHalfLife:      1 * time.Hour,
		PerIPTokenCapacity: 5,
		PerIPRefillRate:    1.0,
		SubnetTokenCap:     20,
		SubnetRefillRate:   5.0,
		WhitelistedCIDRs: []string{
			"127.0.0.0/8",        // IPv4 Loopback
			"10.0.0.0/8",         // RFC 1918 Private
			"172.16.0.0/12",      // RFC 1918 Private
			"192.168.0.0/16",     // RFC 1918 Private
			"100.64.0.0/10",      // Carrier-Grade NAT & Overlay
			"169.254.0.0/16",     // Link Local
			"224.0.0.0/4",        // Multicast
			"1.1.1.1/32",         // Cloudflare DNS
			"1.0.0.1/32",         // Cloudflare DNS
			"8.8.8.8/32",         // Google DNS
			"8.8.4.4/32",         // Google DNS
			"9.9.9.9/32",         // Quad9 DNS
			"149.112.112.112/32", // Quad9 DNS
		},
		NtfyURL:            "",
		NtfyTopic:          "",
		WorkerPoolSize:     4,
		EventQueueCapacity: 10000,
		DryRun:             false,
	}
}

// LoadConfig loads configuration from an optional JSON file with environment variable overrides.
func LoadConfig(path string) (*Config, error) {
	cfg := DefaultConfig()

	if path != "" {
		data, err := os.ReadFile(path)
		if err != nil {
			return nil, err
		}
		if err := json.Unmarshal(data, cfg); err != nil {
			return nil, err
		}
	}

	// Environment variable overrides
	if envPort := os.Getenv("SOVEREIGN_HONEYPOT_PORT"); envPort != "" {
		if p, err := strconv.Atoi(envPort); err == nil && p > 0 && p < 65536 {
			cfg.HoneypotPort = p
		}
	}
	if envDriver := os.Getenv("SOVEREIGN_FIREWALL_DRIVER"); envDriver != "" {
		cfg.FirewallDriver = strings.ToLower(strings.TrimSpace(envDriver))
	}
	if envNtfy := os.Getenv("NTFY_URL"); envNtfy != "" {
		cfg.NtfyURL = envNtfy
	}
	if envTopic := os.Getenv("NTFY_TOPIC"); envTopic != "" {
		cfg.NtfyTopic = envTopic
	}
	if envDryRun := os.Getenv("SOVEREIGN_DRY_RUN"); envDryRun == "1" || strings.ToLower(envDryRun) == "true" {
		cfg.DryRun = true
	}
	if envBanThresh := os.Getenv("SOVEREIGN_BAN_THRESHOLD"); envBanThresh != "" {
		if t, err := strconv.Atoi(envBanThresh); err == nil && t > 0 {
			cfg.ThreatScoreBan = t
		}
	}
	if envBanDur := os.Getenv("SOVEREIGN_BAN_DURATION_HOURS"); envBanDur != "" {
		if d, err := strconv.Atoi(envBanDur); err == nil && d > 0 {
			cfg.BanDuration = time.Duration(d) * time.Hour
		}
	}
	if envWhitelists := os.Getenv("SOVEREIGN_WHITELIST_CIDRS"); envWhitelists != "" {
		extra := strings.Split(envWhitelists, ",")
		for _, cidr := range extra {
			cidr = strings.TrimSpace(cidr)
			if cidr != "" {
				cfg.WhitelistedCIDRs = append(cfg.WhitelistedCIDRs, cidr)
			}
		}
	}

	return cfg, nil
}
