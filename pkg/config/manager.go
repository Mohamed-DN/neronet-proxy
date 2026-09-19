package config

import (
	"flag"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

// ConfigManager provides layered configuration resolution:
// CLI Flags > Environment Variables / .env > Structured YAML Config > In-Code Defaults.
type ConfigManager struct {
	MeshConfig   *MeshClusterConfig
	DotEnvLoaded bool
	FlagSet      *flag.FlagSet
}

// NewConfigManager initializes a new ConfigManager, loading .env and structured YAML config.
func NewConfigManager(meshConfigPath string, dotEnvPaths ...string) (*ConfigManager, error) {
	// 1. Auto-load .env
	_ = LoadDotEnv(dotEnvPaths...)

	cm := &ConfigManager{
		DotEnvLoaded: true,
	}

	// 2. Load Mesh YAML if path provided
	if meshConfigPath != "" {
		cfg, err := LoadMeshConfig(meshConfigPath)
		if err != nil {
			return nil, fmt.Errorf("failed to load mesh config: %w", err)
		}
		cm.MeshConfig = cfg
	}

	return cm, nil
}

// ResolveString resolves a string parameter according to the 4-layer precedence:
// 1. Explicit CLI Flag (if supplied)
// 2. Environment Variable (.env / process env)
// 3. YAML Configuration Field
// 4. Hardened In-Code Default
func (cm *ConfigManager) ResolveString(flagVal string, isFlagSet bool, envKey string, yamlVal string, defaultVal string) string {
	if isFlagSet && flagVal != "" {
		return flagVal
	}
	if envKey != "" {
		if envVal, exists := os.LookupEnv(envKey); exists && strings.TrimSpace(envVal) != "" {
			return strings.TrimSpace(envVal)
		}
	}
	if strings.TrimSpace(yamlVal) != "" {
		return strings.TrimSpace(yamlVal)
	}
	return defaultVal
}

// ResolveInt resolves an integer parameter across the 4 layers.
func (cm *ConfigManager) ResolveInt(flagVal int, isFlagSet bool, envKey string, yamlVal int, defaultVal int) int {
	if isFlagSet && flagVal != 0 {
		return flagVal
	}
	if envKey != "" {
		if envVal, exists := os.LookupEnv(envKey); exists && strings.TrimSpace(envVal) != "" {
			if parsed, err := strconv.Atoi(strings.TrimSpace(envVal)); err == nil {
				return parsed
			}
		}
	}
	if yamlVal != 0 {
		return yamlVal
	}
	return defaultVal
}

// ResolveBool resolves a boolean parameter across the 4 layers.
func (cm *ConfigManager) ResolveBool(flagVal bool, isFlagSet bool, envKey string, yamlVal bool, defaultVal bool) bool {
	if isFlagSet {
		return flagVal
	}
	if envKey != "" {
		if envVal, exists := os.LookupEnv(envKey); exists && strings.TrimSpace(envVal) != "" {
			lower := strings.ToLower(strings.TrimSpace(envVal))
			if lower == "true" || lower == "1" || lower == "yes" || lower == "on" {
				return true
			}
			if lower == "false" || lower == "0" || lower == "no" || lower == "off" {
				return false
			}
		}
	}
	if yamlVal {
		return true
	}
	return defaultVal
}

// BindStringFlag binds a command-line flag with an environment variable fallback.
// If the flag is not set on CLI, it defaults to the environment variable value or fallback.
func BindStringFlag(f *flag.FlagSet, name, envKey, defaultVal, usage string) *string {
	effectiveDefault := GetEnv(envKey, defaultVal)
	return f.String(name, effectiveDefault, fmt.Sprintf("%s (env: %s)", usage, envKey))
}

// BindIntFlag binds an integer flag with environment variable fallback.
func BindIntFlag(f *flag.FlagSet, name, envKey string, defaultVal int, usage string) *int {
	effectiveDefault := GetEnvInt(envKey, defaultVal)
	return f.Int(name, effectiveDefault, fmt.Sprintf("%s (env: %s)", usage, envKey))
}

// BindBoolFlag binds a boolean flag with environment variable fallback.
func BindBoolFlag(f *flag.FlagSet, name, envKey string, defaultVal bool, usage string) *bool {
	effectiveDefault := GetEnvBool(envKey, defaultVal)
	return f.Bool(name, effectiveDefault, fmt.Sprintf("%s (env: %s)", usage, envKey))
}

// BindDurationFlag binds a time.Duration flag with environment variable fallback.
func BindDurationFlag(f *flag.FlagSet, name, envKey string, defaultVal time.Duration, usage string) *time.Duration {
	effectiveDefault := GetEnvDuration(envKey, defaultVal)
	return f.Duration(name, effectiveDefault, fmt.Sprintf("%s (env: %s)", usage, envKey))
}

// RedactedClusterSummary returns a sanitized summary of cluster configuration safe for printing in logs.
func RedactedClusterSummary(cfg *MeshClusterConfig) string {
	if cfg == nil {
		return "<nil config>"
	}

	var sb strings.Builder
	sb.WriteString(fmt.Sprintf("Cluster: %s (%s, %s)\n", cfg.Metadata.ClusterName, cfg.Metadata.Environment, cfg.Metadata.Version))
	sb.WriteString(fmt.Sprintf("Domain: %s | Overlay CIDR: %s\n", cfg.Global.Domain, cfg.Global.OverlayCidr))
	sb.WriteString(fmt.Sprintf("Control Plane Replicas: %d (Listen: :%d, gRPC: :%d)\n", cfg.ControlPlane.Replicas, cfg.ControlPlane.ListenPort, cfg.ControlPlane.GrpcPort))
	sb.WriteString(fmt.Sprintf("Relay Fleet Nodes: %d (DERP: :%d, STUN: :%d, Honeypot: :%d)\n", len(cfg.RelayFleet.Nodes), cfg.RelayFleet.DefaultPort, cfg.RelayFleet.StunPort, cfg.RelayFleet.HoneypotPort))
	sb.WriteString(fmt.Sprintf("Security: SSH Port %d | Ban Threshold: %d\n", cfg.Global.Security.SSHPort, cfg.Global.Security.HoneypotBanThreshold))
	return sb.String()
}
