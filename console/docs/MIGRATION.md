> Historical document, not maintained. It is a database migration guide of an earlier phase and does not describe the current code. For the current state read [the handbook](../../docs/HANDBOOK.md).

# NeroNet Sovereign Mesh Enterprise Console — Database & State Architecture Migration Guide

**Document Version:** 4.0.0  
**Target Platform:** PostgreSQL 16 + Valkey 7 (Redis-compatible)  
**Applies to:** NeroNet Control Plane Backend & Enterprise Management Console  

---

## 1. Executive Summary & Rationale

The NeroNet Enterprise Management Console v4.0/v5.0 provides high-throughput mesh control plane orchestration, real-time 3D topology distribution, zero-trust device posture validation, and cross-mesh peering.

The initial developer preview relied on embedded synchronous SQLite (`better-sqlite3`). While suitable for single-node local prototypes, SQLite exhibits fundamental architectural constraints in enterprise production environments:
1. **Single-Writer Lock Serializations:** SQLite locks the entire database file on write, creating throughput bottlenecks during high-frequency telemetry ingestion and simultaneous client heartbeats.
2. **Lack of Native Spatial Indices:** Geolocation queries (e.g. impossible travel velocity, geo-fencing policy evaluation) required application-level distance computations rather than hardware-accelerated R-Tree / GiST spatial indexing.
3. **No Vector Embedding Support:** Future AI anomaly detection requires native high-dimensional vector search (`vector(1536)`).
4. **Single-Node Inability to Cluster:** Multi-replica API deployments require shared state synchronization and real-time event distribution across instances.

To address these challenges, the platform has migrated to **PostgreSQL 16** as the core relational data store and **Valkey 7** as the high-throughput caching, token revocation, and active-active Pub/Sub state bus.

---

## 2. Architectural Comparison: SQLite vs. PostgreSQL 16 + Valkey 7

| Dimension | Legacy Prototype (SQLite) | Production Architecture (PostgreSQL 16 + Valkey 7) |
|---|---|---|
| **I/O Engine** | Synchronous, blocking disk I/O | Non-blocking async connection pool (`pg.Pool`, 20 max connections) |
| **Concurrency** | Single-writer file lock (WAL mode) | Multi-Version Concurrency Control (MVCC) with row-level locking |
| **Spatial / Geolocation** | Plain text `country_code`, `city` | **PostGIS 3.4+** (`GEOMETRY(Point, 4326)`, GiST indexing, `ST_DistanceSphere`) |
| **AI Vector Search** | None | **pgvector** (`vector(1536)` reserved for anomaly embeddings) |
| **Dynamic Telemetry** | Serialized text strings (`JSON.stringify`) | Native **JSONB** with GIN indexing for rapid attribute querying |
| **Active Token Revocation** | Disk lookups in `refresh_tokens` | O(1) in-memory key-value lookup in **Valkey 7** with automatic TTL |
| **HA Event Distribution** | Single-instance in-memory emitter | **Valkey Pub/Sub** (`neronet:topology:events`) across all API replicas |

---

## 3. PostgreSQL 16 Schema Specification

### 3.1 Extensions Enabled
```sql
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "postgis";
CREATE EXTENSION IF NOT EXISTS "vector";
```

### 3.2 Core Table Specifications

