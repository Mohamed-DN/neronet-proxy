-- ============================================================================
-- NeroNet Sovereign Mesh Enterprise Management Console
-- Migration 001: Initial PostgreSQL 16 + PostGIS + pgvector Schema
-- ============================================================================

-- 1. Enable Required Extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- PostGIS was removed in migration 004. It declared a GEOMETRY column and a GiST
-- index that no query ever touched: geo-fencing compares country_code strings, and
-- distance is computed with Haversine in RiskEngine. The extension cost a second
-- schema to maintain, a PostGIS-specific base image, and a set of tests that
-- asserted the DDL text rather than any behaviour -- while buying nothing, because
-- spatial indexing only starts to pay at a scale this fleet does not reach.
--
-- If spatial querying is ever needed, a bounding-box prefilter over the latitude
-- and longitude columns followed by Haversine gives the same answers, works
-- identically on SQLite and PostgreSQL, and needs no extension.

-- pgvector is optional (reserved for future AI anomaly detection).
-- Silently skip if not installed on this PostgreSQL image.
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS "vector";
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pgvector extension not available, skipping (will be enabled when available).';
END;
$$;

-- 2. Users Table
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

CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
CREATE INDEX IF NOT EXISTS idx_users_tier ON users(tier);

-- 3. Nodes Table (with PostGIS Geometry & JSONB)
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
    latitude REAL,
    longitude REAL,
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

CREATE INDEX IF NOT EXISTS idx_nodes_user_id ON nodes(user_id);
CREATE INDEX IF NOT EXISTS idx_nodes_public_key ON nodes(public_key);
CREATE INDEX IF NOT EXISTS idx_nodes_overlay_ipv4 ON nodes(overlay_ipv4);
CREATE INDEX IF NOT EXISTS idx_nodes_role ON nodes(role);
CREATE INDEX IF NOT EXISTS idx_nodes_latlng ON nodes(latitude, longitude);
CREATE INDEX IF NOT EXISTS idx_nodes_risk_score ON nodes(risk_score);
CREATE INDEX IF NOT EXISTS idx_nodes_is_quarantined ON nodes(is_quarantined);

