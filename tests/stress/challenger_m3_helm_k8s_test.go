package stress

import (
	"bytes"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/sovereign/proxy/v4/pkg/config"
	"gopkg.in/yaml.v3"
)

// Helper to find binaries
func findExecutable(names ...string) string {
	for _, name := range names {
		if path, err := exec.LookPath(name); err == nil {
			return path
		}
		if _, err := os.Stat(name); err == nil {
			return name
		}
	}
	return ""
}

var (
	helmPath    = findExecutable("/opt/homebrew/bin/helm", "helm")
	kubectlPath = findExecutable("/usr/local/bin/kubectl", "kubectl")
)

func getProjectRoot(t *testing.T) string {
	wd, err := os.Getwd()
	if err != nil {
		t.Fatalf("Failed to get working directory: %v", err)
	}
	abs, err := filepath.Abs(filepath.Join(wd, "..", ".."))
	if err != nil {
		t.Fatalf("Failed to get absolute project root: %v", err)
	}
	return abs
}

func renderHelmChart(t *testing.T, valuesYaml string, releaseName string) []map[string]interface{} {
	t.Helper()
	if helmPath == "" {
		t.Skip("helm binary not found on system; skipping helm render test")
	}

	projectRoot := getProjectRoot(t)
	chartDir := filepath.Join(projectRoot, "charts", "sovereign-mesh")

	args := []string{"template", releaseName, chartDir, "--namespace", "sovereign-mesh"}

	var tmpFile *os.File
	if valuesYaml != "" {
		var err error
		tmpFile, err = os.CreateTemp("", "helm-test-values-*.yaml")
		if err != nil {
			t.Fatalf("Failed to create temp values file: %v", err)
		}
		defer os.Remove(tmpFile.Name())

		if _, err := tmpFile.WriteString(valuesYaml); err != nil {
			t.Fatalf("Failed to write temp values: %v", err)
		}
		tmpFile.Close()
		args = append(args, "-f", tmpFile.Name())
	}

	cmd := exec.Command(helmPath, args...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	if err := cmd.Run(); err != nil {
		t.Fatalf("helm template failed: %v\nStderr: %s\nStdout: %s", err, stderr.String(), stdout.String())
	}

	decoder := yaml.NewDecoder(&stdout)
	var docs []map[string]interface{}
	for {
		var doc map[string]interface{}
		if err := decoder.Decode(&doc); err != nil {
			break
		}
		if len(doc) > 0 {
			docs = append(docs, doc)
		}
	}
	return docs
}

func renderKustomizeOverlay(t *testing.T, overlayName string) []map[string]interface{} {
	t.Helper()
	if kubectlPath == "" {
		t.Skip("kubectl binary not found on system; skipping kustomize render test")
	}

	projectRoot := getProjectRoot(t)
	overlayDir := filepath.Join(projectRoot, "k8s", "overlays", overlayName)

	cmd := exec.Command(kubectlPath, "kustomize", overlayDir)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	if err := cmd.Run(); err != nil {
		t.Fatalf("kubectl kustomize failed on %s: %v\nStderr: %s", overlayName, err, stderr.String())
	}

	decoder := yaml.NewDecoder(&stdout)
	var docs []map[string]interface{}
	for {
		var doc map[string]interface{}
		if err := decoder.Decode(&doc); err != nil {
			break
		}
		if len(doc) > 0 {
			docs = append(docs, doc)
		}
	}
	return docs
}

// ============================================================================
// 1. HELM CHART LINTING & DEFAULT TEMPLATING
// ============================================================================

func TestHelmChartLinting(t *testing.T) {
	if helmPath == "" {
		t.Skip("helm binary not found")
	}
	projectRoot := getProjectRoot(t)
	chartDir := filepath.Join(projectRoot, "charts", "sovereign-mesh")

	cmd := exec.Command(helmPath, "lint", chartDir)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("helm lint failed: %v\nOutput:\n%s", err, string(out))
	}
	if !strings.Contains(string(out), "0 chart(s) failed") {
		t.Fatalf("helm lint reported failures: %s", string(out))
	}
}

func TestHelmDefaultManifestsStructure(t *testing.T) {
	docs := renderHelmChart(t, "", "sovereign-prod")

	kinds := make(map[string]int)
	for _, doc := range docs {
		kind, _ := doc["kind"].(string)
		kinds[kind]++
	}

	requiredKinds := []string{
		"ServiceAccount", "ClusterRole", "ClusterRoleBinding",
		"Secret", "Deployment", "StatefulSet", "DaemonSet",
		"Service", "HorizontalPodAutoscaler", "PodDisruptionBudget",
		"NetworkPolicy", "ServiceMonitor",
	}

	for _, k := range requiredKinds {
		if kinds[k] == 0 {
			t.Errorf("Missing expected Kubernetes Kind: %s in default Helm render", k)
		}
	}
}

