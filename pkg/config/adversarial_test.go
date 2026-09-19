package config

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"testing"
)

// TestAdversarial_FuzzedCIDRs tests all invalid and boundary CIDRs
func TestAdversarial_FuzzedCIDRs(t *testing.T) {
	invalidCIDRs := []string{
		"999.999.999.999/24",
		"10.0.0.1/33",
		"10.0.0.1/-1",
		"10.0.0.0/abc",
		"1.2.3.4",
		"2001:db8:::1/64",
		"::ffff:999.999.999.999/128",
		"not-a-cidr",
		"10.0.0.0/ 24",
		"10.0.0.0/24/24",
		"10.0.0.256/24",
		"",
	}

	for _, cidr := range invalidCIDRs {
		t.Run("OverlayCIDR_"+cidr, func(t *testing.T) {
			cfgYaml := strings.Replace(sampleValidConfig, `overlayCidr: "100.64.0.0/10"`, fmt.Sprintf("overlayCidr: %q", cidr), 1)
			_, err := ParseMeshConfig([]byte(cfgYaml))
			if err == nil {
				t.Errorf("expected error for invalid overlay CIDR %q, got nil", cidr)
			}
		})

		if cidr != "" {
			t.Run("BogonCIDR_"+cidr, func(t *testing.T) {
				cfgYaml := strings.Replace(sampleValidConfig, `- "10.0.0.0/8"`, fmt.Sprintf("- %q", cidr), 1)
				_, err := ParseMeshConfig([]byte(cfgYaml))
				if err == nil {
					t.Errorf("expected error for invalid bogon CIDR %q, got nil", cidr)
				}
			})

			t.Run("ProviderVpcCIDR_"+cidr, func(t *testing.T) {
				cfgYaml := strings.Replace(sampleValidConfig, `vpcCidr: "10.40.0.0/16"`, fmt.Sprintf("vpcCidr: %q", cidr), 1)
				_, err := ParseMeshConfig([]byte(cfgYaml))
				if err == nil {
					t.Errorf("expected error for invalid provider VPC CIDR %q, got nil", cidr)
				}
			})
		}
	}
}

// TestAdversarial_OutOfRangePorts probes all port fields with boundary and adversarial integers
func TestAdversarial_OutOfRangePorts(t *testing.T) {
	invalidPorts := []int{-100, -1, 0, 65536, 70000, 100000}

	for _, port := range invalidPorts {
		t.Run(fmt.Sprintf("SSHPort_%d", port), func(t *testing.T) {
			cfgYaml := strings.Replace(sampleValidConfig, "sshPort: 2222", fmt.Sprintf("sshPort: %d", port), 1)
			_, err := ParseMeshConfig([]byte(cfgYaml))
			if err == nil {
				t.Errorf("expected error for invalid SSH port %d, got nil", port)
			}
		})

		t.Run(fmt.Sprintf("ControlPlaneListenPort_%d", port), func(t *testing.T) {
			cfgYaml := strings.Replace(sampleValidConfig, "listenPort: 8443", fmt.Sprintf("listenPort: %d", port), 1)
			_, err := ParseMeshConfig([]byte(cfgYaml))
			if err == nil {
				t.Errorf("expected error for invalid listenPort %d, got nil", port)
			}
		})

		t.Run(fmt.Sprintf("ControlPlaneGrpcPort_%d", port), func(t *testing.T) {
			cfgYaml := strings.Replace(sampleValidConfig, "grpcPort: 9443", fmt.Sprintf("grpcPort: %d", port), 1)
			_, err := ParseMeshConfig([]byte(cfgYaml))
			if err == nil {
				t.Errorf("expected error for invalid grpcPort %d, got nil", port)
			}
		})

		t.Run(fmt.Sprintf("RelayDefaultPort_%d", port), func(t *testing.T) {
			cfgYaml := strings.Replace(sampleValidConfig, "defaultPort: 443", fmt.Sprintf("defaultPort: %d", port), 1)
			_, err := ParseMeshConfig([]byte(cfgYaml))
			if err == nil {
				t.Errorf("expected error for invalid relay defaultPort %d, got nil", port)
			}
		})

		t.Run(fmt.Sprintf("RelayStunPort_%d", port), func(t *testing.T) {
			cfgYaml := strings.Replace(sampleValidConfig, "stunPort: 3478", fmt.Sprintf("stunPort: %d", port), 1)
			_, err := ParseMeshConfig([]byte(cfgYaml))
			if err == nil {
				t.Errorf("expected error for invalid stunPort %d, got nil", port)
			}
		})

		t.Run(fmt.Sprintf("NodeHoneypotPort_%d", port), func(t *testing.T) {
			cfgYaml := strings.Replace(sampleValidConfig, "decoyDomain: \"aws.amazon.com\"\n        honeypotPort: 8080", fmt.Sprintf("decoyDomain: \"aws.amazon.com\"\n        honeypotPort: %d", port), 1)
			_, err := ParseMeshConfig([]byte(cfgYaml))
			if err == nil {
				t.Errorf("expected error for invalid node honeypotPort %d, got nil", port)
			}
		})
	}
}

