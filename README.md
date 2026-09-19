<div align="center">

# 🌐 NeroNet v4.0 (DarkNero Mesh)
### Sovereign Overlay Mesh, Camouflaged Relays & Residential Proxy Routing

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL%20v3-blue.svg)](LICENSE)
[![Go Report Card](https://goreportcard.com/badge/github.com/sovereign/proxy/v4)](https://goreportcard.com/report/github.com/sovereign/proxy/v4)
[![Build Status](https://img.shields.io/badge/build-passing-brightgreen.svg)]()
[![E2E Test Coverage](https://img.shields.io/badge/tests-330%20passing%20(100%25)-success.svg)]()
[![Security Audit](https://img.shields.io/badge/zero--trust-verified-purple.svg)]()
[![Kubernetes](https://img.shields.io/badge/k8s-helm%20ready-326ce5.svg)]()
[![Multi-Cloud](https://img.shields.io/badge/clouds-OCI%20|%20AWS%20|%20GCP%20|%20DO%20|%20Hetzner%20|%20Vultr-orange.svg)]()

**NeroNet v4.0 (DarkNero Mesh)** is an enterprise-grade, decentralized zero-trust overlay mesh, camouflaged packet relay fleet, and residential egress proxy system deployed on `DARKNERO.COM` (`neronet.darknero.com`).

[Key Features](#-key-features) • [Architecture Graphics](#-architecture-diagrams) • [5-Minute Quickstart](#-5-minute-quickstart) • [CLI Reference](#-operator-cli-reference) • [Multi-Cloud & K8s](#-multi-cloud--kubernetes-deployment) • [Auto-Scaling](#-dual-tier-auto-scaling) • [Documentation & Roadmap](#-documentation-index) • [Contributing](CONTRIBUTING.md)

</div>

---

## 🚀 Overview

NeroNet v4.0 provides impenetrable cryptographic network privacy, censorship evasion, line-rate packet relaying, and residential egress routing. It operates across heterogeneous cloud infrastructure (OCI Always-Free ARM64, AWS Graviton, GCP Tau, DigitalOcean, Hetzner, Vultr) and decentralized user-contributed edge devices.

```
+---------------------------------------------------------------------------------------------------+
|                              NERONET v4.0 SOVEREIGN MESH ECOSYSTEM                                |
+---------------------------------------------------------------------------------------------------+
|                                                                                                   |
|  [ Client Ingress ]        [ Camouflaged Relay Fleet ]        [ Decentralized Exit Bridges ]      |
|  * SOCKS5 (Port 1080)      * TLS 1.3 / WSS on Port 443        * Userspace gVisor Netstack         |
|  * HTTP CONNECT (8080)     * Line-Rate STUN (3478 UDP)        * Strict RFC 1918 Bogon Drops       |
|  * Noise IKpsk2 Handshake  * Active Decoy Web Engine (8080)   * Dynamic Country & Host Selection  |
|  * 3-Hop Onion Encaps      * eBPF / IPSet Threat Defense      * Battery & Data Cap Guardians      |
|                                                                                                   |
+---------------------------------------------------------------------------------------------------+
```

---

## ✨ Key Features

| Capability | Description |
|---|---|
| 🔐 **Noise Cryptographic Plane** | Zero-trust authentication via `Noise_IKpsk2_25519_ChaChaPoly_BLAKE2s` with ephemeral session rekeying and anti-replay protection. |
| ⚡ **SVRN Binary Wire Framing** | High-throughput 24-byte binary wire framing (`0x5356524E`) delivering line-rate direct UDP transport. |
| 🛡️ **Camouflaged DERP-v4 Relays** | Cloud-neutral WebSocket relays operating on HTTPS port 443 with TLS fingerprint mimicry and anti-probing decoy web servers. |
| 🎯 **Adaptive Disco-v4 NAT** | Multi-strategy NAT hole puncher combining STUN reflection, sequential port prediction, and 256-port birthday spraying. |
| 🌐 **Multi-Mode Routing Engine** | Granular routing supporting **ISO Country Selection** with composite health scoring, **Host ID Direct Anchoring**, and **3-Hop Layered Onion Obfuscation**. |
| 🔒 **Sandboxed Userspace Bridge** | gVisor userspace netstack isolation, strict RFC 1918/Bogon egress rejection, and anti-abuse port blocking (SMTP/NetBIOS/SMB). |
| 📈 **Dual-Tier Auto-Scaling** | Aggressive rapid-burst scaling for cloud relays (OCI Instance Pools, AWS ASGs, K8s HPA/KEDA) paired with bounded physical governance for local edge nodes. |
| ☁️ **Sovereign App Bundles** | 1-Click OIDC Single Sign-On and dynamic container provisioning for **Nextcloud**, **Immich AI Photo Vault**, and **Seafile**. |
| 🪤 **Active Defense Honeypot** | Real-time threat scoring engine with automated IP banning across `ipset`, `nftables`, and `ufw`. |

---

## 📊 Architecture Diagrams

### 1. P2P Mesh & Control Plane Architecture

```mermaid
flowchart TD
    subgraph CP["NeroNet Control Plane (Raft Consensus)"]
        CP_REG["Key & Node Registry<br/>(Noise IKpsk2 / Curve25519)"]
        CP_VIP["VIP Allocator<br/>(CGNAT 100.64.0.0/10)"]
        CP_GEO["GeoIP & Composite Scorer<br/>(BW, RTT, Loss, Reputation)"]
        CP_OIDC["OIDC Identity Provider<br/>(SSO & Ed25519 Entitlements)"]
    end

    subgraph RELAYS["Camouflaged Relay Fleet (Multi-Cloud OCI / AWS / GCP)"]
        DERP["DERP-v4 Relay Server<br/>(TLS 1.3 / WebSocket Port 443)"]
        STUN["Line-Rate STUN Reflection<br/>(UDP Port 3478)"]
        DECOY["Anti-Probing Decoy Engine<br/>(Active Web Fallback Port 8080)"]
    end

    subgraph CLIENT["NeroNet Client Node (Origin)"]
        INGRESS["Local Ingress Listeners<br/>(SOCKS5 :1080 / HTTP :8080)"]
        CRYPTO["Noise Cryptographic Engine<br/>(ChaCha20-Poly1305 / BLAKE2s)"]
        DISCO["Disco-v4 NAT Traversal<br/>(STUN / Prediction / Birthday Spray)"]
    end

    subgraph EXIT["Sandboxed Client Exit Bridge (Residential Node)"]
        NETSTACK["Userspace Netstack<br/>(gVisor-isolated TCP/IP)"]
        SANDBOX["Zero-Trust Egress Guard<br/>(RFC 1918 Bogon & Port Filters)"]
        GUARDIAN["Device Guardian<br/>(Battery & Data Cap Protection)"]
    end

    CLIENT -->|"1. Node Registration & Heartbeat"| CP
    EXIT -->|"1. Node Registration & Heartbeat"| CP
    CLIENT -.->|"2. STUN NAT Mapping Query"| STUN
    EXIT -.->|"2. STUN NAT Mapping Query"| STUN

    CLIENT == "Direct P2P SVRN UDP Tunnel (24-byte Header)" ==> EXIT
    CLIENT -.->|"Fallback Relay (Encrypted DERP-v4 Frames)"| DERP
    DERP -.->|"Forward to Peer VIP"| EXIT

    EXIT -->|"Sanitized Egress Traffic"| INTERNET["Target Web Destination<br/>(Public Internet / Web Services)"]

    style CP fill:#1e293b,stroke:#38bdf8,stroke-width:2px,color:#f8fafc
    style RELAYS fill:#1e293b,stroke:#a855f7,stroke-width:2px,color:#f8fafc
    style CLIENT fill:#1e293b,stroke:#22c55e,stroke-width:2px,color:#f8fafc
    style EXIT fill:#1e293b,stroke:#f59e0b,stroke-width:2px,color:#f8fafc
    style INTERNET fill:#0f172a,stroke:#64748b,stroke-width:2px,color:#f8fafc
```

---

### 2. Dual-Tier Auto-Scaling Architecture

```mermaid
flowchart TD
    subgraph TRAFFIC["Global Mesh Traffic & Telemetry Monitor"]
        MON["Prometheus / CloudWatch / Node Heartbeats"]
    end

    subgraph CLOUD["Cloud Tier: Aggressive Rapid-Burst Scale-Out"]
        direction TB
        OCI["OCI Instance Pools (Ampere A1 ARM64)<br/>* Scale-Out: CPU > 65% (adds +2 instances, 60s cooldown)<br/>* Scale-In: CPU < 30% sustained 300s (removes 1 instance)"]
        AWS["AWS Auto Scaling Groups (Graviton3 c7g.large)<br/>* Target Tracking: CPU @ 60%<br/>* Step Scaling: NetworkIn >= 100MB/s (+2 instances)<br/>* Graceful Drain: 120s Terminating Lifecycle Hook"]
        K8S["Kubernetes Fleet (HPA v2 & KEDA)<br/>* Relay HPA: 4-32 Replicas (0s scale-up delay, +100% in 15s)<br/>* KEDA: PromQL trigger on sockets >= 2,500/pod<br/>* Control Plane HPA: 3-10 Replicas with fixed Raft Quorum"]
    end

    subgraph LOCAL["Local Tier: Bounded Scale & Physical Safeguards"]
        direction TB
        SEMAPHORE["Concurrency Semaphores<br/>* Desktop/Server: Max 10 concurrent streams<br/>* Laptop: Max 5 streams | Mobile: Max 2 streams<br/>* Saturated: Fast ErrMaxConcurrency drop"]
        BOUNDS["Resource & Privilege Caps<br/>* CPU Quota: Max 25% host CPU<br/>* RAM Cap: 512MB Hard Limit<br/>* Security: Rootless UID 10001 & in-memory netstack"]
        GUARDIANS["Hardware Guardians<br/>* Battery Guardian: <20% Auto-Suspend, <15% Cutoff<br/>* ISP Quota: 90% usage triggers auto-drain, 100% disconnect"]
        DRAIN["Two-Stage Graceful Drain Protocol<br/>* Stage 1: Signal Control Plane (Score=0, Disabled)<br/>* Stage 2: 45s socket drain window for active TCP flows<br/>* Stage 3: VIP release & clean unenrollment"]
    end

    TRAFFIC ==>|"High Load Surge"| CLOUD
    TRAFFIC ==>|"Residential Route Demand"| LOCAL

    style TRAFFIC fill:#0f172a,stroke:#38bdf8,stroke-width:2px,color:#f8fafc
    style CLOUD fill:#1e293b,stroke:#ef4444,stroke-width:2px,color:#f8fafc
    style LOCAL fill:#1e293b,stroke:#10b981,stroke-width:2px,color:#f8fafc
```

---

### 3. Client Exit Routing & 3-Hop Onion Obfuscation Flow

```mermaid
sequenceDiagram
    autonumber
    actor User as Client App / Browser
    participant Origin as Client Node (:1080 SOCKS5)
    participant CP as Control Plane (Raft)
    participant Hop1 as Hop 1: Entry Relay
    participant Hop2 as Hop 2: Intermediate Relay
    participant Hop3 as Hop 3: Residential Exit Bridge
    participant Target as Destination Web Server

    User->>Origin: HTTP GET https://target-service.com/data
    Note over Origin,CP: Circuit Initialization & Key Agreement
    Origin->>CP: Request 3-Hop Circuit Path (Target: Country US)
    CP-->>Origin: Return Circuit [Hop1 (Entry), Hop2 (Mid), Hop3 (Exit)] + Public Keys

    Note over Origin: Layered Onion Encapsulation (ChaCha20-Poly1305)<br/>Layer 3 (Inner): Encrypted for Hop 3 (Exit)<br/>Layer 2 (Middle): Encrypted for Hop 2 (Mid)<br/>Layer 1 (Outer): Encrypted for Hop 1 (Entry)

    Origin->>Hop1: Send 3-Layer Onion Packet (Outer Header)
    Note over Hop1: Peel Layer 1 with Hop 1 Private Key<br/>Verify Poly1305 MAC & extract Hop 2 address
    Hop1->>Hop2: Forward 2-Layer Onion Packet

    Note over Hop2: Peel Layer 2 with Hop 2 Private Key<br/>Inject Jitter Delay (2-25ms) & extract Hop 3 address
    Hop2->>Hop3: Forward 1-Layer Onion Packet

    Note over Hop3: Peel Layer 3 with Hop 3 Private Key<br/>Validate Sandbox: Drop RFC 1918 Bogons & Blocked Ports<br/>Execute Userspace Netstack TCP Dial
    Hop3->>Target: Outbound TLS TCP Connection (Genuine Residential IP)
    Target-->>Hop3: HTTP 200 Response Payload

    Note over Hop3,Origin: Symmetric Layered Response Stream Return
    Hop3->>Hop2: Encrypt Response Layer 3
    Hop2->>Hop1: Encrypt Response Layer 2
    Hop1->>Origin: Encrypt Response Layer 1
    Note over Origin: Decrypt All 3 Layers
    Origin-->>User: Deliver Transparent SOCKS5 Stream
```

---

## ⚡ 5-Minute Quickstart

Get a complete local Sovereign Mesh cluster running in under 5 minutes with zero cloud dependencies.

### Step 1: Clone & Configure

```bash
git clone https://github.com/Mohamed-DN/neronet-proxy.git
cd neronet-proxy

# Writes .env with fresh random secrets. Refuses to overwrite an existing file
# and never prints the values. On Windows, run it from Git Bash.
sh scripts/dev/gen-env.sh
```

Under `NODE_ENV=production` the API refuses to start without these secrets, and
refuses any value that has ever appeared in a committed file here: a presence check
cannot tell a real secret from the example one, and the example used to ship with
working values. `gen-env.sh` writes hex values, which are safe inside the
`DATABASE_URL`. Every other setting has a default; `.env.example` lists them.

`SOVEREIGN_REGISTRATION_TOKEN` is what a Go node presents to enrol. Without it the
control plane accepts no nodes at all in production: `/v4/control/register` writes to
the node table and hands out overlay addresses.

### Step 2: Build Binaries

```bash
make build
```

Compiled binaries are located in `./bin/`:
- `bin/sovereign-control-plane`
- `bin/sovereign-derp-relay`
- `bin/sovereign-node`
- `bin/sovereign-cli`

### Step 3: Launch Local Daemons

```bash
# 1. Start Control Plane Coordinator
./bin/sovereign-control-plane --listen-addr 127.0.0.1:8443 &

# 2. Start Camouflaged Relay Node
./bin/sovereign-derp-relay --listen-addr 127.0.0.1:8444 --stun-addr 127.0.0.1:3478 --region local-dev &

# 3. Start Client Node Ingress
./bin/sovereign-node --socks-addr 127.0.0.1:1080 --http-addr 127.0.0.1:8080 --control-url http://127.0.0.1:8443 &
```

### Step 4: Verify Proxy Routing

```bash
# Route request through local SOCKS5 proxy
curl -x socks5h://127.0.0.1:1080 https://cloudflare.com/cdn-cgi/trace
```

---

## 🐳 Docker Compose Deployment

The development stack (PostgreSQL, Valkey, backend, console) and a simulated fleet of
six nodes and two DERP relays run from one compose file, driven by scripts that work
with Podman or Docker. On Windows, run them from Git Bash.

```bash
sh scripts/dev/gen-env.sh        # .env with fresh secrets; never overwrites
sh scripts/dev/stack.sh up       # console on http://127.0.0.1:8443
sh scripts/dev/stack.sh nodes    # 2 DERP relays + 6 Go nodes
sh scripts/dev/stack.sh status
```

Several stacks can run side by side; see `DEVELOPER_SETUP.md` sections 3 and 5.

---

## 💻 Operator CLI Reference

The `sovereign-cli` utility provides cluster administration, cryptographic key generation, circuit debugging, and NAT diagnostics:

| Command | Usage | Description |
|---|---|---|
| `status` | `sovereign-cli status` | Displays control plane status, active relays, and mesh VIP CIDR. |
| `peers` | `sovereign-cli peers [COUNTRY]` | Discovers active exit bridges filtered by ISO country code with composite scores. |
| `circuit` | `sovereign-cli circuit [COUNTRY]` | Builds and inspects a 3-Hop Layered Onion Circuit path. |
| `keygen` | `sovereign-cli keygen` | Generates a fresh Curve25519 identity keypair and Node ID. |
| `stun-ping` | `sovereign-cli stun-ping <host:port>` | Probes a STUN reflector endpoint and measures NAT mapping round-trip latency. |

---

## ☁️ Multi-Cloud & Kubernetes Deployment

### Terraform / OpenTofu Infrastructure as Code

Sovereign Mesh includes production modules for 6 major cloud providers under `terraform/modules/`:

```bash
cd terraform/environments/prod-multi-cloud
terraform init
terraform apply -var-file="terraform.tfvars"
```

- **Oracle Cloud (OCI)**: Always-Free Ampere A1 ARM64 (4 OCPUs, 24 GB RAM) with automated Instance Pool autoscaling.
- **Amazon Web Services (AWS)**: Graviton3 (`c7g.large`) with Auto Scaling Groups and Terminating Lifecycle Hooks.
- **Google Cloud Platform (GCP)**: Tau T2A Compute Engine instances.
- **DigitalOcean, Hetzner & Vultr**: Cost-effective cloud edge relays.

### Kubernetes Helm Chart

Deploy the high-availability mesh cluster to any standard Kubernetes distribution (EKS, OKE, GKE, K3s):

```bash
# Lint and validate chart
helm lint charts/sovereign-mesh/

# Deploy Sovereign Mesh
helm upgrade --install sovereign-mesh charts/sovereign-mesh/ \
  --namespace sovereign-mesh \
  --create-namespace \
  -f charts/sovereign-mesh/values.yaml
```

---

## 📈 Dual-Tier Auto-Scaling

| Dimension | Cloud Relay Fleet (OCI / AWS / K8s) | Local Residential Nodes |
|---|---|---|
| **Elasticity Strategy** | Aggressive Scale-Out & Rapid Burst | Bounded Scale & Physical Safeguards |
| **Trigger Metrics** | CPU $> 65\%$, NetworkIn $\ge 100\text{ MB/s}$, Sockets $\ge 2500$ | Concurrency Semaphores (Max 10 streams) |
| **Scale-Up Speed** | Instant (0s stabilization, +100% capacity in 15s) | Limited by hardware concurrency cap |
| **Scale-Down Policy** | 300s stabilization window, 120s socket drain | Two-Stage Graceful Drain (45s window) |
| **Physical Protections**| Multi-AZ distribution, instance redundancy | Battery Guardian ($<20\%$ suspend, $<15\%$ exit), 90% Data Cap auto-drain |

*(For full engineering specifications, see [`docs/AUTOSCALING.md`](docs/AUTOSCALING.md))*

---

## 📦 Sovereign Private Cloud & Add-on Bundles

NeroNet integrates 1-click sovereign private cloud applications with automated OIDC Single Sign-On and per-user container orchestration:

- 📁 **Nextcloud Suite**: File sync, Collabora Online document editing, calendar & contacts.
- 📸 **Immich AI Photo Vault**: Mobile auto-backup, vector facial recognition & object search.
- ⚡ **Seafile Enterprise**: High-throughput file sync with C-core block deduplication.

*(For SSO identity federation, per-tenant LUKS2 encryption, and scale-to-zero inactivity architecture, see [`BUSINESS_AND_ROADMAP.md`](BUSINESS_AND_ROADMAP.md))*

---

## 📚 Documentation Index

- 📖 **[Developer Onboarding & Setup Guide](DEVELOPER_SETUP.md)**: End-to-end local & multi-cloud deployment instructions.
- 📈 **[Auto-Scaling Architecture Specification](docs/AUTOSCALING.md)**: Cloud Instance Pools, ASGs, and Kubernetes HPA/KEDA.
- 💼 **[Business Plan & App Bundles Architecture](BUSINESS_AND_ROADMAP.md)**: Nextcloud, Immich, Seafile SSO & Monetization roadmap.
- 🔮 **[NeroNet v5.0 Next-Generation Roadmap](FUTURE_PLANS.md)**: Post-quantum ML-KEM-768, eBPF/XDP line-rate relays, and native mobile apps.
- ⚙️ **[Environment Configuration Template](.env.example)**: Comprehensive configuration matrix and reference guide.
- 🧪 **[Test Infrastructure & E2E Verification](TEST_INFRA.md)**: 5-Tier test methodology covering 330+ test cases.
- 📕 **[Engineering Handbook](docs/HANDBOOK.md)**: complete system state — architecture, what works, what does not, verified against a running deployment. **Start here.**
- 🗺️ **[Engineering Roadmap](docs/ROADMAP.md)**: measured load ceilings, the high-availability design, federation and revocation, competitor feature parity, post-quantum status, and the code rules.

---

## 🛡️ Security, Privacy & Audit

What is true today, verified against a running deployment rather than asserted:

- **No usable secret in any committed file.** Under `NODE_ENV=production` the API
  refuses to start on a missing secret, and refuses any value that has ever shipped
  in a committed file here. Both example env files and both compose files take every
  secret from the environment.
- **Unprivileged backend**: uid `10001:10001`, read-only root filesystem, all Linux
  capabilities dropped, `no-new-privileges`. Only `/app/data` is writable, because
  the SQLite file and the mesh's Ed25519 federation identity live there.
- **Rate limiting** on sign-in, registration and node enrolment, shared across
  instances through Valkey so N replicas do not multiply every limit by N.
- **Security headers**: CSP with `frame-ancestors 'none'`, HSTS in production,
  `nosniff`, a restrictive `Permissions-Policy`.
- **Tenant isolation** enforced by one middleware and probed by a test that
  enumerates every node-addressed route as the wrong tenant.
- **Hybrid post-quantum TLS** (`X25519MLKEM768`) on the control plane, with two tests
  that fail if a future change silently turns it off.
- **Federation** requires a real Ed25519 signature *and* a fingerprint the operator
  confirmed out of band.

Known gaps, stated rather than omitted:

- The tunnel and per-hop onion key exchange are still classical X25519. Post-quantum
  there is planned via Rosenpass.
- `pkg/crypto` and `pkg/routing` have had no external audit. A nonce-reuse defect was
  found and fixed in the onion layer on 2026-09-12; treat the rest accordingly.
- Cloud PC is interface without implementation and is switched off by default
  (`SOVEREIGN_FEATURE_CLOUD_PC`). NeroDrop and App Bundles were removed. See
  [the roadmap](docs/ROADMAP.md) § 3.
- Honeypot and zero-trust egress filtering exist as Go code but have not been
  exercised against a real deployment.

---

## ⚖️ License & Governance

NeroNet v4.0 is released under the open-source **AGPL-3.0 License**. Maintained by the NeroNet Admin Group.
