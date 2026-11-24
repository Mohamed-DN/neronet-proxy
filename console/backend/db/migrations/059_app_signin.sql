-- App sign-in by device code, app tokens, and the one-node enrolment grant (ADR 0040, phase 0).
--
-- Only hashes are stored: the device code and the user code of a sign-in, the access and
-- refresh token of an app session. The plaintext is shown to the app once, at the poll that
-- finds the sign-in approved.

CREATE TABLE IF NOT EXISTS app_device_codes (
    id                      TEXT PRIMARY KEY,
    device_code_hash        TEXT NOT NULL UNIQUE,
    user_code_hash          TEXT NOT NULL UNIQUE,
    status                  TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'approved', 'denied', 'consumed')),
    platform                TEXT NOT NULL CHECK (platform IN ('windows', 'macos', 'linux', 'android', 'ios')),
    device_name             TEXT NOT NULL CHECK (char_length(device_name) BETWEEN 1 AND 64),
    installation_public_key TEXT NOT NULL CHECK (installation_public_key ~ '^[0-9a-f]{64}$'),
    -- Ed25519 key the installation keeps in its key store; every refresh is signed with it.
    signing_public_key      TEXT NOT NULL CHECK (signing_public_key ~ '^[0-9a-f]{64}$'),
    scopes                  TEXT[] NOT NULL,
    request_ip              TEXT,
    interval_seconds        INTEGER NOT NULL DEFAULT 5,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at              TIMESTAMPTZ NOT NULL,
    last_polled_at          TIMESTAMPTZ,
    approved_user_id        TEXT REFERENCES users(id) ON DELETE CASCADE,
    approved_organization_id TEXT,
    -- The account's console_auth_epoch at approval: if it moved before the app collected, nothing is issued.
    approved_auth_epoch     BIGINT,
    decided_at              TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_app_device_codes_expires ON app_device_codes (expires_at);

CREATE TABLE IF NOT EXISTS app_sessions (
    id                      TEXT PRIMARY KEY,
    user_id                 TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    organization_id         TEXT NOT NULL,
    installation_public_key TEXT NOT NULL CHECK (installation_public_key ~ '^[0-9a-f]{64}$'),
    signing_public_key      TEXT NOT NULL CHECK (signing_public_key ~ '^[0-9a-f]{64}$'),
    node_id                 TEXT NOT NULL,
    grant_key_id            TEXT,
    platform                TEXT NOT NULL,
    device_name             TEXT NOT NULL,
    scopes                  TEXT[] NOT NULL,
    access_hash             TEXT NOT NULL UNIQUE,
    access_expires_at       TIMESTAMPTZ NOT NULL,
    refresh_hash            TEXT NOT NULL UNIQUE,
    previous_refresh_hash   TEXT,
    -- Every older refresh token of this session, so one two rotations old is still recognised.
    retired_refresh_hashes  TEXT[] NOT NULL DEFAULT '{}',
    -- When the pair last rotated: the retry window for a lost answer runs from here.
    rotated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    refresh_expires_at      TIMESTAMPTZ NOT NULL,
    -- The account's console_auth_epoch when the app was approved; a password, role or second-factor
    -- change, or "revoke all sessions", moves the account's epoch and ends this app with it.
    auth_epoch              BIGINT NOT NULL,
    absolute_expires_at     TIMESTAMPTZ NOT NULL,
    request_ip              TEXT,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_used_at            TIMESTAMPTZ,
    revoked_at              TIMESTAMPTZ,
    revoked_by              TEXT,
    revoked_reason          TEXT
);
CREATE INDEX IF NOT EXISTS idx_app_sessions_user ON app_sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_app_sessions_org ON app_sessions (organization_id);
CREATE INDEX IF NOT EXISTS idx_app_sessions_previous_refresh ON app_sessions (previous_refresh_hash);
CREATE INDEX IF NOT EXISTS idx_app_sessions_retired_refresh ON app_sessions USING GIN (retired_refresh_hashes);
-- One live app per node, whatever the code does.
CREATE UNIQUE INDEX IF NOT EXISTS uq_app_sessions_active_node ON app_sessions (node_id) WHERE revoked_at IS NULL;

-- Removing a node, by any route (console, shred, cascade), ends the app that was signed in for it.
CREATE OR REPLACE FUNCTION end_app_sessions_of_deleted_node() RETURNS TRIGGER AS $$
BEGIN
    UPDATE app_sessions SET revoked_at = NOW(), revoked_reason = COALESCE(revoked_reason, 'node_removed')
     WHERE node_id = OLD.id AND revoked_at IS NULL;
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_end_app_sessions_of_deleted_node ON nodes;
CREATE TRIGGER trg_end_app_sessions_of_deleted_node AFTER DELETE ON nodes
    FOR EACH ROW EXECUTE FUNCTION end_app_sessions_of_deleted_node();

-- A second-factor code is good once: the last accepted time step, so it cannot be replayed.
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_last_used_step BIGINT;

-- Signed refresh requests carry a random nonce, accepted once.
CREATE TABLE IF NOT EXISTS app_refresh_nonces (
    nonce_hash  TEXT PRIMARY KEY,
    session_id  TEXT NOT NULL REFERENCES app_sessions(id) ON DELETE CASCADE,
    expires_at  TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_app_refresh_nonces_expires ON app_refresh_nonces (expires_at);

-- A grant issued to an app is good for one node, the one holding this key.
ALTER TABLE preauth_keys
    ADD COLUMN IF NOT EXISTS bound_public_key TEXT
        CHECK (bound_public_key IS NULL OR bound_public_key ~ '^[0-9a-f]{64}$');