// ============================================================================
// 2. ADVERSARIAL BOUNDARY & FUZZING TESTS ON HELM TEMPLATES
// ============================================================================

func TestHelmExtremeReplicaCounts(t *testing.T) {
	tests := []struct {
		name        string
		replicas    int
		autoscaling bool
	}{
		{"ZeroReplicas", 0, false},
		{"SingleReplica", 1, false},
		{"HugeReplicas", 1000, false},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			values := fmt.Sprintf(`
controlPlane:
  autoscaling:
    enabled: %t
  replicas: %d
relay:
  replicas: %d
decoy:
  replicas: %d
`, tc.autoscaling, tc.replicas, tc.replicas, tc.replicas)

			docs := renderHelmChart(t, values, "stress-release")
			for _, doc := range docs {
				kind := doc["kind"].(string)
				meta := doc["metadata"].(map[string]interface{})
				name := meta["name"].(string)

				if kind == "Deployment" && strings.Contains(name, "control-plane") {
					spec := doc["spec"].(map[string]interface{})
					rep := int(spec["replicas"].(int))
					if rep != tc.replicas {
						t.Errorf("Control plane deployment replicas mismatch: got %d, want %d", rep, tc.replicas)
					}
				}
				if kind == "StatefulSet" && strings.Contains(name, "relay") {
					spec := doc["spec"].(map[string]interface{})
					rep := int(spec["replicas"].(int))
					if rep != tc.replicas {
						t.Errorf("Relay StatefulSet replicas mismatch: got %d, want %d", rep, tc.replicas)
					}
				}
			}
		})
	}
}

func TestHelmAutoscalingAndPDBToggle(t *testing.T) {
	valuesAutoscaling := `
controlPlane:
  autoscaling:
    enabled: true
    minReplicas: 4
    maxReplicas: 16
    targetCPUUtilizationPercentage: 70
    targetMemoryUtilizationPercentage: 75
  podDisruptionBudget:
    enabled: true
    minAvailable: 2
`
	docs := renderHelmChart(t, valuesAutoscaling, "hpa-pdb-test")
	var foundHPA, foundPDB bool
	for _, doc := range docs {
		kind := doc["kind"].(string)
		meta := doc["metadata"].(map[string]interface{})
		name := meta["name"].(string)

		if kind == "Deployment" && strings.Contains(name, "control-plane") {
			spec := doc["spec"].(map[string]interface{})
			if _, hasRep := spec["replicas"]; hasRep {
				t.Errorf("Deployment should NOT define replicas when HPA is enabled (flapping risk)")
			}
		}
		if kind == "HorizontalPodAutoscaler" {
			foundHPA = true
			spec := doc["spec"].(map[string]interface{})
			minR := int(spec["minReplicas"].(int))
			maxR := int(spec["maxReplicas"].(int))
			if minR != 4 || maxR != 16 {
				t.Errorf("HPA min/max mismatch: got %d/%d, want 4/16", minR, maxR)
			}
		}
		if kind == "PodDisruptionBudget" {
			foundPDB = true
			spec := doc["spec"].(map[string]interface{})
			minAvail := spec["minAvailable"]
			if minAvail != 2 {
				t.Errorf("PDB minAvailable mismatch: got %v, want 2", minAvail)
			}
		}
	}
	if !foundHPA {
		t.Errorf("HPA was not generated when enabled")
	}
	if !foundPDB {
		t.Errorf("PDB was not generated when enabled")
	}
}

func TestHelmComponentDisablePermutations(t *testing.T) {
	valuesAllDisabled := `
controlPlane:
  enabled: false
relay:
  enabled: false
edgeGateway:
  enabled: false
decoy:
  enabled: false
honeypot:
  enabled: false
networkPolicy:
  enabled: false
monitoring:
  serviceMonitor:
    enabled: false
serviceAccount:
  create: false
`
	docs := renderHelmChart(t, valuesAllDisabled, "disable-all")
	for _, doc := range docs {
		kind := doc["kind"].(string)
		switch kind {
		case "Deployment", "StatefulSet", "DaemonSet", "HorizontalPodAutoscaler", "PodDisruptionBudget", "NetworkPolicy", "ServiceMonitor", "ClusterRole", "ClusterRoleBinding", "ServiceAccount":
			t.Errorf("Resource kind %s should NOT be rendered when all components are disabled", kind)
		}
	}
}