#### Users Table (`users`)
Stores tenant accounts, role-based access control, quotas, and split-tunneling configurations:
```sql
CREATE TABLE IF NOT EXISTS users (
    id VARCHAR(64) PRIMARY KEY,
    username VARCHAR(64) UNIQUE NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role VARCHAR(32) NOT NULL DEFAULT 'user' CHECK (role IN ('super-admin', 'user')),
    tier VARCHAR(32) NOT NULL DEFAULT 'free_core' CHECK (tier IN ('cloud_managed', 'managed_cloud', 'hybrid_byos', 'free_core')),
    status VARCHAR(32) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'revoked')),
    bandwidth_quota_gb INTEGER NOT NULL DEFAULT 100,
    bandwidth_used_bytes BIGINT NOT NULL DEFAULT 0,
    max_nodes INTEGER NOT NULL DEFAULT 5,
    bypass_apps JSONB NOT NULL DEFAULT '[]'::jsonb,
    scheduled_deletion_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

#### Nodes Table (`nodes`)
Stores WireGuard/Noise device identities, PostGIS locations, VIP allocations, and telemetry:
```sql
CREATE TABLE IF NOT EXISTS nodes (
    id VARCHAR(64) PRIMARY KEY,
    user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(128) NOT NULL,
    public_key VARCHAR(128) NOT NULL UNIQUE,
    preshared_key VARCHAR(128),
    overlay_ipv4 VARCHAR(45) NOT NULL UNIQUE,
    overlay_ipv6 VARCHAR(45) NOT NULL UNIQUE,
    role VARCHAR(32) NOT NULL DEFAULT 'CLIENT_ORIGIN' CHECK (role IN ('CLIENT_ORIGIN', 'EXIT_BRIDGE', 'HYBRID', 'RELAY')),
    ip_class VARCHAR(32) NOT NULL DEFAULT 'RESIDENTIAL' CHECK (ip_class IN ('RESIDENTIAL', 'MOBILE_5G', 'DATACENTER', 'UNKNOWN')),
    country_code VARCHAR(2) NOT NULL DEFAULT 'US',
    city VARCHAR(128) DEFAULT '',
    asn INTEGER DEFAULT 0,
    endpoints JSONB NOT NULL DEFAULT '[]'::jsonb,
    location GEOMETRY(Point, 4326),
    onion_routing_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    onion_hops INTEGER NOT NULL DEFAULT 0,
    kill_switch_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    is_healthy BOOLEAN NOT NULL DEFAULT TRUE,
    is_quarantined BOOLEAN NOT NULL DEFAULT FALSE,
    quarantine_reason TEXT,
    risk_score INTEGER NOT NULL DEFAULT 0 CHECK (risk_score >= 0 AND risk_score <= 100),
    last_geo_drift_at TIMESTAMPTZ,
    last_heartbeat TIMESTAMPTZ,
    latency_ms REAL NOT NULL DEFAULT 0.0,
    tx_bytes BIGINT NOT NULL DEFAULT 0,
    rx_bytes BIGINT NOT NULL DEFAULT 0,
    cpu_usage_pct REAL DEFAULT 0.0,
    memory_usage_pct REAL DEFAULT 0.0,
    battery_pct REAL DEFAULT 100.0,
    posture_checks JSONB NOT NULL DEFAULT '{"compliant": true, "disk_encrypted": true, "os": "Linux"}'::jsonb,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_nodes_location_gix ON nodes USING GIST(location);
```

#### Cross-Mesh Peering Agreements (`peering_agreements`)
Tracks Ed25519-signed peering relationships with external NeroNet networks:
```sql
CREATE TABLE IF NOT EXISTS peering_agreements (
    id VARCHAR(64) PRIMARY KEY,
    initiator_user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    peer_name VARCHAR(128) NOT NULL,
    peer_endpoint VARCHAR(255) NOT NULL,
    peer_token_ed25519 TEXT NOT NULL,
    peer_public_key_ed25519 VARCHAR(128) NOT NULL,
    scope_mode VARCHAR(32) NOT NULL DEFAULT 'ALL' CHECK (scope_mode IN ('ALL', 'SPECIFIC_DEVICES', 'SPECIFIC_SUBNETS')),
    shared_device_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
    shared_subnets JSONB NOT NULL DEFAULT '[]'::jsonb,
    imported_nodes JSONB NOT NULL DEFAULT '[]'::jsonb,
    status VARCHAR(32) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'revoked', 'expired')),
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

