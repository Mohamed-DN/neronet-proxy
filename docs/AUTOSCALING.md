# Sovereign Proxy v4.0 (NeroNet) — Auto-Scaling Architecture & Engineering Specification

> Design document from an earlier phase. It has not been checked against the code. Where it differs from [the handbook](HANDBOOK.md), the handbook is right. The Helm chart, the Terraform modules and the cloud scaling groups it describes have never been applied to a real cluster or cloud account ([ADR 0012](adr/0012-deployment-target-vm-first.md)).

## Document Overview
- **Author**: Sovereign Mesh Architecture Team
- **Version**: 4.0.0
- **Status**: Active / Production Blueprint
- **Scope**: Multi-Cloud Infrastructure, Kubernetes Fleets, and Decentralized Local Nodes

---

## 1. Executive Summary & Architectural Philosophy

Sovereign Proxy v4.0 (NeroNet) is a decentralized, zero-trust overlay mesh engineered for line-rate traffic proxying, anti-censorship routing, and high-performance packet relaying. The global mesh comprises two fundamentally distinct tiers of nodes:

1. **Cloud Relay & Control Infrastructure**: High-bandwidth, cloud-hosted virtual machines and containerized pods running in Oracle Cloud Infrastructure (OCI), Amazon Web Services (AWS), Google Cloud Platform (GCP), DigitalOcean, Hetzner, and Vultr. These nodes act as high-throughput STUN discovery endpoints, DERP-v4/v5 packet relays, and control plane consensus hubs.
2. **Local Edge & Residential Nodes**: Privately owned user hardware (residential desktops, laptops, home servers, Raspberry Pis, and mobile clients) providing genuine ISP IP egress, anti-bot residential routing, and onion-circuit relaying.

Because these two tiers operate under drastically different physical and economic constraints, Sovereign Proxy v4.0 enforces a **Dual-Tier Auto-Scaling Philosophy**:

```
+-------------------------------------------------------------------------------------------------------------------+
|                                      SOVEREIGN MESH DUAL-TIER AUTO-SCALING PHILOSOPHY                              |
+-------------------------------------------------------------------------------------------------------------------+
|                                                                                                                   |
|   ========================================= CLOUD TIER =========================================                  |
|   * Elasticity Mode:      AGGRESSIVE AUTO-SCALING & RAPID BURST PROVISIONING                                      |
|   * Primary Objective:    Zero packet drop, unthrottled line-rate DERP packet routing, high-concurrency absorb.    |
|   * Scaling Mechanics:    OCI Instance Pools, AWS Auto Scaling Groups (ASG), Kubernetes HPA v2 / KEDA.            |
|   * Scale-Up Speed:       Instant (0s stabilization window, +100% capacity step jumps).                            |
|   * Scale-Down Speed:     Conservative & Graceful (300s stabilization, 120s-300s socket drain windows).           |
|                                                                                                                   |
|   ========================================= LOCAL TIER =========================================                  |
|   * Elasticity Mode:      BOUNDED / LIMITED SCALE & PHYSICAL SAFEGUARDS                                           |
|   * Primary Objective:    Preserve host usability, protect battery life, enforce ISP data quotas, rootless isol.  |
|   * Scaling Mechanics:    Strict concurrency semaphores (max 10 streams), token-bucket bandwidth limiters,        |
|                           cgroups CPU/memory caps, Battery Guardian, Data Cap Guardian, Two-Stage Drain.           |
|   * Routing Priority:     High-reputation residential boost (+15 score) with automatic failover to Cloud Relays. |
|                                                                                                                   |
+-------------------------------------------------------------------------------------------------------------------+
```

---

## 2. System Overview & Auto-Scaling Topology

The global network topology is organized into an interconnected hierarchical overlay network as shown below:

