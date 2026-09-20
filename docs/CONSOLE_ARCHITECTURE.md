# NeroNet Enterprise Management Console — Complete Technical Architecture & System Specification

> Design document from an earlier phase. It has not been checked against the code. Where it differs from [the handbook](HANDBOOK.md), the handbook is right. It was written for a console that supported two database dialects and features that have since been removed.

**Document Version:** 4.0.0 (v5.0 Enterprise Ready)  
**System Name:** NeroNet Enterprise Management Console  
**Repository:** `console/`  
**Classification:** Enterprise System Architecture & Engineering Blueprint  

---

## 1. System Overview & Component Topology

The **NeroNet Enterprise Management Console** is the centralized mission-control platform for the NeroNet sovereign mesh network. It provides network administrators and tenant users with real-time 3D topology visualization, zero-trust device posture validation, continuous behavioral risk scoring, cross-mesh peering orchestration, Sovereign Cloud PC WebRTC streaming management, and the multi-tier NeroNuke cryptographic dead man's switch.

```
+---------------------------------------------------------------------------------------------------------------+
|                                          ENTERPRISE WEB CONSOLE (SPA)                                         |
|                                (React 18 + Vite + Tailwind CSS Dark Slate-900)                                |
|                                                                                                               |
|  [Collapsible Linear-style Sidebar]               [Top Navigation HUD: Real-time KPIs & Role Switcher]        |
|  ├── ☢ Pinned "DESTROY NOW" Button                ├── 3D Network Topology (react-force-graph-3d)              |
|  ├── Global Overview Dashboard                    ├── Node Action Slide-Over Drawer                           |
|  ├── Mesh & Node Matrix                           ├── Sovereign Cloud PC WebRTC Streaming                     |
|  ├── Cross-Mesh Peering Center                    ├── NeroDrop P2P Signaling Hub                              |
|  ├── Behavioral Risk Scoreboard                   ├── Geo-Fencing 2D PostGIS Policy Editor                    |
|  └── Danger Zone: NeroNuke 3-Tier DMS             └── User & Access Control (RBAC, Split Tunneling)           |
+---------------------------------------------------------------------------------------------------------------+
                                                        │
                                            HTTPS / WSS Reverse Proxy
                                                        │
+---------------------------------------------------------------------------------------------------------------+
|                                      CONTROL PLANE API BACKEND (Node.js 22)                                   |
|                                                                                                               |
|  +---------------------------------------------------------------------------------------------------------+  |
|  | Core Controllers & REST API Endpoints                                                                   |  |
|  | - Auth & Session (/api/auth): Strict DB-only bcrypt, constant-time dummy verify, Valkey blacklist      |  |
|  | - Users & Quotas (/api/users): Tenant isolation, BYOS vs Cloud tiers, bypass_apps split tunneling       |  |
|  | - Node Matrix (/api/nodes): CRUD, VIP allocator (100.64.0.0/10), Kill Switch, Onion 3-Hop, Quarantine  |  |
|  | - Configs & QR (/api/configs): WireGuard/Noise profiles, Curve25519 clamping, QR onboarding codes       |  |
|  | - Peering Engine (/api/peering): Ed25519 token generation/verification, subnet scoping, purple mesh    |  |
|  | - Risk Engine (/api/risk): Telemetry ingestion, RTT anomaly, >1000km/h velocity flag (+50 risk)        |  |
|  | - Geo-Fencing Engine (/api/geofencing): PostGIS country allow/block/quarantine rules, default-allow     |  |
|  | - Sovereign Cloud PC (/api/cloud-pc): Selkies-GStreamer WebRTC signaling tokens, STUN/TURN, SSO/OTP    |  |
|  | - NeroNuke 3-Tier Engine (/api/nuke): Tiers 1, 1b, 2, 3 cryptographic self-destruction & warrant canary |  |
|  | - Health Probe (/api/health): PostgreSQL & Valkey cluster health monitoring                            |  |
|  +---------------------------------------------------------------------------------------------------------+  |
|                                                        │                                                      |
|  +-----------------------------------------------------v---------------------------------------------------+  |
|  | Real-Time WebSocket Topology Hub (/ws/topology) & Valkey Pub/Sub State Bus                              |  |
|  +---------------------------------------------------------------------------------------------------------+  |
+---------------------------------------------------------------------------------------------------------------+
                                       │                                │
                         SQL / PostGIS / JSONB / Vector           Pub/Sub / Token Blacklist / Sessions
                                       ▼                                ▼
+-------------------------------------------------------+ +-----------------------------------------------------+
|            PostgreSQL 16 Database                     | |                  Valkey 7 Bus                       |
|  - PostGIS Spatial Extension (Point, 4326)            | |  - Pub/Sub Channel: neronet:topology:events         |
|  - pgvector AI Anomaly Extension (1536)               | |  - Token Revocation Blacklist (O(1) TTL Key-Value)  |
|  - JSONB Metadata, Posture Checks, bypass_apps        | |  - Live Rate Limiting & Active Replica Sync         |
+-------------------------------------------------------+ +-----------------------------------------------------+
```