// TestAdversarial_NodeIDFuzzing tests regex conformance and uniqueness
func TestAdversarial_NodeIDFuzzing(t *testing.T) {
	invalidNodeIDs := []string{
		"",
		"a",
		"ab",
		"abc", // Min 4 chars: [a-z0-9][a-z0-9-]{2,62}[a-z0-9]
		"Node-Uppercase",
		"node_with_underscore",
		"-leading-dash",
		"trailing-dash-",
		"node space",
		"node$special",
		"node.with.dots",
		"node;rm -rf /",
		strings.Repeat("a", 65), // Exceeds 64 chars
	}

	for _, nodeID := range invalidNodeIDs {
		t.Run("InvalidNodeID_"+nodeID, func(t *testing.T) {
			cfgYaml := strings.Replace(sampleValidConfig, "id: relay-test-oci", fmt.Sprintf("id: %q", nodeID), 1)
			_, err := ParseMeshConfig([]byte(cfgYaml))
			if err == nil {
				t.Errorf("expected error for invalid node ID %q, got nil", nodeID)
			}
		})
	}

	// Test Duplicate Node ID
	t.Run("DuplicateNodeID", func(t *testing.T) {
		cfgYaml := strings.Replace(sampleValidConfig, "id: relay-test-aws", "id: relay-test-oci", 1)
		_, err := ParseMeshConfig([]byte(cfgYaml))
		if err == nil {
			t.Error("expected error for duplicate node ID, got nil")
		}
	})
}

// TestAdversarial_EnvInjection probes env expansion for injection, special chars, and fallbacks
func TestAdversarial_EnvInjection(t *testing.T) {
	// 1. Injected YAML structure via environment variable
	os.Setenv("SOV_TEST_INJECT", "mesh.attack.org\n  injectedKey: malicious")
	defer os.Unsetenv("SOV_TEST_INJECT")

	rawYAML := `
apiVersion: sovereign.mesh/v4alpha1
kind: SovereignCluster
metadata:
  clusterName: "${SOV_TEST_INJECT}"
  environment: test
`
	// ExpandEnv should replace literally
	expanded := ExpandEnv(rawYAML)
	if !strings.Contains(expanded, "mesh.attack.org\n  injectedKey: malicious") {
		t.Errorf("expected literal expansion, got: %s", expanded)
	}

	// 2. Empty fallback syntax
	emptyFallback := ExpandEnv("${NONEXISTENT_VAR_XYZ:-fallback_value}")
	if emptyFallback != "fallback_value" {
		t.Errorf("expected fallback_value, got %q", emptyFallback)
	}

	// 3. Null fallback
	nullFallback := ExpandEnv("${NONEXISTENT_VAR_XYZ:-}")
	if nullFallback != "" {
		t.Errorf("expected empty string, got %q", nullFallback)
	}

	// 4. Nested or special characters in env var
	os.Setenv("SOV_SPECIAL_CHAR", "!@#$%^&*()_+~`|}{[]:;?><,./")
	defer os.Unsetenv("SOV_SPECIAL_CHAR")
	specialExpanded := ExpandEnv("val: ${SOV_SPECIAL_CHAR}")
	if !strings.Contains(specialExpanded, "!@#$%^&*()_+~`|}{[]:;?><,./") {
		t.Errorf("failed to handle special chars in env expansion: %s", specialExpanded)
	}
}

