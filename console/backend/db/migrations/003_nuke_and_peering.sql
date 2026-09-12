-- ============================================================================
-- NeroNet Sovereign Mesh Enterprise Management Console
-- Migration 003: Cross-Mesh Peering, NeroNuke DMS & Sovereign Cloud PC
-- ============================================================================

-- 1. Cross-Mesh Peering Agreements (R4)
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

CREATE INDEX IF NOT EXISTS idx_peering_status ON peering_agreements(status);
CREATE INDEX IF NOT EXISTS idx_peering_initiator ON peering_agreements(initiator_user_id);

-- 2. Dead Man's Switch Engine Table (R5)
CREATE TABLE IF NOT EXISTS dead_man_switch (
    id VARCHAR(64) PRIMARY KEY,
    user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    switch_tier VARCHAR(32) NOT NULL CHECK (switch_tier IN ('personal_user', 'owner_global')),
    passphrase_hash VARCHAR(255) NOT NULL,
    heartbeat_interval_seconds BIGINT NOT NULL,
    last_heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    next_deadline_at TIMESTAMPTZ NOT NULL,
    webhook_url VARCHAR(512),
    steganography_mode VARCHAR(32) DEFAULT 'shadow_password' CHECK (steganography_mode IN ('reverse_password', 'split_reverse', 'shadow_password', 'hardware_key', 'mobile_otp')),
    steganography_secret VARCHAR(255),
    status VARCHAR(32) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'triggered', 'deactivated')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_user_switch_tier UNIQUE(user_id, switch_tier)
);

CREATE INDEX IF NOT EXISTS idx_dms_deadline ON dead_man_switch(next_deadline_at, status);

-- 3. Warrant Canary Table (R5 Tier 3)
CREATE TABLE IF NOT EXISTS warrant_canaries (
    id VARCHAR(64) PRIMARY KEY,
    published_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    statement_text TEXT NOT NULL,
    ed25519_signature TEXT NOT NULL,
    signer_public_key TEXT NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE
);

-- 4. Sovereign Cloud PC & Custom Domains Table (R2)
CREATE TABLE IF NOT EXISTS cloud_pcs (
    id VARCHAR(64) PRIMARY KEY,
    name VARCHAR(128) NOT NULL,
    user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id VARCHAR(64) NOT NULL,
    specs JSONB NOT NULL DEFAULT '{"vcpus": 4, "ram_gb": 16}'::jsonb,
    status VARCHAR(32) NOT NULL DEFAULT 'active' CHECK (status IN ('provisioning', 'active', 'stopped', 'error')),
    signaling_url VARCHAR(255) NOT NULL DEFAULT 'wss://signal.internal.darknero.com/ws/selkies',
    custom_domain VARCHAR(255),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cloud_pcs_user ON cloud_pcs(user_id);

CREATE TABLE IF NOT EXISTS custom_domains (
    id VARCHAR(64) PRIMARY KEY,
    user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    cloud_pc_id VARCHAR(64),
    device_id VARCHAR(64) REFERENCES nodes(id) ON DELETE CASCADE,
    domain_name VARCHAR(255) NOT NULL UNIQUE,
    sso_gateway_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    otp_secret VARCHAR(128),
    webrtc_signaling_endpoint VARCHAR(255),
    status VARCHAR(32) NOT NULL DEFAULT 'active' CHECK (status IN ('provisioning', 'active', 'suspended', 'error')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_custom_domains_name ON custom_domains(domain_name);
