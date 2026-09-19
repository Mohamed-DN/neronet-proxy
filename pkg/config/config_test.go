package config

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

const sampleValidConfig = `
apiVersion: sovereign.mesh/v4alpha1
kind: SovereignCluster
metadata:
  clusterName: test-mesh-cluster
  environment: testing
  version: "4.0.0"

global:
  domain: mesh.test-network.org
  acmeEmail: test@test-network.org
  dnsProvider: cloudflare
  overlayCidr: "100.64.0.0/10"
  encryption:
    noiseSuite: Noise_IKpsk2_25519_ChaChaPoly_BLAKE2s
    keyRotationHours: 24
    handshakeTimeoutSec: 5
    rekeyIntervalSec: 3600
  telemetry:
    prometheusEnabled: true
    scrapeInterval: "15s"
    metricsPort: 9090
  security:
    honeypotBanThreshold: 2
    honeypotBanDurationHours: 72
    sshPort: 2222
    strictRfc1918Filter: true

controlPlane:
  replicas: 3
  listenPort: 8443
  grpcPort: 9443
  distribution:
    - provider: oci
      region: eu-frankfurt-1
      shape: VM.Standard.A1.Flex
      vcpu: 4
      ramGb: 24
    - provider: aws
      region: us-east-1
      shape: t4g.medium
      vcpu: 2
      ramGb: 4
  stateStore:
    type: raft-embedded
    embeddedRaft: true
    dataDir: /var/lib/sovereign/raft
    electionTimeoutMs: 1000
    heartbeatTimeoutMs: 250

relayFleet:
  defaultPort: 443
  stunPort: 3478
  honeypotPort: 8080
  heartbeatIntervalSec: 10
  nodes:
    - id: relay-test-oci
      provider: oci
      region: eu-frankfurt-1
      shape: VM.Standard.A1.Flex
      vcpu: 2
      ramGb: 12
      enableBBR: true
      antiCensorship:
        decoyDomain: "aws.amazon.com"
        honeypotPort: 8080
      network:
        publicIp: dynamic
        allowSshPort: 2222
        allowedInboundPorts: [80, 443, 2222, 3478, 8080]
    - id: relay-test-aws
      provider: aws
      region: us-east-1
      shape: t4g.small
      vcpu: 2
      ramGb: 2
      enableBBR: true
      antiCensorship:
        decoyDomain: "www.microsoft.com"
        honeypotPort: 8080
      network:
        publicIp: elastic
        allowSshPort: 2222
        allowedInboundPorts: [80, 443, 2222, 3478, 8080]

egressGateways:
  defaultExitMode: country
  supportedCountries:
    - US
    - DE
  bogonFilter:
    blockedCidrs:
      - "10.0.0.0/8"
      - "192.168.0.0/16"
    blockedPorts: [25, 445]
  sandboxing:
    engine: gvisor_netstack
    enforceDoh: true
    dohResolvers:
      - "https://dns.quad9.net/dns-query"

providers:
  oci:
    compartmentId: "ocid1.compartment.oc1..test"
    vpcCidr: "10.40.0.0/16"
    subnetCidr: "10.40.1.0/24"
  aws:
    region: "us-east-1"
    vpcCidr: "10.41.0.0/16"
    subnetCidr: "10.41.1.0/24"
  gcp:
    projectId: "test-project"
    region: "europe-west3"
    vpcCidr: "10.42.0.0/16"
    subnetCidr: "10.42.1.0/24"
  digitalocean:
    region: "nyc3"
    vpcCidr: "10.43.0.0/16"
  hetzner:
    location: "nbg1"
    networkCidr: "10.44.0.0/16"
    subnetCidr: "10.44.1.0/24"
  vultr:
    region: "nrt"
    vpcCidr: "10.45.0.0/16"
    subnetCidr: "10.45.1.0/24"
`

func TestParseMeshConfig_Valid(t *testing.T) {
	cfg, err := ParseMeshConfig([]byte(sampleValidConfig))
	if err != nil {
		t.Fatalf("unexpected error parsing valid config: %v", err)
	}

	if cfg.Metadata.ClusterName != "test-mesh-cluster" {
		t.Errorf("expected clusterName 'test-mesh-cluster', got '%s'", cfg.Metadata.ClusterName)
	}

	if len(cfg.RelayFleet.Nodes) != 2 {
		t.Errorf("expected 2 relay nodes, got %d", len(cfg.RelayFleet.Nodes))
	}

	if cfg.Global.Security.SSHPort != 2222 {
		t.Errorf("expected SSH port 2222, got %d", cfg.Global.Security.SSHPort)
	}
}

func TestExpandEnv(t *testing.T) {
	os.Setenv("TEST_CLUSTER_DOMAIN", "mesh.example.com")
	defer os.Unsetenv("TEST_CLUSTER_DOMAIN")

	input := "domain: ${TEST_CLUSTER_DOMAIN} and fallback: ${UNSET_VAR:-default_val}"
	expanded := ExpandEnv(input)

	if !strings.Contains(expanded, "mesh.example.com") {
		t.Errorf("expected environment variable expansion, got '%s'", expanded)
	}
	if !strings.Contains(expanded, "default_val") {
		t.Errorf("expected fallback expansion, got '%s'", expanded)
	}
}