// TestAdversarial_EmptyAndMalformedBlocks tests handling of missing and empty sections
func TestAdversarial_EmptyAndMalformedBlocks(t *testing.T) {
	// 1. Empty YAML
	if _, err := ParseMeshConfig([]byte("")); err == nil {
		t.Error("expected error for empty YAML")
	}

	// 2. Whitespace only
	if _, err := ParseMeshConfig([]byte("   \n\t  \n")); err == nil {
		t.Error("expected error for whitespace YAML")
	}

	// 3. Missing Relay Nodes
	noNodesYaml := strings.Replace(sampleValidConfig, "nodes:\n    - id: relay-test-oci", "nodes: []\n#   - id: relay-test-oci", 1)
	// Remove remaining node lines
	lines := strings.Split(noNodesYaml, "\n")
	var filtered []string
	skip := false
	for _, l := range lines {
		if strings.Contains(l, "nodes: []") {
			filtered = append(filtered, l)
			skip = true
			continue
		}
		if skip && strings.HasPrefix(strings.TrimSpace(l), "egressGateways:") {
			skip = false
		}
		if !skip {
			filtered = append(filtered, l)
		}
	}
	noNodesClean := strings.Join(filtered, "\n")
	if _, err := ParseMeshConfig([]byte(noNodesClean)); err == nil {
		t.Error("expected error when relay nodes list is empty")
	}

	// 4. Missing Control Plane Distribution
	noCPDist := strings.Replace(sampleValidConfig, "distribution:\n    - provider: oci", "distribution: []\n#   - provider: oci", 1)
	lines = strings.Split(noCPDist, "\n")
	filtered = nil
	skip = false
	for _, l := range lines {
		if strings.Contains(l, "distribution: []") {
			filtered = append(filtered, l)
			skip = true
			continue
		}
		if skip && strings.HasPrefix(strings.TrimSpace(l), "stateStore:") {
			skip = false
		}
		if !skip {
			filtered = append(filtered, l)
		}
	}
	noCPDistClean := strings.Join(filtered, "\n")
	if _, err := ParseMeshConfig([]byte(noCPDistClean)); err == nil {
		t.Error("expected error when control plane distribution is empty")
	}
}

// TestAdversarial_NoiseCipherSuites tests valid and invalid Noise ciphers
func TestAdversarial_NoiseCipherSuites(t *testing.T) {
	validSuites := []string{
		"Noise_IKpsk2_25519_ChaChaPoly_BLAKE2s",
		"Noise_IK_25519_ChaChaPoly_BLAKE2s",
		"Noise_XX_25519_ChaChaPoly_BLAKE2s",
	}
	for _, s := range validSuites {
		cfgYaml := strings.Replace(sampleValidConfig, "Noise_IKpsk2_25519_ChaChaPoly_BLAKE2s", s, 1)
		if _, err := ParseMeshConfig([]byte(cfgYaml)); err != nil {
			t.Errorf("expected valid Noise suite %q to pass, got: %v", s, err)
		}
	}

	invalidSuites := []string{
		"TLS_AES_256_GCM_SHA384",
		"Noise_NN_25519_ChaChaPoly_BLAKE2s",
		"Noise_IK_secp256k1_AESGCM_SHA256",
		"plaintext",
		"",
	}
	for _, s := range invalidSuites {
		cfgYaml := strings.Replace(sampleValidConfig, "Noise_IKpsk2_25519_ChaChaPoly_BLAKE2s", s, 1)
		if _, err := ParseMeshConfig([]byte(cfgYaml)); err == nil {
			t.Errorf("expected invalid Noise suite %q to fail, got nil", s)
		}
	}
}

// TestAdversarial_ExitModes tests valid and invalid egress modes
func TestAdversarial_ExitModes(t *testing.T) {
	validModes := []string{"country", "specific_host", "onion_3hop"}
	for _, m := range validModes {
		cfgYaml := strings.Replace(sampleValidConfig, "defaultExitMode: country", fmt.Sprintf("defaultExitMode: %s", m), 1)
		if _, err := ParseMeshConfig([]byte(cfgYaml)); err != nil {
			t.Errorf("expected exit mode %q to pass, got: %v", m, err)
		}
	}

	invalidModes := []string{"direct", "vpn", "tor", "transparent", "random", ""}
	for _, m := range invalidModes {
		cfgYaml := strings.Replace(sampleValidConfig, "defaultExitMode: country", fmt.Sprintf("defaultExitMode: %s", m), 1)
		if _, err := ParseMeshConfig([]byte(cfgYaml)); err == nil {
			t.Errorf("expected invalid exit mode %q to fail, got nil", m)
		}
	}
}