func TestHelmCustomServiceAccount(t *testing.T) {
	valuesCustomSA := `
serviceAccount:
  create: false
  name: "enterprise-sovereign-sa"
`
	docs := renderHelmChart(t, valuesCustomSA, "custom-sa-test")
	for _, doc := range docs {
		kind := doc["kind"].(string)
		meta := doc["metadata"].(map[string]interface{})
		name := meta["name"].(string)

		if kind == "ServiceAccount" {
			t.Errorf("ServiceAccount should not be created when serviceAccount.create=false")
		}
		// Core mesh workloads should use the custom SA
		if (kind == "Deployment" && strings.Contains(name, "control-plane")) ||
			kind == "StatefulSet" || kind == "DaemonSet" {
			spec := doc["spec"].(map[string]interface{})
			template := spec["template"].(map[string]interface{})
			podSpec := template["spec"].(map[string]interface{})
			sa, _ := podSpec["serviceAccountName"].(string)
			if sa != "enterprise-sovereign-sa" {
				t.Errorf("Pod template for %s (%s) has wrong serviceAccountName: got %q, want 'enterprise-sovereign-sa'", kind, name, sa)
			}
		}
	}
}

func TestHelmBoundaryPortValues(t *testing.T) {
	valuesPorts := `
controlPlane:
  service:
    port: 1
    grpcPort: 65535
relay:
  service:
    ports:
      - name: derp-min
        port: 1
        targetPort: 1
        protocol: TCP
      - name: stun-max
        port: 65535
        targetPort: 65535
        protocol: UDP
`
	docs := renderHelmChart(t, valuesPorts, "ports-boundary")
	for _, doc := range docs {
		kind := doc["kind"].(string)
		meta := doc["metadata"].(map[string]interface{})
		name := meta["name"].(string)

		if kind == "Service" && strings.Contains(name, "control-plane") {
			spec := doc["spec"].(map[string]interface{})
			ports := spec["ports"].([]interface{})
			for _, p := range ports {
				pMap := p.(map[string]interface{})
				pName := pMap["name"].(string)
				pPort := pMap["port"].(int)
				if pName == "http-api" && pPort != 1 {
					t.Errorf("Control plane http-api port mismatch: got %d, want 1", pPort)
				}
				if pName == "grpc-api" && pPort != 65535 {
					t.Errorf("Control plane grpc-api port mismatch: got %d, want 65535", pPort)
				}
			}
		}
	}
}

func TestHelmConfigExportValuesCompatibility(t *testing.T) {
	cfg := &config.MeshClusterConfig{
		Metadata: config.MetadataConfig{
			ClusterName: "e2e-sovereign-mesh",
		},
		Global: config.GlobalConfig{
			Domain:      "mesh.e2e-sovereign.net",
			OverlayCidr: "100.64.0.0/10",
			Telemetry: config.TelemetryConfig{
				PrometheusEnabled: true,
				ScrapeInterval:    "20s",
			},
		},
		ControlPlane: config.ControlPlaneConfig{
			Replicas:   3,
			ListenPort: 8443,
			GrpcPort:   9443,
		},
		RelayFleet: config.RelayFleetConfig{
			DefaultPort: 443,
			StunPort:    3478,
			Nodes: []config.RelayNodeConfig{
				{ID: "node-1", Provider: "oci"},
				{ID: "node-2", Provider: "aws"},
			},
		},
	}

	exportedYAML := cfg.ExportHelmValues()
	docs := renderHelmChart(t, exportedYAML, "go-export-test")

	var foundSecret, foundCP bool
	for _, doc := range docs {
		kind := doc["kind"].(string)
		if kind == "Secret" {
			foundSecret = true
			stringData := doc["stringData"].(map[string]interface{})
			if stringData["domain"] != "mesh.e2e-sovereign.net" {
				t.Errorf("Secret domain mismatch: got %v, want mesh.e2e-sovereign.net", stringData["domain"])
			}
			if stringData["cluster-name"] != "e2e-sovereign-mesh" {
				t.Errorf("Secret cluster-name mismatch: got %v, want e2e-sovereign-mesh", stringData["cluster-name"])
			}
		}
		if kind == "Service" {
			meta := doc["metadata"].(map[string]interface{})
			if strings.Contains(meta["name"].(string), "control-plane") {
				foundCP = true
			}
		}
	}

	if !foundSecret || !foundCP {
		t.Errorf("Failed to find expected Secret (%t) or CP Service (%t) from exported values", foundSecret, foundCP)
	}
}