-- 4. App Bundles Table
CREATE TABLE IF NOT EXISTS app_bundles (
    id VARCHAR(64) PRIMARY KEY,
    user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(128) NOT NULL,
    type VARCHAR(32) NOT NULL CHECK (type IN ('guacamole', 'nextcloud', 'immich', 'seafile')),
    tier VARCHAR(32) NOT NULL DEFAULT 'managed_cloud' CHECK (tier IN ('managed_cloud', 'self_hosted_byos')),
    status VARCHAR(32) NOT NULL DEFAULT 'stopped' CHECK (status IN ('provisioning', 'running', 'stopped', 'error', 'suspended', 'hibernated')),
    endpoint_url VARCHAR(512) NOT NULL,
    internal_port INTEGER NOT NULL DEFAULT 8080,
    container_id VARCHAR(128),
    cpu_cores REAL NOT NULL DEFAULT 2.0,
    memory_mb INTEGER NOT NULL DEFAULT 2048,
    storage_gb INTEGER NOT NULL DEFAULT 50,
    scale_to_zero BOOLEAN NOT NULL DEFAULT TRUE,
    inactivity_timeout_min INTEGER DEFAULT 30,
    config_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    last_accessed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_app_bundles_user_id ON app_bundles(user_id);
CREATE INDEX IF NOT EXISTS idx_app_bundles_type ON app_bundles(type);
CREATE INDEX IF NOT EXISTS idx_app_bundles_status ON app_bundles(status);

-- 5. Audit Events Table
CREATE TABLE IF NOT EXISTS audit_events (
    id BIGSERIAL PRIMARY KEY,
    event_type VARCHAR(64) NOT NULL,
    severity VARCHAR(32) NOT NULL DEFAULT 'info' CHECK (severity IN ('info', 'warn', 'error', 'critical')),
    actor_user_id VARCHAR(64),
    actor_username VARCHAR(64),
    target_id VARCHAR(64),
    target_type VARCHAR(64),
    message TEXT NOT NULL,
    ip_address VARCHAR(45),
    user_agent TEXT,
    metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_events_created_at ON audit_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_events_event_type ON audit_events(event_type);
CREATE INDEX IF NOT EXISTS idx_audit_events_severity ON audit_events(severity);
CREATE INDEX IF NOT EXISTS idx_audit_events_actor ON audit_events(actor_user_id);

-- 6. System Metrics Timeseries Table
CREATE TABLE IF NOT EXISTS system_metrics (
    id BIGSERIAL PRIMARY KEY,
    timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    active_nodes INTEGER NOT NULL DEFAULT 0,
    active_users INTEGER NOT NULL DEFAULT 0,
    total_bandwidth_rx BIGINT NOT NULL DEFAULT 0,
    total_bandwidth_tx BIGINT NOT NULL DEFAULT 0,
    cpu_usage_pct REAL NOT NULL DEFAULT 0.0,
    memory_usage_mb REAL NOT NULL DEFAULT 0.0,
    active_circuits INTEGER NOT NULL DEFAULT 0,
    network_health_score INTEGER NOT NULL DEFAULT 100
);

CREATE INDEX IF NOT EXISTS idx_system_metrics_timestamp ON system_metrics(timestamp DESC);

-- 7. Refresh Tokens Table (with Valkey HA fallback)
CREATE TABLE IF NOT EXISTS refresh_tokens (
    id VARCHAR(64) PRIMARY KEY,
    user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash VARCHAR(128) NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    revoked BOOLEAN NOT NULL DEFAULT FALSE,
    user_agent TEXT,
    ip_address VARCHAR(45),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_id ON refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_hash ON refresh_tokens(token_hash);

-- 8. NeroDrop P2P File Transfer Sessions Table
CREATE TABLE IF NOT EXISTS nerodrop_sessions (
    id VARCHAR(64) PRIMARY KEY,
    user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    source_node_id VARCHAR(64) NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    target_node_id VARCHAR(64) NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    file_name VARCHAR(255) NOT NULL,
    file_size_bytes BIGINT NOT NULL,
    file_type VARCHAR(128) DEFAULT 'application/octet-stream',
    blake3_hash VARCHAR(128) NOT NULL,
    chunk_size_bytes INTEGER NOT NULL DEFAULT 65536,
    total_chunks INTEGER NOT NULL,
    transferred_chunks INTEGER NOT NULL DEFAULT 0,
    bytes_transferred BIGINT NOT NULL DEFAULT 0,
    status VARCHAR(32) NOT NULL DEFAULT 'ready' CHECK (status IN ('ready', 'pending', 'transferring', 'completed', 'failed', 'cancelled')),
    webrtc_signal_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_nerodrop_user_id ON nerodrop_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_nerodrop_status ON nerodrop_sessions(status);

-- 9. App Share Links Table
CREATE TABLE IF NOT EXISTS app_share_links (
    id VARCHAR(64) PRIMARY KEY,
    app_id VARCHAR(64) NOT NULL REFERENCES app_bundles(id) ON DELETE CASCADE,
    user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    share_token VARCHAR(128) NOT NULL UNIQUE,
    public_url VARCHAR(512) NOT NULL,
    auth_mode VARCHAR(32) NOT NULL DEFAULT 'temporary_password' CHECK (auth_mode IN ('temporary_password', 'sso_gateway', 'passkey')),
    temporary_password VARCHAR(128),
    expires_at TIMESTAMPTZ NOT NULL,
    max_uses INTEGER DEFAULT 0,
    use_count INTEGER DEFAULT 0,
    is_revoked BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_app_share_links_token ON app_share_links(share_token);
CREATE INDEX IF NOT EXISTS idx_app_share_links_app_id ON app_share_links(app_id);
CREATE INDEX IF NOT EXISTS idx_app_share_links_user_id ON app_share_links(user_id);
