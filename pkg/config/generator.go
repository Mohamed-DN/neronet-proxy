package config

import (
	"encoding/json"
	"fmt"
	"strings"
)

// TFVarsOCI represents Terraform input variables for the OCI module.
type TFVarsOCI struct {
	ClusterName   string                   `json:"cluster_name"`
	CompartmentID string                   `json:"compartment_id"`
	VpcCIDR       string                   `json:"vpc_cidr"`
	SubnetCIDR    string                   `json:"subnet_cidr"`
	SSHPort       int                      `json:"ssh_port"`
	Nodes         []map[string]interface{} `json:"nodes"`
}

// TFVarsAWS represents Terraform input variables for the AWS module.
type TFVarsAWS struct {
	ClusterName string                   `json:"cluster_name"`
	Region      string                   `json:"region"`
	VpcCIDR     string                   `json:"vpc_cidr"`
	SubnetCIDR  string                   `json:"subnet_cidr"`
	SSHPort     int                      `json:"ssh_port"`
	Nodes       []map[string]interface{} `json:"nodes"`
}

// TFVarsGCP represents Terraform input variables for the GCP module.
type TFVarsGCP struct {
	ClusterName string                   `json:"cluster_name"`
	ProjectID   string                   `json:"project_id"`
	Region      string                   `json:"region"`
	VpcCIDR     string                   `json:"vpc_cidr"`
	SubnetCIDR  string                   `json:"subnet_cidr"`
	SSHPort     int                      `json:"ssh_port"`
	Nodes       []map[string]interface{} `json:"nodes"`
}

// TFVarsDO represents Terraform input variables for DigitalOcean.
type TFVarsDO struct {
	ClusterName string                   `json:"cluster_name"`
	Region      string                   `json:"region"`
	VpcCIDR     string                   `json:"vpc_cidr"`
	SSHPort     int                      `json:"ssh_port"`
	Nodes       []map[string]interface{} `json:"nodes"`
}

// TFVarsHetzner represents Terraform input variables for Hetzner.
type TFVarsHetzner struct {
	ClusterName string                   `json:"cluster_name"`
	Location    string                   `json:"location"`
	NetworkCIDR string                   `json:"network_cidr"`
	SubnetCIDR  string                   `json:"subnet_cidr"`
	SSHPort     int                      `json:"ssh_port"`
	Nodes       []map[string]interface{} `json:"nodes"`
}

// TFVarsVultr represents Terraform input variables for Vultr.
type TFVarsVultr struct {
	ClusterName string                   `json:"cluster_name"`
	Region      string                   `json:"region"`
	VpcCIDR     string                   `json:"vpc_cidr"`
	SubnetCIDR  string                   `json:"subnet_cidr"`
	SSHPort     int                      `json:"ssh_port"`
	Nodes       []map[string]interface{} `json:"nodes"`
}

// ExportOCITFVars generates JSON bytes for OCI Terraform variables.
func (cfg *MeshClusterConfig) ExportOCITFVars() ([]byte, error) {
	var nodes []map[string]interface{}
	for _, n := range cfg.RelayFleet.Nodes {
		if strings.ToLower(n.Provider) == "oci" {
			nodes = append(nodes, map[string]interface{}{
				"id":                  n.ID,
				"availability_domain": n.Zone,
				"shape":               n.Shape,
				"ocpus":               n.VCPU,
				"memory_in_gbs":       n.RAMGb,
				"decoy_domain":        n.AntiCensorship.DecoyDomain,
				"honeypot_port":       n.AntiCensorship.HoneypotPort,
				"public_ip_mode":      n.Network.PublicIP,
			})
		}
	}

	tf := TFVarsOCI{
		ClusterName:   cfg.Metadata.ClusterName,
		CompartmentID: cfg.Providers.OCI.CompartmentID,
		VpcCIDR:       cfg.Providers.OCI.VpcCidr,
		SubnetCIDR:    cfg.Providers.OCI.SubnetCidr,
		SSHPort:       cfg.Global.Security.SSHPort,
		Nodes:         nodes,
	}

	return json.MarshalIndent(tf, "", "  ")
}

// ExportAWSTFVars generates JSON bytes for AWS Terraform variables.
func (cfg *MeshClusterConfig) ExportAWSTFVars() ([]byte, error) {
	var nodes []map[string]interface{}
	for _, n := range cfg.RelayFleet.Nodes {
		if strings.ToLower(n.Provider) == "aws" {
			nodes = append(nodes, map[string]interface{}{
				"id":                n.ID,
				"availability_zone": n.Zone,
				"instance_type":     n.Shape,
				"decoy_domain":      n.AntiCensorship.DecoyDomain,
				"honeypot_port":     n.AntiCensorship.HoneypotPort,
			})
		}
	}

	tf := TFVarsAWS{
		ClusterName: cfg.Metadata.ClusterName,
		Region:      cfg.Providers.AWS.Region,
		VpcCIDR:     cfg.Providers.AWS.VpcCidr,
		SubnetCIDR:  cfg.Providers.AWS.SubnetCidr,
		SSHPort:     cfg.Global.Security.SSHPort,
		Nodes:       nodes,
	}

	return json.MarshalIndent(tf, "", "  ")
}