func TestValidationErrors(t *testing.T) {
	invalidYaml := strings.Replace(sampleValidConfig, "apiVersion: sovereign.mesh/v4alpha1", "apiVersion: v1", 1)
	_, err := ParseMeshConfig([]byte(invalidYaml))
	if err == nil {
		t.Error("expected validation error for invalid apiVersion, got nil")
	}

	invalidCidr := strings.Replace(sampleValidConfig, `overlayCidr: "100.64.0.0/10"`, `overlayCidr: "999.999.0.0/99"`, 1)
	_, err = ParseMeshConfig([]byte(invalidCidr))
	if err == nil {
		t.Error("expected validation error for invalid CIDR, got nil")
	}
}

func TestExportTFVars(t *testing.T) {
	cfg, err := ParseMeshConfig([]byte(sampleValidConfig))
	if err != nil {
		t.Fatalf("failed to parse config: %v", err)
	}

	ociJSON, err := cfg.ExportOCITFVars()
	if err != nil {
		t.Fatalf("failed to export OCI tfvars: %v", err)
	}
	if !strings.Contains(string(ociJSON), "relay-test-oci") {
		t.Errorf("expected OCI tfvars to contain relay-test-oci, got: %s", string(ociJSON))
	}

	awsJSON, err := cfg.ExportAWSTFVars()
	if err != nil {
		t.Fatalf("failed to export AWS tfvars: %v", err)
	}
	if !strings.Contains(string(awsJSON), "relay-test-aws") {
		t.Errorf("expected AWS tfvars to contain relay-test-aws, got: %s", string(awsJSON))
	}
}

func TestYAMLListParsingWithColonsAndURLs(t *testing.T) {
	yamlInput := `
listWithURLs:
  - "https://dns.quad9.net/dns-query"
  - 'https://cloudflare-dns.com/dns-query'
  - https://dns.google/dns-query
  - tls://1.1.1.1:853
  - "fe80::1/64"
  - 127.0.0.1:8080
listWithSubObjects:
  - key1: value1
    key2: value2
  - key3: value3
`
	jsonBytes, err := SimpleYAMLToJSON([]byte(yamlInput))
	if err != nil {
		t.Fatalf("SimpleYAMLToJSON failed: %v", err)
	}

	var parsed struct {
		ListWithURLs       []string            `json:"listWithURLs"`
		ListWithSubObjects []map[string]string `json:"listWithSubObjects"`
	}

	if err := json.Unmarshal(jsonBytes, &parsed); err != nil {
		t.Fatalf("failed to unmarshal JSON into typed struct: %v, raw JSON: %s", err, string(jsonBytes))
	}

	if len(parsed.ListWithURLs) != 6 {
		t.Fatalf("expected 6 URLs in list, got %d", len(parsed.ListWithURLs))
	}

	expectedURLs := []string{
		"https://dns.quad9.net/dns-query",
		"https://cloudflare-dns.com/dns-query",
		"https://dns.google/dns-query",
		"tls://1.1.1.1:853",
		"fe80::1/64",
		"127.0.0.1:8080",
	}

	for i, expected := range expectedURLs {
		if parsed.ListWithURLs[i] != expected {
			t.Errorf("list item %d: expected %q, got %q", i, expected, parsed.ListWithURLs[i])
		}
	}

	if len(parsed.ListWithSubObjects) != 2 {
		t.Fatalf("expected 2 sub objects, got %d", len(parsed.ListWithSubObjects))
	}
	if parsed.ListWithSubObjects[0]["key1"] != "value1" {
		t.Errorf("expected sub object key1 'value1', got %q", parsed.ListWithSubObjects[0]["key1"])
	}
}

func TestLoadRealMeshClusterConfigFile(t *testing.T) {
	// Try relative paths from current test directory
	paths := []string{"../../configs/mesh-cluster.yaml", "configs/mesh-cluster.yaml", "../../../configs/mesh-cluster.yaml"}
	var cfg *MeshClusterConfig
	var err error

	for _, p := range paths {
		if _, statErr := os.Stat(p); statErr == nil {
			cfg, err = LoadMeshConfig(p)
			break
		}
	}

	if cfg == nil {
		t.Skip("configs/mesh-cluster.yaml not found at expected relative paths, skipping real file load test")
		return
	}

	if err != nil {
		t.Fatalf("failed to load real mesh-cluster.yaml: %v", err)
	}

	if cfg.APIVersion != "sovereign.mesh/v4alpha1" {
		t.Errorf("expected apiVersion sovereign.mesh/v4alpha1, got %s", cfg.APIVersion)
	}
	if cfg.Kind != "SovereignCluster" {
		t.Errorf("expected kind SovereignCluster, got %s", cfg.Kind)
	}
	if cfg.Metadata.ClusterName != "neronet-global-mesh-prod" && cfg.Metadata.ClusterName != "sovereign-global-mesh-prod" {
		t.Errorf("expected clusterName neronet-global-mesh-prod, got %s", cfg.Metadata.ClusterName)
	}
	if len(cfg.RelayFleet.Nodes) != 6 {
		t.Errorf("expected 6 relay nodes across 6 clouds, got %d", len(cfg.RelayFleet.Nodes))
	}
}

