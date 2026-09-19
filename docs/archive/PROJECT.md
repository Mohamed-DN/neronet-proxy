> Historical document, not maintained. It is the console feature inventory of an earlier development phase and does not describe the current code. For the current state read [the handbook](../HANDBOOK.md).

# Project: NeroNet Enterprise Management Console

## Architecture
- **Control Plane Web UI**: React 18/19, Vite 5, Tailwind CSS 3.4+, Lucide React, Recharts, Three.js / Canvas 3D Force-Graph for Spiderweb Topology, WebRTC DataChannel for P2P NeroDrop. Dark enterprise theme (`#09090b` canvas, `#111318` card containers, neon accents).
- **Control Plane Backend API**: Go or Node.js REST API with embedded SQLite database (`console/data/neronet.db`) utilizing WAL mode. Exposes 33+ endpoints covering Auth (Super-Admin vs User Portal RBAC), Users (Hybrid BYOS vs Managed Cloud tiers), Nodes, App Bundles (Guacamole, Nextcloud, Immich, Seafile), Crypto/Config generation (WireGuard .conf, Noise JSON, QR codes), and Telemetry/Audit Logs.
- **Local Staging Deployment**: Zero-conflict loopback binding (`127.0.0.1:8081` for Console UI, `127.0.0.1:8082` for API) with automated `console/start.sh` and `docker-compose.yml`. Standard bridge networking with zero manipulation of kernel routing tables or Tailscale `utunX` interfaces.
- **GitOps Engine**: Automated GitOps staging engine that validates all tests, stages a clean commit tree, and pushes to `Mohamed-DN/sovereign-oci-proxy` on branch `main`.

---

## Feature Inventory

| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| 1 | Health Check API | `/api/health` returning system liveness, version, and database connectivity. | M1 | Survey 1 (Backend Spec) |
| 2 | Auth & RBAC Engine | Super-Admin vs User Portal login, JWT token issuance, refresh tokens, Bcrypt password hashing. | M1 | Survey 1 (Backend Spec) |
| 3 | User Management API | CRUD endpoints for users, Hybrid BYOS ($0) vs Managed Cloud tier assignment, quotas. | M1 | Survey 1 (Backend Spec) |
| 4 | Node Matrix API | Registration, heartbeat ingestion, posture status, latency reporting, node revocation. | M1 | Survey 1 (Backend Spec) |
| 5 | Crypto & Config Generation API | Curve25519 clamped key generation, WireGuard `.conf`, Noise JSON profile, Base64 QR code generation. | M1 | Survey 1 (Backend Spec) |
| 6 | App Bundles API | CRUD & lifecycle (start/stop/scale-to-zero/launch) for Guacamole Cloud PC, Nextcloud, Immich, Seafile. | M1 | Survey 1 (Backend Spec) |
| 7 | Metrics & Audit Log API | System metrics aggregation, bandwidth timeseries, security audit event logging and retrieval. | M1 | Survey 1 (Backend Spec) |
| 8 | Enterprise Dark Theme & Design System | Dark zinc/slate UI with neon accents, DM Sans typography, JetBrains Mono for keys/VIPs. | M2 | Survey 2 (Frontend Spec) |
| 9 | Global Overview Dashboard | Animated KPI metric cards (nodes, users, bandwidth), live Recharts throughput graph, country matrix. | M2 | Survey 2 (Frontend Spec) |
| 10 | Interactive 3D Spiderweb Topology | 3D force-directed mesh visualizer; Super-Admin sees global mesh; Users see personal isolated mesh. | M2 | Parent Instruction & Survey 2 |
| 11 | Node Management Actions & Sheet | Contextual action drawer on node click: "Ping Device" (live RTT), "Set as Exit Node", "Quarantine/Isolate". | M2 | Parent Instruction & Survey 2 |
| 12 | P2P NeroDrop File Transfer Hub | Direct peer-to-peer encrypted file transfer UI with 64KB chunking, throughput meter, BLAKE3 checksum. | M2 | Parent Instruction & Survey 2 |
| 13 | User Management Portal | Dual-tier user directory table, quota allocation gauges, user provisioning modal, session revocation. | M2 | Survey 2 (Frontend Spec) |
| 14 | Node Matrix & Device Enrollment | Comprehensive node inventory grid, posture compliance badges, status pills, filter/search. | M2 | Survey 2 (Frontend Spec) |
| 15 | Crypto Profile & QR Code Modal | Visual modal with syntax-highlighted WireGuard/Noise profiles, one-click download/copy, and QR code canvas. | M2 | Survey 2 (Frontend Spec) |
| 16 | App Bundles Hub | Interactive cards for Guacamole RDP, Nextcloud, Immich, and Seafile with provisioning modal & launch SSO. | M2 | Survey 2 (Frontend Spec) |
| 17 | Settings & Zero-Trust ACL Manager | Visual editor for Zero-Trust ACL rules, Subnet route failover config, device posture policies. | M2 | Survey 2 (Frontend Spec) |
| 18 | Real-Time Security Audit Table | Filterable audit table with slide-over JSON payload inspector and CSV/JSON export. | M2 | Survey 2 (Frontend Spec) |
| 19 | Safe Local Staging Scripts | 1-Click native `console/start.sh` and `console/stop.sh` binding to ports 8081/8082 without Tailscale disruption. | M3 | Survey 3 (Infra Spec) |
| 20 | Containerized Compose Stack | Multi-stage `console/Dockerfile` and `docker-compose.yml` for isolated container execution. | M3 | Survey 3 (Infra Spec) |
| 21 | E2E Integration Test Suite | Automated test runner validating API health, auth flows, node crypto configs, UI builds, and routes. | M4 | E2E Testing Track |
| 22 | Adversarial Hardening Verification | White-box stress tests for token forgery, VIP collision, posture quarantine bypass, and malformed inputs. | M4 | E2E Testing Track |
| 23 | Clean GitOps Push Engine | Sanitized staging synchronization and push to `Mohamed-DN/sovereign-oci-proxy` on `main`. | M5 | Survey 3 (Infra Spec) |