// TestAdversarial_ProviderCaseInsensitivity tests provider casing (OCI, oci, AWS, aws, etc.)
func TestAdversarial_ProviderCaseInsensitivity(t *testing.T) {
	validVariants := []struct {
		provider string
	}{
		{"OCI"}, {"oci"}, {"Oci"},
		{"AWS"}, {"aws"}, {"Aws"},
		{"GCP"}, {"gcp"}, {"Gcp"},
		{"DigitalOcean"}, {"digitalocean"}, {"DIGITALOCEAN"},
		{"Hetzner"}, {"hetzner"}, {"HETZNER"},
		{"Vultr"}, {"vultr"}, {"VULTR"},
	}

	for _, v := range validVariants {
		cfgYaml := strings.Replace(sampleValidConfig, "provider: oci", fmt.Sprintf("provider: %s", v.provider), 1)
		if _, err := ParseMeshConfig([]byte(cfgYaml)); err != nil {
			t.Errorf("expected provider variant %q to pass, got: %v", v.provider, err)
		}
	}

	invalidProviders := []string{"azure", "alibaba", "ibm", "linode", "scaleway", "ovh", ""}
	for _, p := range invalidProviders {
		cfgYaml := strings.Replace(sampleValidConfig, "provider: oci", fmt.Sprintf("provider: %s", p), 1)
		if _, err := ParseMeshConfig([]byte(cfgYaml)); err == nil {
			t.Errorf("expected invalid provider %q to fail, got nil", p)
		}
	}
}

// TestAdversarial_MassiveMultiCloudNodeFleet stress tests TFVars generation with 600 nodes
func TestAdversarial_MassiveMultiCloudNodeFleet(t *testing.T) {
	cfg, err := ParseMeshConfig([]byte(sampleValidConfig))
	if err != nil {
		t.Fatalf("failed to parse base config: %v", err)
	}

	// Inject 100 nodes per provider (600 nodes total)
	providers := []string{"oci", "aws", "gcp", "digitalocean", "hetzner", "vultr"}
	var largeFleet []RelayNodeConfig

	for _, p := range providers {
		for i := 0; i < 100; i++ {
			node := RelayNodeConfig{
				ID:       fmt.Sprintf("relay-stress-%s-%03d", p, i),
				Provider: p,
				Region:   "us-east-1",
				Zone:     "us-east-1a",
				Shape:    "standard-2vcpu",
				VCPU:     2,
				RAMGb:    4,
				AntiCensorship: AntiCensorshipConfig{
					DecoyDomain:  "example.org",
					HoneypotPort: 8080,
				},
				Network: NodeNetworkConfig{
					PublicIP:     "dynamic",
					AllowSSHPort: 2222,
				},
			}
			largeFleet = append(largeFleet, node)
		}
	}
	cfg.RelayFleet.Nodes = largeFleet

	// Validate large fleet config
	if err := ValidateMeshConfig(cfg); err != nil {
		t.Fatalf("validation failed on 600-node fleet: %v", err)
	}

	// 1. OCI TFVars
	ociJSON, err := cfg.ExportOCITFVars()
	if err != nil {
		t.Fatalf("failed export OCI 100 nodes: %v", err)
	}
	var ociData TFVarsOCI
	if err := json.Unmarshal(ociJSON, &ociData); err != nil {
		t.Fatalf("OCI JSON unmarshal failed: %v", err)
	}
	if len(ociData.Nodes) != 100 {
		t.Errorf("expected 100 OCI nodes, got %d", len(ociData.Nodes))
	}

	// 2. AWS TFVars
	awsJSON, err := cfg.ExportAWSTFVars()
	if err != nil {
		t.Fatalf("failed export AWS 100 nodes: %v", err)
	}
	var awsData TFVarsAWS
	if err := json.Unmarshal(awsJSON, &awsData); err != nil {
		t.Fatalf("AWS JSON unmarshal failed: %v", err)
	}
	if len(awsData.Nodes) != 100 {
		t.Errorf("expected 100 AWS nodes, got %d", len(awsData.Nodes))
	}

	// 3. GCP TFVars
	gcpJSON, err := cfg.ExportGCPTFVars()
	if err != nil {
		t.Fatalf("failed export GCP 100 nodes: %v", err)
	}
	var gcpData TFVarsGCP
	if err := json.Unmarshal(gcpJSON, &gcpData); err != nil {
		t.Fatalf("GCP JSON unmarshal failed: %v", err)
	}
	if len(gcpData.Nodes) != 100 {
		t.Errorf("expected 100 GCP nodes, got %d", len(gcpData.Nodes))
	}

	// 4. DO TFVars
	doJSON, err := cfg.ExportDOTFVars()
	if err != nil {
		t.Fatalf("failed export DO 100 nodes: %v", err)
	}
	var doData TFVarsDO
	if err := json.Unmarshal(doJSON, &doData); err != nil {
		t.Fatalf("DO JSON unmarshal failed: %v", err)
	}
	if len(doData.Nodes) != 100 {
		t.Errorf("expected 100 DO nodes, got %d", len(doData.Nodes))
	}

	// 5. Hetzner TFVars
	hetznerJSON, err := cfg.ExportHetznerTFVars()
	if err != nil {
		t.Fatalf("failed export Hetzner 100 nodes: %v", err)
	}
	var hetznerData TFVarsHetzner
	if err := json.Unmarshal(hetznerJSON, &hetznerData); err != nil {
		t.Fatalf("Hetzner JSON unmarshal failed: %v", err)
	}
	if len(hetznerData.Nodes) != 100 {
		t.Errorf("expected 100 Hetzner nodes, got %d", len(hetznerData.Nodes))
	}

	// 6. Vultr TFVars
	vultrJSON, err := cfg.ExportVultrTFVars()
	if err != nil {
		t.Fatalf("failed export Vultr 100 nodes: %v", err)
	}
	var vultrData TFVarsVultr
	if err := json.Unmarshal(vultrJSON, &vultrData); err != nil {
		t.Fatalf("Vultr JSON unmarshal failed: %v", err)
	}
	if len(vultrData.Nodes) != 100 {
		t.Errorf("expected 100 Vultr nodes, got %d", len(vultrData.Nodes))
	}
}