```
                                  +------------------------------+
                                  |     Global Mesh Clients      |
                                  +--------------+---------------+
                                                 |
                       +-------------------------+-------------------------+
                       |                                                   |
                       v                                                   v
      +----------------------------------+               +----------------------------------+
      |      Cloud Relay Fleet (OCI)     |               |      Cloud Relay Fleet (AWS)     |
      | - OCI Instance Pool              |               | - AWS Auto Scaling Group (ASG)   |
      | - Shape: VM.Standard.A1.Flex     |               | - Shape: c7g.large (Graviton3)   |
      | - Metric: CPU > 65% / DERP Sockets|               | - Metric: Target Tracking CPU 60%|
      | - Min: 2, Max: 20, Desired: 4    |               | - Min: 2, Max: 20, Desired: 4    |
      +-----------------+----------------+               +-----------------+----------------+
                        |                                                  |
                        +-------------------------+------------------------+
                                                  |
                                                  v
                               +------------------------------------+
                               |   Kubernetes Fleet (Relay & CP)    |
                               | - Relay HPA v2 (Min: 4, Max: 32)   |
                               | - Control Plane HPA (Min: 3, Max:10|
                               | - KEDA ScaledObject (Prometheus)   |
                               +------------------+-----------------+
                                                  |
                                                  v
                      +---------------------------------------------------+
                      |      Decentralized Local Residential Nodes        |
                      | - Hard Concurrency Cap (Max 10 Streams)           |
                      | - CPU Quota: Max 25% | RAM: 512MB Hard Cap        |
                      | - Battery Guardian (<20% Auto-Suspend, <15% Exit) |
                      | - Data Cap Guardian (90% Quota Auto-Drain)        |
                      | - Two-Stage Graceful Drain (45s Drain Window)     |
                      +---------------------------------------------------+
```

---

## 3. Aggressive Cloud Auto-Scaling Architecture

Cloud relay nodes are stateless packet forwarders that encapsulate client traffic into DERP-v4/v5 frames over TLS (port 443) and STUN packet probes over UDP (port 3478). Cloud scaling must instantly react to surges in connection attempts and packet volume.

### 3.1 Oracle Cloud Infrastructure (OCI) Auto-Scaling

The OCI auto-scaling implementation utilizes **OCI Instance Configurations**, **OCI Instance Pools**, and **OCI Autoscaling Configurations** defined in `terraform/modules/oci/autoscaling.tf`.

#### 3.1.1 Architectural Design
1. **Compute Shape**: Employs ARM64 Ampere A1 Compute (`VM.Standard.A1.Flex`, 4 OCPUs, 24 GB RAM) for cost efficiency and line-rate AES-GCM cryptography acceleration.
2. **Instance Configuration (`oci_core_instance_configuration`)**:
   - Packages base operating system image (Ubuntu 24.04 LTS / Oracle Linux 9).
   - Injects cloud-init `user_data` containing the automated node registration agent.
   - Configures VNIC parameters for public IP assignment across OCI VCN subnets.
3. **Instance Pool (`oci_core_instance_pool`)**:
   - Spans all Availability Domains (AD-1, AD-2, AD-3) in the region for high availability.
   - Manages instance lifecycles with dynamic size management (`min = 2`, `max = 20`, `initial = 4`).
4. **Metric-Based Autoscaling Configuration (`oci_autoscaling_auto_scaling_configuration`)**:
   - **Scale-Out Policy**: Triggers when average CPU utilization exceeds **65%** for a 60-second evaluation window. Adds **+2 instances** (+50% capacity boost) with a 60-second cooldown.
   - **Scale-In Policy**: Triggers when average CPU utilization drops below **30%** for a sustained 300-second evaluation window. Removes **-1 instance** per step with a 300-second cooldown.

#### 3.1.2 Cloud-Init Auto-Enrollment Workflow
```
[ Instance Boot ]
       |
       v
[ Cloud-Init executes /opt/sovereign/scripts/bootstrap.sh ]
       |
       v
[ Generates Ephemeral Node ID: node-oci-${REGION}-${INSTANCE_OCID: -8} ]
       |
       v
[ Registers with Control Plane via gRPC / HTTPS POST /api/v1/nodes/register ]
       |
       v
[ Control Plane assigns Overlay VIP 100.64.x.y and notifies mesh peers ]
       |
       v
[ Healthcheck validates STUN (UDP 3478) and DERP (TCP 443) ]
       |
       v
[ Node enters ACTIVE Routing State ]
```

---

### 3.2 Amazon Web Services (AWS) Auto-Scaling

The AWS auto-scaling implementation leverages **EC2 Launch Templates**, **Auto Scaling Groups (ASG)**, **Target Tracking Scaling Policies**, **Step Scaling Policies**, **CloudWatch Alarms**, and **EC2 Terminating Lifecycle Hooks** defined in `terraform/modules/aws/autoscaling.tf`.