// ============================================================================
// 3. KUSTOMIZE MULTI-CLOUD OVERLAYS VALIDATION
// ============================================================================

func TestKustomizeAllSixOverlays(t *testing.T) {
	overlays := []struct {
		name        string
		prefix      string
		annotations map[string]string
	}{
		{
			name:   "prod-oci",
			prefix: "oci-",
			annotations: map[string]string{
				"oci.oraclecloud.com/load-balancer-type": "nlb",
			},
		},
		{
			name:   "prod-aws",
			prefix: "aws-",
			annotations: map[string]string{
				"service.beta.kubernetes.io/aws-load-balancer-type": "external",
			},
		},
		{
			name:   "prod-gcp",
			prefix: "gcp-",
			annotations: map[string]string{
				"cloud.google.com/load-balancer-type": "External",
			},
		},
		{
			name:   "prod-do",
			prefix: "do-",
			annotations: map[string]string{
				"service.beta.kubernetes.io/do-loadbalancer-protocol": "tcp",
			},
		},
		{
			name:   "prod-hetzner",
			prefix: "hetzner-",
			annotations: map[string]string{
				"load-balancer.hetzner.cloud/type": "lb11",
			},
		},
		{
			name:   "prod-vultr",
			prefix: "vultr-",
			annotations: map[string]string{
				"service.beta.kubernetes.io/vultr-loadbalancer-protocol": "tcp",
			},
		},
	}

	for _, tc := range overlays {
		t.Run(tc.name, func(t *testing.T) {
			docs := renderKustomizeOverlay(t, tc.name)
			if len(docs) == 0 {
				t.Fatalf("Overlay %s rendered 0 resources", tc.name)
			}

			var relaySvc map[string]interface{}
			for _, doc := range docs {
				meta := doc["metadata"].(map[string]interface{})
				name := meta["name"].(string)
				ns, _ := meta["namespace"].(string)

				if !strings.HasPrefix(name, tc.prefix) {
					t.Errorf("Resource %s does not have prefix %s in overlay %s", name, tc.prefix, tc.name)
				}
				if ns != "sovereign-mesh" {
					t.Errorf("Resource %s has invalid namespace %q in overlay %s (expected 'sovereign-mesh')", name, ns, tc.name)
				}

				if doc["kind"] == "Service" && strings.Contains(name, "relay") {
					relaySvc = doc
				}
			}

			if relaySvc == nil {
				t.Fatalf("Relay Service not found in overlay %s", tc.name)
			}

			meta := relaySvc["metadata"].(map[string]interface{})
			ann, _ := meta["annotations"].(map[string]interface{})
			if ann == nil {
				t.Fatalf("Relay Service missing annotations in overlay %s", tc.name)
			}

			for k, expectedVal := range tc.annotations {
				actualVal, exists := ann[k].(string)
				if !exists {
					t.Errorf("Overlay %s: Relay Service missing annotation %s", tc.name, k)
				} else if actualVal != expectedVal {
					t.Errorf("Overlay %s: Annotation %s mismatch: got %q, want %q", tc.name, k, actualVal, expectedVal)
				}
			}
		})
	}
}

// ============================================================================
// 4. ADVERSARIAL NETWORKPOLICY & RFC 1918 BOGON ISOLATION AUDIT
// ============================================================================