// TestAdversarial_DomainFuzzing tests RFC 1035 / FQDN domain validation
func TestAdversarial_DomainFuzzing(t *testing.T) {
	invalidDomains := []string{
		"",
		"localhost",
		"-starts-with-dash.com",
		"ends-with-dash-.com",
		"domain..double-dot.com",
		"domain.c",          // TLD must be >= 2 chars
		"http://domain.com", // Scheme not allowed in FQDN
		"domain.com/path",   // Path not allowed
		"domain.com:8443",   // Port not allowed
		"dom@in.com",
		"*.wildcard.com",
	}

	for _, d := range invalidDomains {
		t.Run("InvalidDomain_"+d, func(t *testing.T) {
			cfgYaml := strings.Replace(sampleValidConfig, "domain: mesh.test-network.org", fmt.Sprintf("domain: %q", d), 1)
			_, err := ParseMeshConfig([]byte(cfgYaml))
			if err == nil {
				t.Errorf("expected error for invalid domain %q, got nil", d)
			}
		})
	}
}

// TestAdversarial_SimpleYAMLToJSON tests edge cases in fallback SimpleYAMLToJSON parser
func TestAdversarial_SimpleYAMLToJSON(t *testing.T) {
	// 1. Valid JSON passthrough
	jsonInput := `{"key": "value", "list": [1, 2, 3]}`
	out, err := SimpleYAMLToJSON([]byte(jsonInput))
	if err != nil || string(out) != jsonInput {
		t.Errorf("expected json passthrough, got %s, err: %v", string(out), err)
	}

	// 2. Complex YAML with nested objects, lists, numbers, booleans, nulls
	yamlInput := `
cluster:
  name: "sovereign-mesh" # inline comment
  enabled: true
  disabled: false
  nullVal: null
  tildeVal: ~
  port: 8443
  rateLimit: 12.5
  nodes:
    - id: node-1
      zone: us-east-1a
      ports: [80, 443, 8080]
    - id: node-2
      zone: us-east-1b
      ports: []
`
	out, err = SimpleYAMLToJSON([]byte(yamlInput))
	if err != nil {
		t.Fatalf("failed to convert complex YAML to JSON: %v", err)
	}

	var parsed map[string]interface{}
	if err := json.Unmarshal(out, &parsed); err != nil {
		t.Fatalf("output is not valid JSON: %v, raw: %s", err, string(out))
	}

	clusterMap, ok := parsed["cluster"].(map[string]interface{})
	if !ok {
		t.Fatalf("cluster field is not map: %v", parsed["cluster"])
	}

	if clusterMap["name"] != "sovereign-mesh" {
		t.Errorf("expected name 'sovereign-mesh', got %v", clusterMap["name"])
	}
	if clusterMap["enabled"] != true {
		t.Errorf("expected enabled true, got %v", clusterMap["enabled"])
	}
	if clusterMap["disabled"] != false {
		t.Errorf("expected disabled false, got %v", clusterMap["disabled"])
	}
	if clusterMap["nullVal"] != nil {
		t.Errorf("expected nullVal nil, got %v", clusterMap["nullVal"])
	}
	if clusterMap["tildeVal"] != nil {
		t.Errorf("expected tildeVal nil, got %v", clusterMap["tildeVal"])
	}
}