#### 3.2.1 Architectural Design
1. **Compute Instances**: AWS Graviton3 (`c7g.large` / `t4g.small`) across multiple Availability Zones (`us-east-1a`, `us-east-1b`, `us-east-1c`).
2. **Launch Template (`aws_launch_template`)**:
   - Configures network interfaces with public IP association and security group bindings (ports 2222 SSH, 443 HTTPS/DERP, 80 HTTP ACME, 3478 UDP STUN, 8080 Honeypot).
   - Enables Detailed CloudWatch Monitoring (1-minute metric granularity).
   - Injects cloud-init bootstrap script.
3. **Auto Scaling Group (`aws_autoscaling_group`)**:
   - Capacity bounds: `min_size = 2`, `max_size = 20`, `desired_capacity = 4`.
   - Health check: `EC2` with 120-second grace period.
   - Termination policies: `OldestInstance` followed by `Default`.
4. **Dual Scaling Policies**:
   - **Target Tracking (`aws_autoscaling_policy.cpu_target_tracking`)**: Maintains average CPU utilization at **60.0%**.
   - **Step Scaling for Traffic Spikes (`aws_autoscaling_policy.scale_out_traffic`)**: Triggered by CloudWatch Alarm `aws_cloudwatch_metric_alarm.high_network_traffic` when `NetworkIn` exceeds 100 MB/s. Adds **+2 instances** immediately.
   - **Step Scaling for Idle Capacity (`aws_autoscaling_policy.scale_in_traffic`)**: Triggered when `NetworkIn` remains below 10 MB/s for 5 consecutive periods (300 seconds). Decrements by **-1 instance**.
5. **Graceful Termination Lifecycle Hook (`aws_autoscaling_lifecycle_hook`)**:
   - Hooks into `autoscaling:EC2_INSTANCE_TERMINATING`.
   - Grants a **120-second heartbeat window** allowing terminating instances to send a drain signal to the Control Plane, refuse new connections, and flush active TCP circuits before physical instance decommissioning.

---

### 3.3 Kubernetes Auto-Scaling (HPA v2 & KEDA)

For containerized cloud deployments, Sovereign Mesh provides dynamic pod autoscaling via Kubernetes **HorizontalPodAutoscaler (HPA v2)** and optional **KEDA ScaledObjects**.

#### 3.3.1 Relay Fleet Autoscaler (`charts/sovereign-mesh/templates/relay-hpa.yaml`)
Relay nodes run as StatefulSets or Deployments with `hostNetwork: true` for direct kernel network performance. The Relay HPA dynamically scales replicas between **4** and **32** based on:
1. **Resource Metrics**:
   - Target CPU Utilization: **65%**
   - Target Memory Utilization: **75%**
2. **Custom Pod Metrics (Prometheus Adapter)**:
   - Metric: `sovereign_relay_active_connections` (Target: **2,500 connections per pod**)
   - Metric: `sovereign_relay_bandwidth_bytes_per_sec` (Target: **100 MB/s per pod**)
3. **Asymmetric Scaling Behavior**:
   ```yaml
   behavior:
     scaleUp:
       stabilizationWindowSeconds: 0      # Zero delay for instant scale-up
       policies:
         - type: Percent
           value: 100                     # Double capacity in 15 seconds
           periodSeconds: 15
         - type: Pods
           value: 4                       # Add at least 4 pods
           periodSeconds: 15
       selectPolicy: Max
     scaleDown:
       stabilizationWindowSeconds: 300    # 5-minute stabilization prevents flapping
       policies:
         - type: Percent
           value: 10                      # Maximum 10% reduction per minute
           periodSeconds: 60
         - type: Pods
           value: 1
           periodSeconds: 60
       selectPolicy: Min
   ```

#### 3.3.2 KEDA ScaledObject Integration (`charts/sovereign-mesh/templates/relay-keda-scaledobject.yaml`)
When KEDA is enabled (`relay.keda.enabled = true`), scaling triggers directly off Prometheus PromQL queries against the relay metric exporter:
```yaml
triggers:
  - type: prometheus
    metadata:
      serverAddress: "http://prometheus-server.monitoring.svc.cluster.local:9090"
      metricName: "sovereign_relay_active_connections"
      query: "sum(rate(sovereign_derp_active_sockets[1m]))"
      threshold: "2500"
```

#### 3.3.3 Control Plane Consensus Boundary
The Sovereign Control Plane uses an embedded Raft consensus algorithm (`pkg/control/`).
- **Stateless API Frontends**: Managed by `control-plane-hpa.yaml`, scaling dynamically between **3** and **10** replicas to serve high-volume heartbeat, routing discovery, and node registration requests.
- **Raft Voter Quorum**: Fixed at an odd number of voting members (typically **3** or **5** core members) to guarantee linearizable consensus without split-brain anomalies. HPA scales read-only follower / API gateway replicas.