#### Dead Man's Switch Engine (`dead_man_switch`)
Underpins the 3-tier NeroNuke cryptographic self-destruction mechanism:
```sql
CREATE TABLE IF NOT EXISTS dead_man_switch (
    id VARCHAR(64) PRIMARY KEY,
    user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    switch_tier VARCHAR(32) NOT NULL CHECK (switch_tier IN ('personal_user', 'owner_global')),
    passphrase_hash VARCHAR(255) NOT NULL,
    heartbeat_interval_seconds BIGINT NOT NULL,
    last_heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    next_deadline_at TIMESTAMPTZ NOT NULL,
    webhook_url VARCHAR(512),
    steganography_mode VARCHAR(32) DEFAULT 'shadow_password',
    steganography_secret VARCHAR(255),
    status VARCHAR(32) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'triggered', 'deactivated')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

---

## 4. Valkey 7 State Bus & Real-Time Topology Architecture

Valkey 7 functions as the low-latency state bus:

1. **Token Revocation Blacklist (`blacklist:token:<sha256(token)>`):**
   - On `POST /api/auth/logout`, the JWT SHA-256 hash is written with an expiration matching the token's lifetime (`EX 900` for 15m access tokens).
   - In `middleware/auth.js`, the token blacklist check executes in O(1) time in memory before running cryptographic verification.

2. **Active-Active Pub/Sub Synchronization (`neronet:topology:events`):**
   - Whenever a node connects, disconnects, updates telemetry, toggles onion routing, or enters quarantine, a JSON event is published to `neronet:topology:events`.
   - All backend API replicas run a dedicated Redis subscriber (`ioredis`) that consumes events and immediately pushes them to local WebSocket connections (`/ws/topology`).

---

## 5. Security Hardening & Timing Attack Remediation

The migration fixes critical authentication vulnerabilities:

1. **Elimination of Mock Auth Fallback:**
   - The frontend API client (`console/frontend/src/services/api.js`) previously fell back to an in-memory mock admin session if the backend returned HTTP 401. This client-side fallback has been completely removed.
   - HTTP 401 strictly throws an authentication error and clears local session storage.

2. **Constant-Time bcrypt Verification:**
   - To eliminate username enumeration timing side-channels, `POST /api/auth/login` checks if the user exists. If the username is not found in PostgreSQL, the server executes `bcrypt.compare(password, DUMMY_BCRYPT_HASH)` against a pre-computed hash.
   - The response latency remains identical whether a username exists or not, preventing attackers from harvesting valid accounts.

---

## 6. Step-by-Step Data Migration Procedure

To migrate existing SQLite data (`neronet.db`) to PostgreSQL 16:

### Step 1: Export SQLite Data
Export existing tables to JSON:
```bash
sqlite3 data/neronet.db << 'SQL_DUMP'
.mode json
.output /tmp/users_dump.json
SELECT * FROM users;
.output /tmp/nodes_dump.json
SELECT * FROM nodes;
.output /tmp/audit_dump.json
SELECT * FROM audit_events;
SQL_DUMP
```

### Step 2: Apply PostgreSQL DDL Migrations
Run the migrator against PostgreSQL:
```bash
export DATABASE_URL="postgresql://neronet:neronet_secret_pass_2026@localhost:5432/neronet_db"
node backend/db/migrator.js
```

### Step 3: Ingest Data into PostgreSQL
Use the automated migration ingestion script to map SQLite text types to PostgreSQL PostGIS geometries and JSONB columns.

---

## 7. Environment Configuration Reference

| Variable Name | Default Value | Description |
|---|---|---|
| `DATABASE_URL` | `postgresql://neronet:neronet_secret_pass_2026@127.0.0.1:5432/neronet_db` | PostgreSQL 16 connection string |
| `PGHOST` | `127.0.0.1` | PostgreSQL hostname |
| `PGPORT` | `5432` | PostgreSQL port |
| `PGUSER` | `neronet` | Database user |
| `PGPASSWORD` | `neronet_secret_pass_2026` | Database password |
| `PGDATABASE` | `neronet_db` | Database name |
| `VALKEY_URL` | `redis://127.0.0.1:6379` | Valkey 7 / Redis cluster URI |
| `SOVEREIGN_JWT_SECRET` | `svrn_dev_secret_key...` | Symmetric signing key for auth tokens |
| `SOVEREIGN_API_PORT` | `8082` | Backend HTTP API listening port |

---

## 8. Verification & Health Check Validation

To verify the migration health:

1. Probe Health Endpoint:
   ```bash
   curl -s http://127.0.0.1:8082/api/health | jq .
   ```
   **Expected Response:**
   ```json
   {
     "status": "ok",
     "version": "4.0.0",
     "database": "connected",
     "database_type": "postgresql_16",
     "postgis": "active",
     "valkey": "connected",
     "valkey_type": "valkey_7",
     "uptime_seconds": 120,
     "timestamp": "2026-08-31T13:45:00.000Z"
   }
   ```

2. Execute Test Suite:
   ```bash
   cd console/backend && npm test
   ```
   Ensures all 65 unit and integration tests pass with 0 regressions.