---

## 2. Enterprise UI Design System & Styling Architecture

The frontend follows a modern, dark cybersecurity aesthetic inspired by Linear, Vercel, and Supabase dashboards:

- **Theme Palette:**
  - Background Canvas: Slate-900 (`#0f172a`)
  - Elevated Cards & Panels: Slate-800 (`#1e293b`) with border Slate-700/50 (`#334155`)
  - Primary Accent & Focus: Sky-400 (`#38bdf8`) / Cyan-500 (`#06b6d4`)
  - Alerts & Peered Mesh: Violet-500 (`#8b5cf6`) / Purple-400 (`#c084fc`)
  - Critical / Danger: Rose-500 (`#f43f5e`) / Red-500 (`#ef4444`)
  - Success / Compliant: Emerald-400 (`#34d399`)
- **Typography:** Inter and Geist sans-serif fonts with monospace accents for VIPs, Public Keys, and Ed25519 signatures.
- **Collapsible Navigation Sidebar:**
  - Collapsible section groups: *Overview, Mesh & Network, Compute & Storage, Security & Policy, Danger Zone*.
  - User profile badge with tenant tier indicator (`Cloud Managed` vs `Hybrid BYOS`).
  - Persistent pinned **☢ DESTROY NOW** button when Instant or Scheduled account deletion is active.

---

## 3. Core Engine Technical Specifications

### 3.1 Interactive 3D Mesh Topology (`react-force-graph-3d`)
- **Physics Engine:** Three.js d3-force-3d simulation. Nodes represent mesh endpoints; links represent active WireGuard/Noise tunnels.
- **Visual Encoding:**
  - Standard Client Nodes: Sky-400 (`#38bdf8`)
  - Exit Bridges / Relays: Amber-400 (`#fbbf24`)
  - Cross-Mesh Peered Nodes: Violet-500 (`#8b5cf6`)
  - Quarantined / High-Risk Nodes ($>75$): Red-500 (`#ef4444`) with animated pulsing halo.
- **Camera Interactions:** Hovering a node causes it to float toward the camera lens; clicking opens the **Node Action Drawer** for immediate diagnostics, onion routing toggling, or isolation.

### 3.2 NeroNuke 3-Tier Self-Destruct & Dead Man's Switch System

The NeroNuke system provides irreversible data sanitization for high-risk operators, journalists, and privacy-sensitive enterprises.

```
+───────────────────────────────────────────────────────────────────────────────────────────────────────────────+
|                                    NERONUKE 3-TIER SELF-DESTRUCT ARCHITECTURE                                 |
+───────────────────────────────────────────────────────────────────────────────────────────────────────────────+
|                                                                                                               |
|  [ Tier 1: User Visible Kill ]         [ Tier 1b: Invisible Personal DMS ]     [ Tier 2: Owner Global DMS ]   |
|  - Explicit "DELETE MY ACCOUNT"        - Silent background timer               - Super-Admin network timer    |
|  - Instant or Scheduled countdown      - Zero visual UI footprint              - Cascading PG/Valkey purge    |
|  - Pinned sidebar red button           - Steganographic unlock panel           - Single webhook canary ping   |
|  - Hard SQL delete, no tombstone       - Silent user-only wipe on expiry       - Permanent irreversible wipe  |
|                                                                                                               |
|                                        [ Tier 3: Warrant Canary ]                                             |
|                                        - Ed25519-signed declaration at /.well-known/canary.txt                |
|                                        - Automatic freeze / stop-updating when DMS triggers                   |
+───────────────────────────────────────────────────────────────────────────────────────────────────────────────+
```

