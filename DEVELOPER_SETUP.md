# Developer Onboarding & Deployment Guide — Sovereign Proxy v4.0 (NeroNet)

Welcome to the **Sovereign Proxy v4.0 (NeroNet)** developer guide. This document provides an end-to-end, step-by-step onboarding walkthrough for software engineers, security researchers, and DevOps operators.

---

## Table of Contents
1. [Architecture Overview & System Topology](#1-architecture-overview--system-topology)
2. [Prerequisites & Development Environment](#2-prerequisites--development-environment)
3. [5-Minute Local Quickstart](#3-5-minute-local-quickstart)
4. [Centralized Configuration & Precedence Hierarchy](#4-centralized-configuration--precedence-hierarchy)
5. [Local Multi-Service Docker Compose Deployment](#5-local-multi-service-docker-compose-deployment)
6. [Multi-Cloud Provisioning with OpenTofu / Terraform](#6-multi-cloud-provisioning-with-opentofu--terraform)
7. [Kubernetes & Helm Deployment Guide](#7-kubernetes--helm-deployment-guide)
8. [Testing, Health Checks & Diagnostics](#8-testing-health-checks--diagnostics)
9. [Security Hardening & Zero-Trust Best Practices](#9-security-hardening--zero-trust-best-practices)
10. [Troubleshooting & Frequently Asked Questions (FAQ)](#10-troubleshooting--frequently-asked-questions-faq)

---

## 1. Architecture Overview & System Topology

Sovereign Proxy v4.0 is a decentralized, zero-trust overlay mesh engineered for high-throughput connectivity, active network defense, and anti-censorship resilience across heterogeneous cloud providers and residential edge gateways.

```
                     ┌────────────────────────────────────────────────────────┐
                     │          NeroNet Control Plane Coordinator             │
                     │          (Embedded Raft Consensus / VIP Alloc)         │
                     │              Port 8443 (REST) / 9443 (gRPC)            │
                     └───────────────────────▲────────────────────────────────┘
                                             │ Node Registration & Policy Sync
                                             │ (Noise Handshake / Mutual Auth)
                                             ▼
                 ┌────────────────────────────────────────────────────────┐
                 │           Camouflaged DERP Relay Fleet                 │
                 │   - Cloud-neutral Mesh Relay (TCP 443 / WebSocket)     │
                 │   - STUN NAT-Traversal Reflection (UDP 3478)           │
                 │   - Anti-Probing Active Decoy Server (Port 8080)       │
                 │   - Security Daemon Threat Watcher (eBPF / IPSet)      │
                 └───────────────▲────────────────────────▲───────────────┘
                                 │ Direct UDP /           │
                                 │ DERP Camouflage        │
          ┌──────────────────────┴───────┐        ┌───────┴──────────────────────┐
          │     Client Origin Node       │        │   Sandboxed Exit Gateway     │
          │  - Inbound SOCKS5 (1080)     │◄──────►│  - Residential / Cloud Exit  │
          │  - Inbound HTTP (8080)       │        │  - gVisor Netstack Sandbox   │
          │  - Curve25519 Identity       │        │  - Strict RFC 1918 Bogon Drop│
          │  - Posture Attestation Loop  │        │  - DoH Recursive Resolver    │
          └──────────────────────────────┘        └──────────────────────────────┘
```

### Core Subsystems & Components

| Component | Path | Description |
|---|---|---|
| **Control Plane** | `cmd/sovereign-control-plane` | Centralized coordinator handling node enrollment, Raft consensus state, dynamic ACL distribution, and endpoint posture attestation. |
| **DERP Relay** | `cmd/sovereign-derp-relay` | Camouflaged Tailscale-compatible DERP-v4 packet relay supporting WebSocket fallback, STUN NAT hairpinning, and anti-probing decoys. |
| **Client Node** | `cmd/sovereign-node` | Zero-trust client daemon providing local SOCKS5 (`127.0.0.1:1080`) and HTTP CONNECT (`127.0.0.1:8080`) proxy endpoints with user-space netstack isolation. |
| **Security Daemon** | `cmd/sovereign-security-daemon` | Active defense engine with dynamic honeypot listeners, token bucket rate limiters, threat scoring, and automated multi-backend firewall banning (`ipset`, `nftables`, `ufw`). |
| **Operator CLI** | `cmd/sovereign-cli` | Diagnostic and operational CLI for keypair generation, peer discovery, 3-Hop Onion circuit synthesis, and STUN latency probes. |
| **Configuration Engine** | `pkg/config` | Layered configuration manager supporting CLI flags, `.env` file parsing, YAML cluster validation, and secret sanitization. |

---

## 2. Prerequisites & Development Environment

Ensure your development workstation satisfies the following requirements:

### Required Tooling

- **Go**: Version `1.22.0` or higher (`go version`)
- **Python**: Version `3.11` or higher (`python3 --version`)
- **Docker & Docker Compose**: Docker Engine `24.0+`, Compose `v2.20+` (`docker compose version`)
- **OpenTofu / Terraform**: OpenTofu `1.6+` or Terraform `1.5+` (`tofu version` / `terraform version`)
- **Helm & Kubectl**: Helm `v3.14+`, Kubectl `v1.28+` (`helm version`, `kubectl version`)
- **OpenSSL / Utilities**: `openssl`, `uuidgen`, `make`, `curl`, `git`

### Recommended System Settings (Linux / macOS)

For high-throughput relay and netstack performance:

```bash
# Enable BBR and tune network buffers (Linux)
sudo sysctl -w net.core.default_qdisc=fq
sudo sysctl -w net.ipv4.tcp_congestion_control=bbr
sudo sysctl -w net.ipv4.ip_forward=1
```

---

## 3. 5-Minute Local Quickstart

Get a local Sovereign Proxy mesh running on your workstation in under 5 minutes with zero cloud costs.

### Step 1: Clone the Repository

```bash
git clone https://github.com/Mohamed-DN/sovereign-oci-proxy.git
cd sovereign-oci-proxy
```

### Step 2: Initialize Configuration from Template

```bash
cp .env.example .env
chmod 600 .env
```

### Step 3: Build Core Binaries

```bash
make build
```
*Compiled binaries will be placed in the `bin/` directory:*
- `bin/sovereign-control-plane`
- `bin/sovereign-derp-relay`
- `bin/sovereign-node`
- `bin/sovereign-cli`

### Step 4: Generate Identity Keypairs

Generate a fresh Curve25519 node identity keypair using the CLI:

```bash
./bin/sovereign-cli keygen
```
*Example Output:*
```text
Generated NeroNet Curve25519 Keypair:
  Node ID:     node-6b583dfb12c9431e
  Public Key:  a8b79213efc1234901f4c781d098e217834bcdef901234567890abcdef123456
  Private Key: f912384091823740918237409182374091823740918237409182374091823740
```

Insert the generated private key into your `.env` file (`NOISE_PRIVATE_KEY=...`).

### Step 5: Launch Local Daemons

In separate terminal sessions (or via background jobs):

**1. Start Control Plane Coordinator:**
```bash
./bin/sovereign-control-plane --listen-addr 127.0.0.1:8443
```

**2. Start Camouflaged Relay Node:**
```bash
./bin/sovereign-derp-relay --listen-addr 127.0.0.1:8444 --stun-addr 127.0.0.1:3478 --region local-dev
```

**3. Start Client Node Ingress:**
```bash
./bin/sovereign-node --socks-addr 127.0.0.1:1080 --http-addr 127.0.0.1:8080 --control-url http://127.0.0.1:8443
```

### Step 6: Test Local Ingress Proxy

Route an HTTP request through the local SOCKS5 proxy:

```bash
curl -x socks5h://127.0.0.1:1080 https://cloudflare.com/cdn-cgi/trace
```

Inspect cluster status via CLI:

```bash
./bin/sovereign-cli status --control-url http://127.0.0.1:8443
```

---

## 4. Centralized Configuration & Precedence Hierarchy

Sovereign Proxy implements a strict 4-layer configuration precedence hierarchy:

```
┌─────────────────────────────────────────────────────────────┐
│ 1. CLI Command-Line Flags (--listen-addr, --enable-exit)    │ (Highest Priority)
├─────────────────────────────────────────────────────────────┤
│ 2. OS Environment Variables & '.env' File                   │
├─────────────────────────────────────────────────────────────┤
│ 3. Structured Cluster YAML (configs/mesh-cluster.yaml)      │
├─────────────────────────────────────────────────────────────┤
│ 4. In-Code Hardened Defaults                                │ (Lowest Priority)
└─────────────────────────────────────────────────────────────┘
```

### Subsystem Configuration Matrix (`.env`)

| # | Subsystem | Key Variables | Description |
|---|---|---|---|
| **1** | **Global Metadata** | `SOVEREIGN_CLUSTER_NAME`, `SOVEREIGN_DOMAIN`, `SOVEREIGN_OVERLAY_CIDR`, `SOVEREIGN_SSH_PORT` | Cluster naming, ACME domain, CGNAT CIDR block, and SSH port. |
| **2** | **Control Plane** | `SOVEREIGN_CONTROL_PLANE_LISTEN_ADDR`, `SOVEREIGN_CONTROL_PLANE_URL`, `SOVEREIGN_STATE_STORE_TYPE` | REST/gRPC bind addresses, Raft data directory, and registration token. |
| **3** | **Crypto & Noise** | `NOISE_SUITE`, `NOISE_PRIVATE_KEY`, `NOISE_PSK`, `NOISE_KEY_ROTATION_HOURS` | Curve25519 keypairs, Noise protocol suite, and rotation schedule. |
| **4** | **Relay Fleet** | `SOVEREIGN_RELAY_LISTEN_ADDR`, `SOVEREIGN_STUN_LISTEN_ADDR`, `SOVEREIGN_DECOY_DOMAIN` | DERP/STUN addresses, region tag, and anti-probing decoy mimicry target. |
| **5** | **Client & Exit Bridge**| `SOVEREIGN_SOCKS5_LISTEN_ADDR`, `SOVEREIGN_HTTP_LISTEN_ADDR`, `SOVEREIGN_ENABLE_EXIT_BRIDGE` | Inbound SOCKS5/HTTP proxy listeners and exit routing mode. |
| **6** | **Xray / VLESS Core** | `CLIENT_UUID`, `REALITY_PRIVATE_KEY`, `REALITY_SHORT_ID`, `WARP_PRIVATE_KEY` | VLESS authentication, REALITY TLS camouflage, and WARP exit keys. |
| **7** | **Active Defense** | `SOVEREIGN_HONEYPOT_PORT`, `SOVEREIGN_FIREWALL_DRIVER`, `SOVEREIGN_BAN_THRESHOLD` | Honeypot listener, threat scoring engine, and firewall driver (`ipset`/`nftables`). |
| **8** | **Notifications** | `NTFY_URL`, `NTFY_TOPIC`, `DUCKDNS_DOMAIN`, `DUCKDNS_TOKEN` | Push notification webhook and Dynamic DNS sync. |
| **9** | **Backups & Telemetry** | `GPG_RECIPIENT`, `BACKUP_PASSPHRASE`, `B2_BUCKET`, `PROMETHEUS_ENABLED` | Encrypted disaster recovery snapshots and Prometheus/Loki endpoints. |
| **10**| **Cloud Provisioning** | `OCI_COMPARTMENT_ID`, `AWS_REGION`, `GCP_PROJECT_ID`, `CONTAINER_REGISTRY` | Cloud provider credentials and container registry namespaces. |

---

## 5. Local Multi-Service Docker Compose Deployment

The repository includes a multi-service Docker Compose configuration for testing complete multi-container mesh clusters locally.

### Launching the Cluster

```bash
docker compose -f configs/docker-compose.cluster.yml up -d
```

### Inspected Services

```bash
docker compose -f configs/docker-compose.cluster.yml ps
```

| Container Service | Published Port | Purpose |
|---|---|---|
| `sovereign-control-plane` | `8443` (REST), `9443` (gRPC) | Mesh coordination and policy synchronization |
| `sovereign-derp-relay` | `443` (HTTPS/DERP), `3478/udp` (STUN) | Packet relay and NAT discovery |
| `sovereign-honeypot` | `8080` (HTTP) | Active defense scanner tarpit |
| `sovereign-watcher` | Host network | eBPF / IPSet firewall log monitor |

### Inspecting Container Logs

```bash
docker compose -f configs/docker-compose.cluster.yml logs -f sovereign-control-plane
```

### Graceful Teardown

```bash
docker compose -f configs/docker-compose.cluster.yml down
```

---

## 6. Multi-Cloud Provisioning with OpenTofu / Terraform

Sovereign Proxy includes Terraform / OpenTofu modules supporting **6 major cloud providers**:
1. **Oracle Cloud Infrastructure (OCI)**: Always-Free Tier Ampere A1 ARM64 (4 OCPUs, 24 GB RAM)
2. **Amazon Web Services (AWS)**: EC2 Graviton ARM64 (`t4g.small` / `t4g.medium`)
3. **Google Cloud Platform (GCP)**: Tau T2A Compute instances (`t2a-standard-1`)
4. **DigitalOcean**: Basic Droplets
5. **Hetzner Cloud**: CAX ARM64 cloud servers
6. **Vultr**: Cloud Compute instances

### Step 1: Export Terraform Variables from Mesh Config

The Go configuration engine can automatically generate provider `.tfvars.json` files directly from `configs/mesh-cluster.yaml`:

```bash
go run -tags tools ./scripts/tools/export_tfvars.go \
  --config configs/mesh-cluster.yaml \
  --out-dir terraform/environments/prod-multi-cloud
```

### Step 2: Initialize & Apply Terraform Infrastructure

```bash
cd terraform/environments/prod-multi-cloud

# Copy example variables
cp terraform.tfvars.example terraform.tfvars

# Initialize OpenTofu / Terraform
tofu init

# Review execution plan
tofu plan

# Deploy across all configured cloud providers
tofu apply -auto-approve
```

---

## 7. Kubernetes & Helm Deployment Guide

For high-availability production environments, deploy Sovereign Proxy to Kubernetes using the official Helm chart (`charts/sovereign-mesh`).

### Step 1: Inspect and Customize `values.yaml`

```bash
cd charts/sovereign-mesh
cat values.yaml
```

Key customizable parameters in `values.yaml`:
```yaml
global:
  domain: mesh.example.com
  clusterName: sovereign-prod-k8s
  imageRegistry: ghcr.io/your-github-username

controlPlane:
  replicas: 3
  podDisruptionBudget:
    minAvailable: 2
  resources:
    requests:
      cpu: 250m
      memory: 512Mi

relay:
  replicas: 3
  hostNetwork: true # Required for STUN UDP port 3478 binding
```

### Step 2: Install or Upgrade via Helm

```bash
# Create dedicated namespace
kubectl create namespace sovereign-mesh

# Deploy chart
helm upgrade --install sovereign-mesh ./charts/sovereign-mesh \
  --namespace sovereign-mesh \
  --set global.domain="mesh.example.com" \
  --set global.acmeEmail="admin@example.com"
```

### Step 3: Verify Deployment Health

```bash
kubectl get pods,svc,pdb -n sovereign-mesh -o wide
```

---

## 8. Testing, Health Checks & Diagnostics

### Running the Complete Test Suite

```bash
# 1. Run unit and race detection tests across all Go packages
make test

# 2. Run Go vet linter
make lint

# 3. Execute the 5-Tier E2E automated test runner
python3 tests/e2e/runner.py --tier all
```

### Automated Preflight & GitOps Readiness Check

Run the comprehensive preflight audit script to verify zero-plaintext secrets, valid JSON schemas, and clean formatting:

```bash
bash scripts/gitops/preflight_check.sh
```

### Diagnostic CLI Commands

```bash
# 1. Inspect Control Plane status and active bridges
./bin/sovereign-cli status --control-url http://127.0.0.1:8443

# 2. Query available exit bridges in a specific country (e.g. US, DE, JP)
./bin/sovereign-cli peers US --control-url http://127.0.0.1:8443

# 3. Synthesize a 3-Hop Onion Obfuscation Circuit
./bin/sovereign-cli circuit US --control-url http://127.0.0.1:8443

# 4. Measure STUN NAT reflection latency
./bin/sovereign-cli stun-ping 127.0.0.1:3478
```

---

## 9. Security Hardening & Zero-Trust Best Practices

1. **Zero-Plaintext Secret Storage**:
   - In production containers, mount sensitive tokens to `/var/run/secrets/sovereign/<KEY>`.
   - Ensure local `.env` files have strict POSIX permissions (`chmod 600 .env`).
2. **Decoy Domain Camouflage**:
   - Set `SOVEREIGN_DECOY_DOMAIN` to high-reputation domains (e.g. `aws.amazon.com`, `www.microsoft.com`).
   - Active probing requests that do not perform the Noise/VLESS handshake will receive genuine HTTP decoy responses or silent tarpits.
3. **Firewall Backend Enforcement**:
   - For Linux production hosts, configure `SOVEREIGN_FIREWALL_DRIVER=ipset` or `nftables` in `.env` to enable sub-millisecond kernel packet drops for adversarial scanners.
4. **User-Space Sandboxing**:
   - Client and exit bridges enforce gVisor netstack user-space isolation, preventing untrusted proxy traffic from interacting with local LAN devices (RFC 1918 suppression).

---

## 10. Troubleshooting & Frequently Asked Questions (FAQ)

### Q1: `bind: permission denied` on port 443 or 80
**Cause**: Linux non-root processes cannot bind to privileged ports (< 1024) by default.  
**Resolution**: Grant the binary `CAP_NET_BIND_SERVICE` capability or run via Docker with port mapping:
```bash
sudo setcap 'cap_net_bind_service=+ep' bin/sovereign-derp-relay
```

### Q2: STUN reflection fails or returns symmetric NAT warnings
**Cause**: UDP port `3478` is blocked by a host firewall (UFW/AWS Security Group) or behind a symmetric carrier NAT.  
**Resolution**:
- Allow UDP port 3478 inbound on your cloud firewall:
  ```bash
  sudo ufw allow 3478/udp
  ```
- In Kubernetes, ensure `hostNetwork: true` is enabled on the relay DaemonSet/StatefulSet.

### Q3: Control plane registration returns `invalid posture attestation`
**Cause**: Node attestation failed posture compliance checks (e.g. unencrypted disk, disabled firewall, or outdated client version).  
**Resolution**: Check node logs for `⚠️ WARNING: Node is QUARANTINED`. Ensure local OS firewall is active and client version matches `ClientVersion` in `cmd/sovereign-node/main.go`.

### Q4: How to rotate Noise Protocol keys safely?
**Resolution**:
1. Generate a new keypair using `sovereign-cli keygen`.
2. Update `NOISE_PRIVATE_KEY` in `.env` or Kubernetes secret.
3. Restart the node daemon (`systemctl restart sovereign-node` or `kubectl rollout restart deployment/sovereign-node`). Nodes automatically negotiate epoch transition without dropping in-flight TCP sessions.

---

*For security vulnerability disclosures or architecture queries, refer to the [Project Roadmap](BUSINESS_AND_ROADMAP.md) and repository issue tracker.*
