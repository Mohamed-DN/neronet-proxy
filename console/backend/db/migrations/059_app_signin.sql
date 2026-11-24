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
    scopes                  TEXT[] NOT NULL,
    request_ip              TEXT,
    interval_seconds        INTEGER NOT NULL DEFAULT 5,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at              TIMESTAMPTZ NOT NULL,
    last_polled_at          TIMESTAMPTZ,
    approved_user_id        TEXT REFERENCES users(id) ON DELETE CASCADE,
    approved_organization_id TEXT,
    decided_at              TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_app_device_codes_expires ON app_device_codes (expires_at);

CREATE TABLE IF NOT EXISTS app_sessions (
    id                      TEXT PRIMARY KEY,
    user_id                 TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    organization_id         TEXT NOT NULL,
    installation_public_key TEXT NOT NULL CHECK (installation_public_key ~ '^[0-9a-f]{64}$'),
    node_id                 TEXT NOT NULL,
    grant_key_id            TEXT,
    platform                TEXT NOT NULL,
    device_name             TEXT NOT NULL,
    scopes                  TEXT[] NOT NULL,
    access_hash             TEXT NOT NULL UNIQUE,
    access_expires_at       TIMESTAMPTZ NOT NULL,
    refresh_hash            TEXT NOT NULL UNIQUE,
    previous_refresh_hash   TEXT,
    refresh_expires_at      TIMESTAMPTZ NOT NULL,
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

-- A grant issued to an app is good for one node, the one holding this key.
ALTER TABLE preauth_keys
    ADD COLUMN IF NOT EXISTS bound_public_key TEXT
        CHECK (bound_public_key IS NULL OR bound_public_key ~ '^[0-9a-f]{64}$');
