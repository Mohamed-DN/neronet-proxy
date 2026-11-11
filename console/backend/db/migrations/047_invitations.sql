-- Invitations: an organisation administrator invites a person, who then chooses their own
-- username and password from anywhere, while public registration stays closed.
--
-- The invitation is a bearer secret, so it is kept like a password: the 32-byte token and
-- the short code derived from it are shown once and never stored. token_hash is the
-- SHA-256 of the token (256 bits of entropy, a fast hash is enough). code_hash is a slow,
-- deterministic scrypt of the 60-bit code, so a copy of this table does not let anyone
-- grind the short code offline.
CREATE TABLE IF NOT EXISTS invitations (
    id VARCHAR(64) PRIMARY KEY,
    organization_id VARCHAR(64) NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    token_hash CHAR(64) NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    code_hash CHAR(64) NOT NULL UNIQUE CHECK (code_hash ~ '^[0-9a-f]{64}$'),
    -- owner is never invitable: an owner is made by another owner, in the member list.
    role VARCHAR(32) NOT NULL DEFAULT 'member'
        CHECK (role IN ('admin', 'network_admin', 'auditor', 'member')),
    display_name_hint VARCHAR(128),
    created_by VARCHAR(64) REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '7 days',
    used_at TIMESTAMPTZ,
    used_by VARCHAR(64) REFERENCES users(id) ON DELETE SET NULL,
    revoked_at TIMESTAMPTZ,
    revoked_by VARCHAR(64) REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT invitations_lifetime CHECK (expires_at > created_at AND expires_at <= created_at + INTERVAL '30 days'),
    CONSTRAINT invitations_used_or_revoked CHECK (used_at IS NULL OR revoked_at IS NULL)
);

CREATE INDEX IF NOT EXISTS idx_invitations_org_created ON invitations(organization_id, created_at DESC);