---

## 4. Bounded / Limited Local Node Auto-Scaling Architecture

Local residential nodes are user-contributed or user-owned devices. They must operate under strict safeguards to prevent degrading the user's personal internet connection, overheating hardware, draining mobile/laptop batteries, or exceeding ISP monthly data caps.

```
+-------------------------------------------------------------------------------------------------------------------+
|                                      LOCAL RESIDENTIAL NODE GOVERNANCE STACK                                      |
+-------------------------------------------------------------------------------------------------------------------+
|                                                                                                                   |
|   +-----------------------------------------------------------------------------------------------------------+   |
|   |  [1] HARD CONCURRENCY SEMAPHORE (`pkg/bridge/netstack.go`)                                                |   |
|   |  - Desktop / Home Server: Max 10 concurrent streams                                                       |   |
|   |  - Laptop / Low-Power Device: Max 5 concurrent streams                                                    |   |
|   |  - Mobile Client (5G/LTE): Max 2 concurrent streams                                                       |   |
|   |  - When saturated: Fast rejection `ErrMaxConcurrencyReached` -> Client redirects to Cloud Relay           |   |
|   +-----------------------------------------------------------------------------------------------------------+   |
|                                                     |                                                             |
|   +-------------------------------------------------v---------------------------------------------------------+   |
|   |  [2] RESOURCE & PRIVILEGE BOUNDS (`docker/docker-compose.yml`)                                            |   |
|   |  - CPU Limit: Max 25% host CPU (`limits.cpus: '0.25'` to `'0.50'`)                                       |   |
|   |  - Memory Limit: Hard 512MB RAM cap (`limits.memory: 512M`)                                               |   |
|   |  - User Isolation: Rootless container (`user: 10001:10001`), read-only filesystem, zero root capabilities    |   |
|   |  - Userspace TCP/IP: Netstack operating entirely in user memory (no kernel tun/tap or host IP table mods) |   |
|   +-----------------------------------------------------------------------------------------------------------+   |
|                                                     |                                                             |
|   +-------------------------------------------------v---------------------------------------------------------+   |
|   |  [3] DEVICE GUARDIAN SAFEGUARDS (`pkg/bridge/guardian.go`)                                                |   |
|   |  - Battery Level >= 25% or AC Connected: Full normal operation                                            |   |
|   |  - Battery Level < 20% on Battery: Triggers auto-suspension & sends `drain_and_exit` to Control Plane      |   |
|   |  - Battery Level < 15% on Battery: Emergency instant cutoff                                               |   |
|   |  - ISP Monthly Quota: Tracks cumulative transferred MB; at 90% of quotaCapMB -> Auto-draining initiated   |   |
|   +-----------------------------------------------------------------------------------------------------------+   |
|                                                     |                                                             |
|   +-------------------------------------------------v---------------------------------------------------------+   |
|   |  [4] TWO-STAGE GRACEFUL DRAINING PROTOCOL                                                                 |   |
|   |  Stage 1 (Signal): Node sends Heartbeat with `drain_and_exit = true` and `active_circuits` count           |   |
|   |  Stage 2 (Isolation): Control Plane updates Registry & Routing: sets `Score = 0`, `Enabled = false`        |   |
|   |  Stage 3 (Drain Window): 45-second timer allows active TCP flows to finish without reset                  |   |
|   |  Stage 4 (Shutdown): Listeners close, VIP released, process terminates cleanly                           |   |
|   +-----------------------------------------------------------------------------------------------------------+   |
|                                                     |                                                             |
|   +-------------------------------------------------v---------------------------------------------------------+   |
|   |  [5] RESIDENTIAL NODE PRIORITY ROUTING (`pkg/routing/scoring.go`)                                         |   |
|   |  - Authentic Residential IP Bonus: +15 Composite Score or 1.25x multiplier                                |   |
|   |  - Multi-Tier Egress Preference: [1] Residential Node -> [2] Cloud Edge Gateway -> [3] Onion Circuit      |   |
|   +-----------------------------------------------------------------------------------------------------------+   |
+-------------------------------------------------------------------------------------------------------------------+
```