#### Tier 1: User Account Self-Destruct (Visible Mode)
- **Instant Kill:** User accepts a legal disclaimer and types `"DELETE MY ACCOUNT"`. Triggers immediate cryptographic wipe and hard delete of all user records, nodes, VPN keys, and files from PostgreSQL.
- **Scheduled Kill & Persistent Red Button:** User selects a future timestamp. A permanent red **☢ DESTROY NOW** button with live countdown and pulsing red border is pinned to the sidebar across every view until cancelled from the settings panel.

#### Tier 1b: Per-User Personal Dead Man's Switch (Invisible Mode)
- **Zero Visual Presence:** When only the Personal DMS is active, the UI displays zero badges, alerts, or status indicators.
- **Steganographic Access Methods:** To open the secret DMS management panel, the user must authenticate using one of five methods:
  1. *Reverse Password:* Enter normal password backwards.
  2. *Split Reverse:* Enter first half of password reversed + second half forward.
  3. *Shadow Password:* A separate dedicated password known only to the user.
  4. *Hardware Key:* Tap a registered FIDO2 / YubiKey.
  5. *Mobile OTP:* Submit a 6-digit TOTP code.
- **Silent Trigger:** If the user fails to submit their heartbeat before the deadline, only their personal nodes, keys, and account records are silently wiped without alerting administrators.

#### Tier 2: Network Owner Dead Man's Switch (Global Disaster Wipe)
- Super-Admin sets a passphrase hash and heartbeat interval (from 1 minute to 10 years).
- The deadline is tracked server-side in PostgreSQL.
- **Zero Warnings:** The system never sends reminders or countdown alerts.
- **Trigger Action:** When expired, the system initiates a cascading wipe of all PostgreSQL tables, flushes Valkey cache (`FLUSHALL`), sends an optional canary alert webhook, and permanently halts.

#### Tier 3: Warrant Canary
- At each successful owner heartbeat, the system publishes a cryptographically signed declaration at `/.well-known/canary.txt` signed with the owner's Ed25519 private key.
- If the DMS triggers, canary updates cease immediately, signalling network compromise to external auditors.

### 3.3 Sovereign Cloud PC WebRTC Native Control Plane (Selkies-GStreamer)
- **Architecture:** Replaces legacy Apache Guacamole with **Selkies-GStreamer** GPU-accelerated WebRTC streaming.
- **Signaling Token Generation (`POST /api/cloud-pc/:id/project`):** Issues time-limited WebRTC signaling tokens and STUN/TURN ICE server credentials (`coturn`).
- **Custom Domains & SSO Gateway:** Maps custom domain hostnames (e.g., `desktop.company.com`) to Cloud PC instances via the `custom_domains` PostgreSQL table, requiring SSO/OTP verification before releasing the WebRTC stream.

### 3.4 Cross-Mesh Peering Engine
- **Ed25519 Token Exchange:** Enables two independent NeroNet meshes to establish bidirectional or unidirectional trust without central broker dependencies.
- **Scoped Sharing:** Admins choose to share *ALL* nodes or restrict sharing to *SPECIFIC_DEVICES* or *SPECIFIC_SUBNETS*.
- **Visual Separation:** Imported peered nodes render in purple (`#8b5cf6`) in the 3D topology.

### 3.5 Continuous Behavioral Risk & Impossible Travel Engine
- **Ingestion & Metric Evaluation:** Evaluates node telemetry (RTT jitter, CPU/memory, geographic location).
- **Impossible Travel Velocity:**
  $$\text{Velocity (km/h)} = \frac{\text{Distance}(\text{Coord}_1, \text{Coord}_2)}{\Delta t}$$
  If velocity exceeds **1000 km/h** between consecutive heartbeats, the engine sets `is_impossible_travel = true` and adds $+50$ to the node's risk score.