---

## Milestones

| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M1 | Control Plane Backend API & Database | API router, SQLite DDL/queries, Auth/RBAC (Super-Admin vs User), User/Node/App CRUD, Crypto Generators (WireGuard, Noise, QR Code), Telemetry & Audit APIs. | none | PLANNED |
| M2 | Enterprise Frontend Web UI | React + Vite + Tailwind UI, 3D Spiderweb Topology (scoped by role), Node Action Drawer (Ping/Exit/Quarantine), P2P NeroDrop Hub, App Bundles Hub, User Portal, Crypto Modal. | M1 | PLANNED |
| M3 | Local Staging & Containerization | `console/start.sh`, `console/stop.sh`, `console/Dockerfile`, `docker-compose.yml`, local staging on ports 8081/8082 with loopback isolation. | M1, M2 | PLANNED |
| M4 | E2E Test Suite & Adversarial Hardening | 5-Tier E2E test verification, full test suite pass (Tiers 1-4), adversarial test hardening (Tier 5), UI/API integration validation. | M1, M2, M3 | PLANNED |
| M5 | Clean GitOps Push & Final Verification | Automated staging directory synchronization, clean force-push to `Mohamed-DN/sovereign-oci-proxy` on `main`, release audit handover. | M4 | PLANNED |

---

## Code Layout