### 4.1 Concurrency Caps and Rate Limiting
- **Atomic Semaphore**: Implemented in userspace netstack (`pkg/bridge/netstack.go`). Inbound connection requests acquire a slot from an atomic semaphore. If active streams reach `MaxConcurrentStreams`, additional requests are dropped with `ErrMaxConcurrencyReached`.
- **Token Bucket Egress Limiter**: Enforces a strict bandwidth ceiling (`max_bandwidth_kbps`, default 25 Mbps) to prevent bandwidth saturation on the residential connection.

### 4.2 Device Guardian Safeguards
The `Guardian` subsystem (`pkg/bridge/guardian.go`) continuously monitors hardware vitals:
1. **Battery Level Rules**:
   - AC Power Connected: Full capacity.
   - On Battery and $\ge 25\%$: Normal operation.
   - On Battery and $< 20\%$: Suspends egress routing; signals Control Plane in next heartbeat.
   - On Battery and $< 15\%$: Emergency shutdown.
2. **ISP Monthly Data Cap Rules**:
   - Tracks cumulative transferred bytes.
   - When usage reaches **90% of monthly cap**, the node transitions to Draining mode.
   - When usage reaches **100% of cap**, the node immediately disconnects from the mesh.

### 4.3 Two-Stage Graceful Draining Protocol
```
Event (SIGTERM, Low Battery <20%, Quota >=90%, User Toggle Off)
                           |
                           v
    [ Step 1: Local Node sends Heartbeat with DrainAndExit = true ]
                           |
                           v
    [ Step 2: Control Plane sets Score = 0 and Enabled = false ]
        (Zero new clients will be routed to this node)
                           |
                           v
    [ Step 3: Local Node initiates Drain Window (45 seconds) ]
        (In-flight TCP streams continue unmolested)
                           |
                           v
    [ Step 4: Active streams drop to 0 OR 45s timer expires ]
                           |
                           v
    [ Step 5: Sockets closed, VIP released, process exits cleanly ]
```

### 4.4 Residential Node Prioritization in Dynamic Routing
The Control Plane path scoring engine (`pkg/routing/scoring.go`) scores candidates according to:

$$\text{Score} = \left(35 \times \frac{\text{BW}_{\text{avail}}}{\text{BW}_{\text{max}}}\right) + \left(30 \times \frac{100}{\text{RTT} + 1}\right) + \left(20 \times (1 - \text{Loss})\right) + \left(15 \times \text{Reputation}\right) - 0.05 \times \text{Jitter}$$

When residential egress is requested by a client:
- **Residential Node Bonus**: Multiplied by $1.25\times$ or credited with a $+15$ point reputation boost.
- **Datacenter Node Penalty**: Multiplied by $0.90\times$.
- **Routing Fallback Hierarchy**:
  1. **Tier 1 (Preferred)**: Genuine Residential Nodes with Score $\ge 60$.
  2. **Tier 2 (Fallback)**: Cloud Edge Gateways in target region.
  3. **Tier 3 (Censorship Evasion)**: 3-Hop Onion Obfuscation Circuit.

---

## 5. Metric Thresholds Reference Matrix

| Metric Name | Scope | Warning Threshold | Critical Scale Threshold | Scale Action | Cooldown |
|---|---|---|---|---|---|
| **OCI Average CPU** | OCI Pool | $> 55\%$ | $> 65\%$ | $+2$ Instances (+50%) | 60s |
| **OCI Idle CPU** | OCI Pool | $< 35\%$ | $< 30\%$ | $-1$ Instance | 300s |
| **AWS ASG CPU** | AWS ASG | $> 50\%$ | Target: $60\%$ | Target Tracking step | Automated |
| **AWS Inbound Network** | AWS ASG | $> 75\text{ MB/s}$ | $\ge 100\text{ MB/s}$ | $+2$ Instances | 120s |
| **AWS Low Network** | AWS ASG | $< 20\text{ MB/s}$ | $< 10\text{ MB/s}$ | $-1$ Instance | 300s |
| **Relay Active Sockets** | K8s Relay | $> 2,000\text{ /pod}$ | $\ge 2,500\text{ /pod}$ | Scale Up (+100% or +4 pods) | 0s |
| **Relay CPU Utilization** | K8s Relay | $> 55\%$ | $\ge 65\%$ | Scale Up HPA | 0s |
| **Relay Memory Utilization** | K8s Relay | $> 65\%$ | $\ge 75\%$ | Scale Up HPA | 0s |
| **Control Plane CPU** | K8s CP | $> 60\%$ | $\ge 75\%$ | Scale Up HPA (+2 pods) | 0s |
| **Local Active Streams** | Residential | $\ge 8\text{ streams}$ | $\ge 10\text{ streams}$ | Fast Rejection `ErrMaxConcurrency` | Instant |
| **Local Battery Level** | Local Node | $< 25\%$ | $< 20\%$ | Initiate Graceful Drain | Instant |
| **Local Battery Critical** | Local Node | $< 18\%$ | $< 15\%$ | Emergency Cutoff | Instant |
| **Local ISP Data Quota** | Local Node | $\ge 80\%$ | $\ge 90\%$ | Initiate Graceful Drain | Instant |