func TestExportAllSixCloudTFVars(t *testing.T) {
	cfg, err := ParseMeshConfig([]byte(sampleValidConfig))
	if err != nil {
		t.Fatalf("failed to parse sample config: %v", err)
	}

	// 1. OCI
	ociJSON, err := cfg.ExportOCITFVars()
	if err != nil || len(ociJSON) == 0 {
		t.Fatalf("OCI export failed: %v", err)
	}
	var ociMap map[string]interface{}
	if err := json.Unmarshal(ociJSON, &ociMap); err != nil {
		t.Fatalf("OCI JSON invalid: %v", err)
	}

	// 2. AWS
	awsJSON, err := cfg.ExportAWSTFVars()
	if err != nil || len(awsJSON) == 0 {
		t.Fatalf("AWS export failed: %v", err)
	}
	var awsMap map[string]interface{}
	if err := json.Unmarshal(awsJSON, &awsMap); err != nil {
		t.Fatalf("AWS JSON invalid: %v", err)
	}

	// 3. GCP
	gcpJSON, err := cfg.ExportGCPTFVars()
	if err != nil || len(gcpJSON) == 0 {
		t.Fatalf("GCP export failed: %v", err)
	}
	var gcpMap map[string]interface{}
	if err := json.Unmarshal(gcpJSON, &gcpMap); err != nil {
		t.Fatalf("GCP JSON invalid: %v", err)
	}

	// 4. DigitalOcean
	doJSON, err := cfg.ExportDOTFVars()
	if err != nil || len(doJSON) == 0 {
		t.Fatalf("DO export failed: %v", err)
	}
	var doMap map[string]interface{}
	if err := json.Unmarshal(doJSON, &doMap); err != nil {
		t.Fatalf("DO JSON invalid: %v", err)
	}

	// 5. Hetzner
	hetznerJSON, err := cfg.ExportHetznerTFVars()
	if err != nil || len(hetznerJSON) == 0 {
		t.Fatalf("Hetzner export failed: %v", err)
	}
	var hetznerMap map[string]interface{}
	if err := json.Unmarshal(hetznerJSON, &hetznerMap); err != nil {
		t.Fatalf("Hetzner JSON invalid: %v", err)
	}

	// 6. Vultr
	vultrJSON, err := cfg.ExportVultrTFVars()
	if err != nil || len(vultrJSON) == 0 {
		t.Fatalf("Vultr export failed: %v", err)
	}
	var vultrMap map[string]interface{}
	if err := json.Unmarshal(vultrJSON, &vultrMap); err != nil {
		t.Fatalf("Vultr JSON invalid: %v", err)
	}

	// Helm Values
	helmValues := cfg.ExportHelmValues()
	if !strings.Contains(helmValues, "clusterName: test-mesh-cluster") {
		t.Errorf("Helm values missing clusterName: %s", helmValues)
	}
	if !strings.Contains(helmValues, "overlayCidr: 100.64.0.0/10") {
		t.Errorf("Helm values missing overlayCidr: %s", helmValues)
	}
}

func TestValidationBoundaries(t *testing.T) {
	// Test nil config
	if err := ValidateMeshConfig(nil); err == nil {
		t.Error("expected error for nil config")
	}

	// Test missing cluster name
	invalidYaml := strings.Replace(sampleValidConfig, "clusterName: test-mesh-cluster", "clusterName: ''", 1)
	if _, err := ParseMeshConfig([]byte(invalidYaml)); err == nil {
		t.Error("expected error for empty clusterName")
	}

	// Test invalid domain
	invalidDomain := strings.Replace(sampleValidConfig, "domain: mesh.test-network.org", "domain: -invalid-domain", 1)
	if _, err := ParseMeshConfig([]byte(invalidDomain)); err == nil {
		t.Error("expected error for invalid domain")
	}

	// Test invalid SSH port
	invalidSSH := strings.Replace(sampleValidConfig, "sshPort: 2222", "sshPort: 999999", 1)
	if _, err := ParseMeshConfig([]byte(invalidSSH)); err == nil {
		t.Error("expected error for invalid SSH port")
	}

	// Test invalid exit mode
	invalidExit := strings.Replace(sampleValidConfig, "defaultExitMode: country", "defaultExitMode: invalid_mode", 1)
	if _, err := ParseMeshConfig([]byte(invalidExit)); err == nil {
		t.Error("expected error for invalid exit mode")
	}

	// Test invalid control plane provider
	invalidCPProvider := strings.Replace(sampleValidConfig, "provider: oci", "provider: unsupported_cloud", 1)
	if _, err := ParseMeshConfig([]byte(invalidCPProvider)); err == nil {
		t.Error("expected error for unsupported cloud provider")
	}
}