// ExportGCPTFVars generates JSON bytes for GCP Terraform variables.
func (cfg *MeshClusterConfig) ExportGCPTFVars() ([]byte, error) {
	var nodes []map[string]interface{}
	for _, n := range cfg.RelayFleet.Nodes {
		if strings.ToLower(n.Provider) == "gcp" {
			nodes = append(nodes, map[string]interface{}{
				"id":            n.ID,
				"zone":          n.Zone,
				"machine_type":  n.Shape,
				"decoy_domain":  n.AntiCensorship.DecoyDomain,
				"honeypot_port": n.AntiCensorship.HoneypotPort,
			})
		}
	}

	tf := TFVarsGCP{
		ClusterName: cfg.Metadata.ClusterName,
		ProjectID:   cfg.Providers.GCP.ProjectID,
		Region:      cfg.Providers.GCP.Region,
		VpcCIDR:     cfg.Providers.GCP.VpcCidr,
		SubnetCIDR:  cfg.Providers.GCP.SubnetCidr,
		SSHPort:     cfg.Global.Security.SSHPort,
		Nodes:       nodes,
	}

	return json.MarshalIndent(tf, "", "  ")
}

// ExportDOTFVars generates JSON bytes for DigitalOcean Terraform variables.
func (cfg *MeshClusterConfig) ExportDOTFVars() ([]byte, error) {
	var nodes []map[string]interface{}
	for _, n := range cfg.RelayFleet.Nodes {
		if strings.ToLower(n.Provider) == "digitalocean" {
			nodes = append(nodes, map[string]interface{}{
				"id":            n.ID,
				"size":          n.Shape,
				"decoy_domain":  n.AntiCensorship.DecoyDomain,
				"honeypot_port": n.AntiCensorship.HoneypotPort,
			})
		}
	}

	tf := TFVarsDO{
		ClusterName: cfg.Metadata.ClusterName,
		Region:      cfg.Providers.DigitalOcean.Region,
		VpcCIDR:     cfg.Providers.DigitalOcean.VpcCidr,
		SSHPort:     cfg.Global.Security.SSHPort,
		Nodes:       nodes,
	}

	return json.MarshalIndent(tf, "", "  ")
}

// ExportHetznerTFVars generates JSON bytes for Hetzner Terraform variables.
func (cfg *MeshClusterConfig) ExportHetznerTFVars() ([]byte, error) {
	var nodes []map[string]interface{}
	for _, n := range cfg.RelayFleet.Nodes {
		if strings.ToLower(n.Provider) == "hetzner" {
			nodes = append(nodes, map[string]interface{}{
				"id":            n.ID,
				"server_type":   n.Shape,
				"decoy_domain":  n.AntiCensorship.DecoyDomain,
				"honeypot_port": n.AntiCensorship.HoneypotPort,
			})
		}
	}

	tf := TFVarsHetzner{
		ClusterName: cfg.Metadata.ClusterName,
		Location:    cfg.Providers.Hetzner.Location,
		NetworkCIDR: cfg.Providers.Hetzner.NetworkCidr,
		SubnetCIDR:  cfg.Providers.Hetzner.SubnetCidr,
		SSHPort:     cfg.Global.Security.SSHPort,
		Nodes:       nodes,
	}

	return json.MarshalIndent(tf, "", "  ")
}

// ExportVultrTFVars generates JSON bytes for Vultr Terraform variables.
func (cfg *MeshClusterConfig) ExportVultrTFVars() ([]byte, error) {
	var nodes []map[string]interface{}
	for _, n := range cfg.RelayFleet.Nodes {
		if strings.ToLower(n.Provider) == "vultr" {
			nodes = append(nodes, map[string]interface{}{
				"id":            n.ID,
				"plan":          n.Shape,
				"decoy_domain":  n.AntiCensorship.DecoyDomain,
				"honeypot_port": n.AntiCensorship.HoneypotPort,
			})
		}
	}

	tf := TFVarsVultr{
		ClusterName: cfg.Metadata.ClusterName,
		Region:      cfg.Providers.Vultr.Region,
		VpcCIDR:     cfg.Providers.Vultr.VpcCidr,
		SubnetCIDR:  cfg.Providers.Vultr.SubnetCidr,
		SSHPort:     cfg.Global.Security.SSHPort,
		Nodes:       nodes,
	}

	return json.MarshalIndent(tf, "", "  ")
}

// ExportHelmValues generates a minimal YAML representation for Helm deployment.
func (cfg *MeshClusterConfig) ExportHelmValues() string {
	var sb strings.Builder
	sb.WriteString(fmt.Sprintf("global:\n"))
	sb.WriteString(fmt.Sprintf("  domain: %s\n", cfg.Global.Domain))
	sb.WriteString(fmt.Sprintf("  clusterName: %s\n", cfg.Metadata.ClusterName))
	sb.WriteString(fmt.Sprintf("  overlayCidr: %s\n", cfg.Global.OverlayCidr))
	sb.WriteString(fmt.Sprintf("\ncontrolPlane:\n"))
	sb.WriteString(fmt.Sprintf("  replicas: %d\n", cfg.ControlPlane.Replicas))
	sb.WriteString(fmt.Sprintf("  service:\n    port: %d\n    grpcPort: %d\n", cfg.ControlPlane.ListenPort, cfg.ControlPlane.GrpcPort))
	sb.WriteString(fmt.Sprintf("\nrelay:\n"))
	sb.WriteString(fmt.Sprintf("  replicas: %d\n", len(cfg.RelayFleet.Nodes)))
	sb.WriteString(fmt.Sprintf("  service:\n    ports:\n      - name: https-derp\n        port: %d\n      - name: stun\n        port: %d\n", cfg.RelayFleet.DefaultPort, cfg.RelayFleet.StunPort))
	sb.WriteString(fmt.Sprintf("\nmonitoring:\n  prometheusEnabled: %t\n  scrapeInterval: %s\n", cfg.Global.Telemetry.PrometheusEnabled, cfg.Global.Telemetry.ScrapeInterval))
	return sb.String()
}