---

## 6. Operational Runbooks & Disaster Recovery

### Runbook 1: Sudden Global Traffic Surge / Flash Crowd
- **Symptom**: CloudWatch Alarms trigger on `NetworkIn >= 100MB/s`; Prometheus alerts `sovereign_relay_active_connections > 2500`.
- **Automated Behavior**:
  1. AWS ASG executes Step Scaling Policy (+2 instances per AZ).
  2. OCI Instance Pool provisions +2 Ampere A1 instances.
  3. K8s Relay HPA bursts +100% replicas within 15 seconds.
- **Operator Verification**:
  ```bash
  # Check Kubernetes Relay Pod Count and HPA status
  kubectl get hpa -n default sovereign-mesh-relay
  kubectl get pods -l app.kubernetes.io/component=relay -o wide

  # Check AWS ASG instance capacity
  aws autoscaling describe-auto-scaling-groups --auto-scaling-group-names sovereign-global-mesh-asg
  ```
- **Manual Intervention (Emergency Force Scale)**:
  ```bash
  # Force Helm chart replica floor to 16
  helm upgrade sovereign-mesh charts/sovereign-mesh/ --set relay.replicas=16 --reuse-values
  ```

---

### Runbook 2: Cloud Provider Outage / AZ Evacuation
- **Symptom**: Complete loss of an OCI AD or AWS AZ; heartbeats cease from entire regional cluster.
- **Automated Behavior**:
  1. Control Plane `Registry.CheckStaleNodes(30s)` identifies unreachable nodes.
  2. Health watcher marks instances `IsHealthy = false`.
  3. `RoutingEngine` recalculates composite scores and diverts client circuits to healthy multi-cloud regions (OCI $\rightarrow$ AWS $\rightarrow$ GCP).
- **Operator Verification**:
  ```bash
  # Query Control Plane peer status metric
  curl -s http://localhost:9091/metrics | grep sovereign_peers_
  ```

---

### Runbook 3: Stuck Drain / Stale Node Remediation
- **Symptom**: An ASG instance or local node is in draining state, but TCP connections fail to drop after 120 seconds.
- **Automated Behavior**:
  1. AWS ASG Lifecycle Hook timeout (120s) forcibly completes with `CONTINUE`.
  2. Local node netstack timer forcibly severs remaining sockets after 45s.
- **Operator Action**:
  ```bash
  # Force unregister node from Control Plane API
  curl -X DELETE https://control.neronet.darknero.com/api/v1/nodes/node-aws-us-east-1-stale
  ```

---

### Runbook 4: Emergency Quota Exhaustion / DDoS on Local Node
- **Symptom**: Local node logs rapid data transfer spike from malicious or heavy egress flows.
- **Automated Behavior**:
  1. Netstack token bucket enforces hard 25 Mbps ceiling.
  2. Guardian detects `transferredMB >= 0.90 * quotaCapMB`.
  3. Node sets `drain_and_exit = true`, drops all new connections.
  4. At 100% quota, node disconnects immediately.

---

## 7. Verification & Attestation Commands

To independently verify the Auto-Scaling architecture across all configurations:

```bash
# 1. Validate Helm Chart Linting & Template Rendering
helm lint charts/sovereign-mesh/
helm template sovereign-test charts/sovereign-mesh/ -f charts/sovereign-mesh/values.yaml

# 2. Validate KEDA ScaledObject Rendering
helm template sovereign-test charts/sovereign-mesh/ --set relay.keda.enabled=true

# 3. Verify Entire Go Test Suite
go test -v ./pkg/control/... ./pkg/bridge/... ./pkg/routing/... ./pkg/config/... ./pkg/management/...

# 4. Verify End-to-End Stress & Mesh Scenarios
go test -v ./tests/stress/...
```
