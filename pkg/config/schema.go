package config

// MetadataConfig defines identity and environment metadata for the mesh cluster.
type MetadataConfig struct {
	ClusterName string `json:"clusterName" yaml:"clusterName"`
	Environment string `json:"environment" yaml:"environment"`
	Owner       string `json:"owner,omitempty" yaml:"owner,omitempty"`
	Version     string `json:"version" yaml:"version"`
	Description string `json:"description,omitempty" yaml:"description,omitempty"`
}

// EncryptionConfig defines cryptographic overlay parameters (Noise protocol).
type EncryptionConfig struct {
	NoiseSuite          string `json:"noiseSuite" yaml:"noiseSuite"`
	KeyRotationHours    int    `json:"keyRotationHours" yaml:"keyRotationHours"`
	HandshakeTimeoutSec int    `json:"handshakeTimeoutSec" yaml:"handshakeTimeoutSec"`
	RekeyIntervalSec    int    `json:"rekeyIntervalSec" yaml:"rekeyIntervalSec"`
}

// TelemetryConfig defines metrics and logging destinations.
type TelemetryConfig struct {
	PrometheusEnabled bool   `json:"prometheusEnabled" yaml:"prometheusEnabled"`
	ScrapeInterval    string `json:"scrapeInterval" yaml:"scrapeInterval"`
	MetricsPort       int    `json:"metricsPort" yaml:"metricsPort"`
	LokiEndpoint      string `json:"lokiEndpoint,omitempty" yaml:"lokiEndpoint,omitempty"`
}

// SecurityConfig defines security thresholds, ports, and isolation rules.
type SecurityConfig struct {
	HoneypotBanThreshold     int  `json:"honeypotBanThreshold" yaml:"honeypotBanThreshold"`
	HoneypotBanDurationHours int  `json:"honeypotBanDurationHours" yaml:"honeypotBanDurationHours"`
	SSHPort                  int  `json:"sshPort" yaml:"sshPort"`
	StrictRfc1918Filter      bool `json:"strictRfc1918Filter" yaml:"strictRfc1918Filter"`
}

// GlobalConfig contains global settings applicable across all nodes and tiers.
type GlobalConfig struct {
	Domain      string           `json:"domain" yaml:"domain"`
	AcmeEmail   string           `json:"acmeEmail" yaml:"acmeEmail"`
	DnsProvider string           `json:"dnsProvider" yaml:"dnsProvider"`
	OverlayCidr string           `json:"overlayCidr" yaml:"overlayCidr"`
	Encryption  EncryptionConfig `json:"encryption" yaml:"encryption"`
	Telemetry   TelemetryConfig  `json:"telemetry" yaml:"telemetry"`
	Security    SecurityConfig   `json:"security" yaml:"security"`
}

// ControlPlaneNode defines node deployment distribution for the control plane.
type ControlPlaneNode struct {
	Provider string `json:"provider" yaml:"provider"`
	Region   string `json:"region" yaml:"region"`
	Zone     string `json:"zone,omitempty" yaml:"zone,omitempty"`
	Shape    string `json:"shape" yaml:"shape"`
	VCPU     int    `json:"vcpu" yaml:"vcpu"`
	RAMGb    int    `json:"ramGb" yaml:"ramGb"`
}

// BackupConfig defines remote encrypted state backup.
type BackupConfig struct {
	Provider string `json:"provider" yaml:"provider"`
	Bucket   string `json:"bucket" yaml:"bucket"`
	Schedule string `json:"schedule" yaml:"schedule"`
}

// StateStoreConfig defines storage consensus parameters.
type StateStoreConfig struct {
	Type               string       `json:"type" yaml:"type"`
	EmbeddedRaft       bool         `json:"embeddedRaft" yaml:"embeddedRaft"`
	DataDir            string       `json:"dataDir" yaml:"dataDir"`
	ElectionTimeoutMs  int          `json:"electionTimeoutMs" yaml:"electionTimeoutMs"`
	HeartbeatTimeoutMs int          `json:"heartbeatTimeoutMs" yaml:"heartbeatTimeoutMs"`
	Backup             BackupConfig `json:"backup,omitempty" yaml:"backup,omitempty"`
}

