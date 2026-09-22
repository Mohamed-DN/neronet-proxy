-- Migration 024: Crypto-Shredding with Governance (WP-302 NeroNuke v2)
--
-- Implements:
-- 1. Per-organization Data Encryption Keys (DEKs) for cryptographically irreversible erasure.
-- 2. Legal holds to prevent destruction under compliance or preservation orders.
-- 3. Dual-authorization (4-eyes principle) for all destructive operations.

-- 1. Per-organization keys
CREATE TABLE IF NOT EXISTS organization_keys (
    organization_id  VARCHAR(64) PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
    key_epoch        INT NOT NULL DEFAULT 1,
    encrypted_dek    TEXT NOT NULL,
    dek_hash         VARCHAR(64) NOT NULL,
    status           VARCHAR(32) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'destroyed', 'frozen')),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    shredded_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_org_keys_status ON organization_keys(status);

-- 2. Legal holds table
CREATE TABLE IF NOT EXISTS organization_legal_holds (
    id                   VARCHAR(64) PRIMARY KEY,
    organization_id      VARCHAR(64) NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    reason               TEXT NOT NULL,
    imposed_by_user_id   VARCHAR(64) NOT NULL,
    active               BOOLEAN NOT NULL DEFAULT TRUE,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    released_at          TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_legal_holds_org_active ON organization_legal_holds(organization_id, active);

-- 3. Dual-authorization workflow for destructive operations
CREATE TABLE IF NOT EXISTS nuke_authorizations (
    id                   VARCHAR(64) PRIMARY KEY,
    target_type          VARCHAR(32) NOT NULL CHECK (target_type IN ('organization', 'global')),
    target_id            VARCHAR(64) NOT NULL,
    initiator_user_id    VARCHAR(64) NOT NULL,
    initiator_comment    TEXT,
    approver_user_id     VARCHAR(64),
    approver_comment     TEXT,
    status               VARCHAR(32) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'executed', 'cancelled')),
    expires_at           TIMESTAMPTZ NOT NULL,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    executed_at          TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_nuke_auth_status ON nuke_authorizations(status, expires_at);