func TestNetworkPolicyRFC1918BogonIsolation(t *testing.T) {
	docs := renderHelmChart(t, "", "netpol-bogon-test")

	var netpol map[string]interface{}
	for _, doc := range docs {
		if doc["kind"] == "NetworkPolicy" {
			netpol = doc
			break
		}
	}

	if netpol == nil {
		t.Fatalf("NetworkPolicy not found in rendered Helm chart")
	}

	spec := netpol["spec"].(map[string]interface{})
	egressList := spec["egress"].([]interface{})

	var exceptCIDRs []string
	var hasDNSRule bool

	for _, r := range egressList {
		rule := r.(map[string]interface{})
		if ports, hasPorts := rule["ports"].([]interface{}); hasPorts {
			for _, p := range ports {
				pMap := p.(map[string]interface{})
				if pMap["port"] == 53 {
					hasDNSRule = true
				}
			}
		}
		if toList, hasTo := rule["to"].([]interface{}); hasTo {
			for _, tItem := range toList {
				toMap := tItem.(map[string]interface{})
				if ipBlock, hasIPBlock := toMap["ipBlock"].(map[string]interface{}); hasIPBlock {
					if ipBlock["cidr"] == "0.0.0.0/0" {
						if exceptList, hasExcept := ipBlock["except"].([]interface{}); hasExcept {
							for _, ex := range exceptList {
								exceptCIDRs = append(exceptCIDRs, ex.(string))
							}
						}
					}
				}
			}
		}
	}

	if !hasDNSRule {
		t.Errorf("NetworkPolicy missing DNS port 53 egress rule")
	}

	expectedBogonCIDRs := []string{
		"10.0.0.0/8",     // RFC 1918 Class A
		"172.16.0.0/12",  // RFC 1918 Class B
		"192.168.0.0/16", // RFC 1918 Class C
		"169.254.0.0/16", // Link-Local / Cloud Metadata
		"127.0.0.0/8",    // Loopback
	}

	for _, exp := range expectedBogonCIDRs {
		found := false
		for _, act := range exceptCIDRs {
			if act == exp {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("CRITICAL SECURITY FLAW: Bogon subnet %s is NOT in NetworkPolicy except list", exp)
		}
	}

	var ipNets []*net.IPNet
	for _, c := range exceptCIDRs {
		_, parsedNet, err := net.ParseCIDR(c)
		if err != nil {
			t.Fatalf("Failed to parse CIDR %s: %v", c, err)
		}
		ipNets = append(ipNets, parsedNet)
	}

	blockedIPs := []string{
		"10.0.0.1", "10.10.10.10", "10.255.255.254",
		"172.16.0.1", "172.20.100.5", "172.31.255.254",
		"192.168.0.1", "192.168.1.1", "192.168.255.254",
		"169.254.169.254", // AWS/GCP/OCI metadata
		"127.0.0.1", "127.0.0.53",
	}

	for _, ipStr := range blockedIPs {
		ip := net.ParseIP(ipStr)
		if ip == nil {
			t.Fatalf("Invalid IP string: %s", ipStr)
		}
		matched := false
		for _, n := range ipNets {
			if n.Contains(ip) {
				matched = true
				break
			}
		}
		if !matched {
			t.Errorf("CRITICAL SECURITY FLAW: Private/Bogon IP %s was NOT matched by any NetworkPolicy except CIDR (would allow illegal egress to internal LAN/metadata)", ipStr)
		}
	}

	allowedIPs := []string{
		"1.1.1.1", "8.8.8.8", "9.9.9.9",
		"142.250.190.46", "151.101.1.140", "104.244.42.1",
		"9.255.255.255", "11.0.0.1",
		"172.15.255.255", "172.32.0.1",
		"192.167.255.255", "192.169.0.1",
	}

	for _, ipStr := range allowedIPs {
		ip := net.ParseIP(ipStr)
		if ip == nil {
			t.Fatalf("Invalid IP string: %s", ipStr)
		}
		matched := false
		for _, n := range ipNets {
			if n.Contains(ip) {
				matched = true
				break
			}
		}
		if matched {
			t.Errorf("CRITICAL SECURITY FLAW: Valid public IP %s was matched by NetworkPolicy except CIDR (would break legitimate Internet proxy egress)", ipStr)
		}
	}
}

// ============================================================================
// 5. SECURITY CONTEXT & PRIVILEGE AUDIT
// ============================================================================

func TestSecurityCapabilitiesAndVolumeScoping(t *testing.T) {
	docs := renderHelmChart(t, "", "security-audit")

	var foundEdge, foundRelay, foundDecoy bool

	for _, doc := range docs {
		kind := doc["kind"].(string)
		meta := doc["metadata"].(map[string]interface{})
		name := meta["name"].(string)

		if kind == "DaemonSet" && strings.Contains(name, "edge-gateway") {
			foundEdge = true
			spec := doc["spec"].(map[string]interface{})
			template := spec["template"].(map[string]interface{})
			podSpec := template["spec"].(map[string]interface{})

			if podSpec["hostNetwork"] != true {
				t.Errorf("Edge gateway DaemonSet missing hostNetwork: true for kernel netstack routing")
			}

			containers := podSpec["containers"].([]interface{})
			c := containers[0].(map[string]interface{})
			secCtx := c["securityContext"].(map[string]interface{})
			caps := secCtx["capabilities"].(map[string]interface{})
			addCaps := caps["add"].([]interface{})

			var hasNetAdmin, hasNetRaw bool
			for _, cap := range addCaps {
				if cap == "NET_ADMIN" {
					hasNetAdmin = true
				}
				if cap == "NET_RAW" {
					hasNetRaw = true
				}
			}
			if !hasNetAdmin || !hasNetRaw {
				t.Errorf("Edge gateway container missing NET_ADMIN or NET_RAW capabilities: %v", addCaps)
			}
		}

		if kind == "StatefulSet" && strings.Contains(name, "relay") {
			foundRelay = true
			spec := doc["spec"].(map[string]interface{})
			template := spec["template"].(map[string]interface{})
			podSpec := template["spec"].(map[string]interface{})

			if podSpec["hostNetwork"] != true {
				t.Errorf("Relay StatefulSet missing hostNetwork: true for line-rate STUN/DERP")
			}
		}

		if kind == "Deployment" && strings.Contains(name, "decoy") {
			foundDecoy = true
			spec := doc["spec"].(map[string]interface{})
			template := spec["template"].(map[string]interface{})
			podSpec := template["spec"].(map[string]interface{})
			containers := podSpec["containers"].([]interface{})
			c := containers[0].(map[string]interface{})
			secCtx, _ := c["securityContext"].(map[string]interface{})
			if secCtx == nil || secCtx["allowPrivilegeEscalation"] != false {
				t.Errorf("Decoy container should explicitly have allowPrivilegeEscalation: false")
			}
		}
	}

	if !foundEdge || !foundRelay || !foundDecoy {
		t.Errorf("Audit incomplete: foundEdge=%t, foundRelay=%t, foundDecoy=%t", foundEdge, foundRelay, foundDecoy)
	}
}

func TestHelmRelayAutoscalingAndKEDAScaledObject(t *testing.T) {
	valuesRelayAutoscaling := `
relay:
  autoscaling:
    enabled: true
    minReplicas: 4
    maxReplicas: 32
    targetCPUUtilizationPercentage: 65
    targetMemoryUtilizationPercentage: 75
    customMetrics:
      activeConnections:
        enabled: true
        targetAverageValue: "2500"
  keda:
    enabled: true
    minReplicaCount: 4
    maxReplicaCount: 32
    pollingInterval: 15
    cooldownPeriod: 300
    serverAddress: "http://prometheus-server.monitoring.svc.cluster.local:9090"
    metricName: "sovereign_relay_active_connections"
    query: "sum(rate(sovereign_derp_active_sockets[1m]))"
    threshold: "2500"
`
	docs := renderHelmChart(t, valuesRelayAutoscaling, "relay-scaling-test")
	var foundRelayHPA, foundKEDA bool
	for _, doc := range docs {
		kind := doc["kind"].(string)
		meta := doc["metadata"].(map[string]interface{})
		name := meta["name"].(string)

		if kind == "HorizontalPodAutoscaler" && strings.HasSuffix(name, "-relay") {
			foundRelayHPA = true
			spec := doc["spec"].(map[string]interface{})
			minR := int(spec["minReplicas"].(int))
			maxR := int(spec["maxReplicas"].(int))
			if minR != 4 || maxR != 32 {
				t.Errorf("Relay HPA min/max mismatch: got %d/%d, want 4/32", minR, maxR)
			}
			targetRef := spec["scaleTargetRef"].(map[string]interface{})
			if targetRef["kind"] != "StatefulSet" || !strings.Contains(targetRef["name"].(string), "relay") {
				t.Errorf("Relay HPA scaleTargetRef invalid: %v", targetRef)
			}
		}

		if kind == "ScaledObject" && strings.HasSuffix(name, "-relay-keda") {
			foundKEDA = true
			spec := doc["spec"].(map[string]interface{})
			minR := int(spec["minReplicaCount"].(int))
			maxR := int(spec["maxReplicaCount"].(int))
			if minR != 4 || maxR != 32 {
				t.Errorf("KEDA ScaledObject replica mismatch: got %d/%d, want 4/32", minR, maxR)
			}
			triggers := spec["triggers"].([]interface{})
			if len(triggers) == 0 {
				t.Errorf("KEDA ScaledObject has no triggers")
			}
		}
	}

	if !foundRelayHPA {
		t.Errorf("Relay HPA was not rendered when relay.autoscaling.enabled=true")
	}
	if !foundKEDA {
		t.Errorf("Relay KEDA ScaledObject was not rendered when relay.keda.enabled=true")
	}
}