// ControlPlaneConfig defines high-availability control plane parameters.
type ControlPlaneConfig struct {
	Replicas     int                `json:"replicas" yaml:"replicas"`
	ListenPort   int                `json:"listenPort" yaml:"listenPort"`
	GrpcPort     int                `json:"grpcPort" yaml:"grpcPort"`
	Distribution []ControlPlaneNode `json:"distribution" yaml:"distribution"`
	StateStore   StateStoreConfig   `json:"stateStore" yaml:"stateStore"`
}

// AntiCensorshipConfig defines camouflage and honeypot settings for relay nodes.
type AntiCensorshipConfig struct {
	DecoyDomain       string `json:"decoyDomain" yaml:"decoyDomain"`
	HoneypotPort      int    `json:"honeypotPort" yaml:"honeypotPort"`
	FallbackDecoyPage string `json:"fallbackDecoyPage,omitempty" yaml:"fallbackDecoyPage,omitempty"`
}

// NodeNetworkConfig defines inbound network ports and public IP modes.
type NodeNetworkConfig struct {
	PublicIP            string `json:"publicIp" yaml:"publicIp"`
	AllowSSHPort        int    `json:"allowSshPort" yaml:"allowSshPort"`
	AllowedInboundPorts []int  `json:"allowedInboundPorts" yaml:"allowedInboundPorts"`
}

// RelayNodeConfig defines a single STUN/DERP relay node across any cloud.
type RelayNodeConfig struct {
	ID             string               `json:"id" yaml:"id"`
	Provider       string               `json:"provider" yaml:"provider"`
	Region         string               `json:"region" yaml:"region"`
	Zone           string               `json:"zone,omitempty" yaml:"zone,omitempty"`
	Shape          string               `json:"shape" yaml:"shape"`
	VCPU           int                  `json:"vcpu" yaml:"vcpu"`
	RAMGb          int                  `json:"ramGb" yaml:"ramGb"`
	EnableBBR      bool                 `json:"enableBBR" yaml:"enableBBR"`
	AntiCensorship AntiCensorshipConfig `json:"antiCensorship" yaml:"antiCensorship"`
	Network        NodeNetworkConfig    `json:"network" yaml:"network"`
}

// RelayFleetConfig defines the global relay swarm parameters.
type RelayFleetConfig struct {
	DefaultPort          int               `json:"defaultPort" yaml:"defaultPort"`
	StunPort             int               `json:"stunPort" yaml:"stunPort"`
	HoneypotPort         int               `json:"honeypotPort" yaml:"honeypotPort"`
	HeartbeatIntervalSec int               `json:"heartbeatIntervalSec" yaml:"heartbeatIntervalSec"`
	Nodes                []RelayNodeConfig `json:"nodes" yaml:"nodes"`
}

// BogonFilterConfig defines blocked egress ranges and ports.
type BogonFilterConfig struct {
	BlockedCidrs []string `json:"blockedCidrs" yaml:"blockedCidrs"`
	BlockedPorts []int    `json:"blockedPorts" yaml:"blockedPorts"`
}

// SandboxingConfig defines user-space egress sandboxing rules.
type SandboxingConfig struct {
	Engine       string   `json:"engine" yaml:"engine"`
	EnforceDoh   bool     `json:"enforceDoh" yaml:"enforceDoh"`
	DohResolvers []string `json:"dohResolvers" yaml:"dohResolvers"`
}

// EgressGatewayConfig defines client bridge egress and routing settings.
type EgressGatewayConfig struct {
	DefaultExitMode    string            `json:"defaultExitMode" yaml:"defaultExitMode"`
	SupportedCountries []string          `json:"supportedCountries" yaml:"supportedCountries"`
	BogonFilter        BogonFilterConfig `json:"bogonFilter" yaml:"bogonFilter"`
	Sandboxing         SandboxingConfig  `json:"sandboxing" yaml:"sandboxing"`
}

