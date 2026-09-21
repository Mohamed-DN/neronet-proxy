-- ============================================================================
-- Migration 015: Node Identity v2 — Pre-Auth Keys & Ephemeral Node Credentials
-- ============================================================================

CREATE TABLE IF NOT EXISTS preauth_keys (
    id VARCHAR(64) PRIMARY KEY,
    key_hash VARCHAR(64) NOT NULL UNIQUE,
    key_prefix VARCHAR(16) NOT NULL,
    owner_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    allowed_role VARCHAR(32),
    is_reusable BOOLEAN NOT NULL DEFAULT FALSE,
    used_count INTEGER NOT NULL DEFAULT 0,
    max_uses INTEGER,
    expires_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_preauth_keys_hash ON preauth_keys(key_hash);
CREATE INDEX IF NOT EXISTS idx_preauth_keys_owner ON preauth_keys(owner_id);

CREATE TABLE IF NOT EXISTS node_credentials (
    id VARCHAR(64) PRIMARY KEY,
    node_id VARCHAR(64) NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    token_hash VARCHAR(64) NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_used_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_node_credentials_hash ON node_credentials(token_hash);
CREATE INDEX IF NOT EXISTS idx_node_credentials_node ON node_credentials(node_id);
CREATE INDEX IF NOT EXISTS idx_node_credentials_expires ON node_credentials(expires_at);