```
console/
├── Dockerfile                  # Container multi-stage build definition
├── docker-compose.yml          # Containerized staging deployment (ports 8081:8081)
├── package.json                # Root / full-stack scripts & dependencies
├── start.sh                    # 1-Click native local staging runner (ports 8081/8082)
├── stop.sh                     # Graceful shutdown script for local staging
├── data/                       # Embedded SQLite persistence (neronet.db)
├── backend/                    # Control Plane REST API Backend (Go or Node.js)
│   ├── server.js / main.go     # API Server entry point (/api/health, /api/*)
│   ├── db.js / db.go           # SQLite database connection & schema migrations
│   ├── auth.js / auth.go       # JWT auth & RBAC middleware
│   ├── crypto.js / crypto.go   # Curve25519, WireGuard .conf, Noise JSON, QR generator
│   └── routes/                 # Route handlers: auth, users, nodes, apps, configs, stats
└── frontend/                   # Enterprise React Frontend Web UI
    ├── index.html              # Single page application root
    ├── package.json            # Vite + React + Tailwind + Lucide + Three.js dependencies
    ├── vite.config.js          # Vite build config with proxy to backend /api
    ├── tailwind.config.js      # Enterprise dark theme design tokens & colors
    └── src/
        ├── App.jsx             # Main application layout, sidebar, header, routing
        ├── main.jsx            # React root mount
        ├── index.css           # Global dark theme styles & custom scrollbars
        ├── components/
            ├── Overview.jsx        # KPI metric cards, bandwidth chart, country distribution
            ├── Topology3D.jsx      # Interactive 3D spiderweb graph (Super-Admin vs User scoped)
            ├── NodeMatrix.jsx      # Sovereign node inventory grid & posture compliance HUD
            ├── NodeActions.jsx     # Action drawer (Live Ping, Set as Exit Node, Quarantine)
            ├── NeroDrop.jsx        # P2P encrypted direct file transfer hub
            ├── UserManagement.jsx  # Dual-tier user table (Hybrid BYOS vs Managed Cloud)
            ├── AppBundles.jsx      # Guacamole Cloud PC, Nextcloud, Immich, Seafile cards
            ├── CryptoConfigModal.jsx # WireGuard .conf, Noise JSON & QR Code generator modal
            ├── SettingsACL.jsx     # Zero-Trust ACL rule builder & Subnet route manager
            └── AuditLogs.jsx       # Forensic security event logs & JSON viewer
```

---

## Interface Contracts

### 1. Authentication (`POST /api/auth/login`)
- Request: `{ "username": "admin", "password": "..." }`
- Response: `{ "token": "JWT...", "user": { "id": "...", "username": "admin", "role": "super-admin"|"user", "tier": "cloud_managed"|"hybrid_byos"|"free_core" } }`

### 2. Crypto Config Generator (`POST /api/configs/generate`)
- Request: `{ "name": "Node-Name", "role": "CLIENT_ORIGIN"|"EXIT_BRIDGE"|"HYBRID", "country_code": "US" }`
- Response:
  ```json
  {
    "node_id": "svrn-node-xxxx",
    "private_key": "...",
    "public_key": "...",
    "overlay_ipv4": "100.64.0.x",
    "overlay_ipv6": "fd7a:115c:a1e0::x",
    "wireguard_conf": "[Interface]\nPrivateKey = ...\nAddress = 100.64.0.x/32\n...",
    "json_profile": { "version": "4.0", "identity": { ... }, "crypto": { ... } },
    "qrcode_data_url": "data:image/png;base64,..."
  }
  ```

### 3. Node Quick Actions (`POST /api/nodes/:id/action`)
- Request: `{ "action": "ping"|"set_exit"|"quarantine", "params": { ... } }`
- Response: `{ "success": true, "result": { "rtt_ms": 14.2, "jitter_ms": 1.1, "status": "active" } }`

### 4. P2P NeroDrop Session (`POST /api/nerodrop/session`)
- Request: `{ "target_node_id": "...", "file_name": "backup.tar.gz", "file_size_bytes": 1048576, "blake3_hash": "..." }`
- Response: `{ "session_id": "drop-xxxx", "webrtc_signal": { ... }, "status": "ready" }`

### 5. App Bundles Management (`POST /api/apps` & `GET /api/apps/:id/launch`)
- Request (Create): `{ "name": "Cloud PC", "type": "guacamole"|"nextcloud"|"immich"|"seafile", "tier": "managed_cloud"|"self_hosted_byos", "memory_mb": 4096, "storage_gb": 100 }`
- Response (Launch): `{ "launch_url": "https://guac.internal.darknero.com/#/client/...", "sso_token": "..." }`