// OCIProviderConfig defines OCI-specific provider credentials and network CIDRs.
type OCIProviderConfig struct {
	CompartmentID  string `json:"compartmentId" yaml:"compartmentId"`
	TenancyOcid    string `json:"tenancyOcid,omitempty" yaml:"tenancyOcid,omitempty"`
	UserOcid       string `json:"userOcid,omitempty" yaml:"userOcid,omitempty"`
	Fingerprint    string `json:"fingerprint,omitempty" yaml:"fingerprint,omitempty"`
	PrivateKeyPath string `json:"privateKeyPath,omitempty" yaml:"privateKeyPath,omitempty"`
	VpcCidr        string `json:"vpcCidr" yaml:"vpcCidr"`
	SubnetCidr     string `json:"subnetCidr" yaml:"subnetCidr"`
}

// AWSProviderConfig defines AWS-specific network settings.
type AWSProviderConfig struct {
	Region     string `json:"region" yaml:"region"`
	VpcCidr    string `json:"vpcCidr" yaml:"vpcCidr"`
	SubnetCidr string `json:"subnetCidr" yaml:"subnetCidr"`
}

// GCPProviderConfig defines GCP-specific network settings.
type GCPProviderConfig struct {
	ProjectID  string `json:"projectId" yaml:"projectId"`
	Region     string `json:"region" yaml:"region"`
	VpcCidr    string `json:"vpcCidr" yaml:"vpcCidr"`
	SubnetCidr string `json:"subnetCidr" yaml:"subnetCidr"`
}

// DigitalOceanProviderConfig defines DO network settings.
type DigitalOceanProviderConfig struct {
	Region  string `json:"region" yaml:"region"`
	VpcCidr string `json:"vpcCidr" yaml:"vpcCidr"`
}

// HetznerProviderConfig defines Hetzner network settings.
type HetznerProviderConfig struct {
	Location    string `json:"location" yaml:"location"`
	NetworkCidr string `json:"networkCidr" yaml:"networkCidr"`
	SubnetCidr  string `json:"subnetCidr" yaml:"subnetCidr"`
}

// VultrProviderConfig defines Vultr network settings.
type VultrProviderConfig struct {
	Region     string `json:"region" yaml:"region"`
	VpcCidr    string `json:"vpcCidr" yaml:"vpcCidr"`
	SubnetCidr string `json:"subnetCidr" yaml:"subnetCidr"`
}

// ProvidersConfig aggregates cloud-specific configurations for all 6 supported clouds.
type ProvidersConfig struct {
	OCI          OCIProviderConfig          `json:"oci" yaml:"oci"`
	AWS          AWSProviderConfig          `json:"aws" yaml:"aws"`
	GCP          GCPProviderConfig          `json:"gcp" yaml:"gcp"`
	DigitalOcean DigitalOceanProviderConfig `json:"digitalocean" yaml:"digitalocean"`
	Hetzner      HetznerProviderConfig      `json:"hetzner" yaml:"hetzner"`
	Vultr        VultrProviderConfig        `json:"vultr" yaml:"vultr"`
}

// MeshClusterConfig is the root configuration structure for Sovereign Proxy v4.0.
type MeshClusterConfig struct {
	APIVersion     string              `json:"apiVersion" yaml:"apiVersion"`
	Kind           string              `json:"kind" yaml:"kind"`
	Metadata       MetadataConfig      `json:"metadata" yaml:"metadata"`
	Global         GlobalConfig        `json:"global" yaml:"global"`
	ControlPlane   ControlPlaneConfig  `json:"controlPlane" yaml:"controlPlane"`
	RelayFleet     RelayFleetConfig    `json:"relayFleet" yaml:"relayFleet"`
	EgressGateways EgressGatewayConfig `json:"egressGateways" yaml:"egressGateways"`
	Providers      ProvidersConfig     `json:"providers" yaml:"providers"`
}