- **Automated Quarantine:** If a node's total risk score exceeds **75**, it is automatically quarantined, re-assigned to the isolated subnet `100.64.250.0/24`, and an alert is broadcast via Valkey Pub/Sub.

### 3.6 Geo-Fencing Policy Engine (PostGIS)
- Evaluates client IP location against country-level rules stored in PostgreSQL (`geofencing_policies`).
- Supports actions: `ALLOW`, `BLOCK`, `QUARANTINE`.
- **Censorship Evasion Invariant:** Jurisdictions with active censorship (RU, EG, CN, IN) are unconditionally allowed by default.

---

## 4. API Catalog & WebSocket Specification

### 4.1 REST API Endpoint Catalog

| Method | Endpoint | Auth Level | Description |
|---|---|---|---|
| `GET` | `/api/health` | Public | System health check (Postgres, Valkey, Uptime) |
| `POST` | `/api/auth/login` | Public | Authenticates user via strict bcrypt; returns JWT |
| `POST` | `/api/auth/logout` | Authenticated | Blacklists JWT token in Valkey 7 |
| `GET` | `/api/users` | Admin | Lists all tenant users and quotas |
| `POST` | `/api/users` | Admin | Creates new tenant user with split tunneling config |
| `GET` | `/api/nodes` | Authenticated | Lists mesh nodes (Super-Admin: Global, User: Tenant-only) |
| `POST` | `/api/nodes/:id/quarantine` | Authenticated | Quarantines node to `100.64.250.0/24` |
| `POST` | `/api/nodes/:id/ping` | Authenticated | Sends ICMP/Noise latency probe |
| `GET` | `/api/configs/qr-code` | Authenticated | Generates mobile onboarding QR code payload |
| `POST` | `/api/peering/initiate` | Admin | Generates Ed25519-signed peering token |
| `POST` | `/api/peering/accept` | Admin | Verifies peer token and establishes agreement |
| `POST` | `/api/cloud-pc/:id/project` | Authenticated | Generates WebRTC signaling credentials |
| `POST` | `/api/nuke/user/self-destruct` | Authenticated | Tier 1 Instant User Account Deletion |
| `POST` | `/api/nuke/personal-dms/setup` | Authenticated | Tier 1b Silent Personal DMS Setup |
| `POST` | `/api/nuke/owner-dms/heartbeat` | Super-Admin | Tier 2 Owner DMS Passphrase Heartbeat Confirmation |
| `GET` | `/.well-known/canary.txt` | Public | Tier 3 Ed25519-signed Warrant Canary Declaration |

### 4.2 WebSocket Protocol (`/ws/topology`)
- **Connection URL:** `ws://127.0.0.1:8081/ws/topology?token=<JWT_TOKEN>`
- **Handshake Response:**
  ```json
  {
    "type": "HANDSHAKE_ACK",
    "userId": "usr-admin",
    "role": "super-admin",
    "serverTime": "2026-09-01T04:30:00.000Z"
  }
  ```
- **Real-Time Topology Event Stream:**
  ```json
  {
    "event": "NODE_UPDATED",
    "node": {
      "id": "svrn-node-01",
      "riskScore": 15,
      "isHealthy": true,
      "latencyMs": 18.2
    }
  }
  ```

---

## 5. Security & Zero-Trust Governance

1. **DB-Only Authentication:** Eliminates all hardcoded backdoor fallbacks; uses constant-time bcrypt comparisons to prevent timing-based username enumeration.
2. **Curve25519 Clamping:** All generated WireGuard and Noise cryptographic keys enforce RFC 7748 bit clamping on private keys (byte 0 clear lowest 3 bits, byte 31 clear bit 7, set bit 6).
3. **macOS Host Safety:** Docker staging binds strictly to `127.0.0.1`, guaranteeing zero route alterations and zero Tailscale interference.
