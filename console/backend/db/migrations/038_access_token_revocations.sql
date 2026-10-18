-- Keep explicit access-token logout independent of Valkey and process memory.
-- Only a SHA-256 digest is stored. Null expiry is retained for legacy signed
-- tokens without exp; those entries must not be removed on a guessed timeout.
CREATE TABLE IF NOT EXISTS access_token_revocations (
    token_hash VARCHAR(64) PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_access_token_revocations_expiry
    ON access_token_revocations (expires_at) WHERE expires_at IS NOT NULL;
