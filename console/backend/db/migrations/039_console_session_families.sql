-- A family is one independent sign-in, including all of its rotated credentials.
CREATE TABLE IF NOT EXISTS console_sessions (
    id UUID PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    issued_organization_id TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    revocation_reason TEXT,
    root_grant_id UUID,
    root_grant_expires_at TIMESTAMPTZ,
    root_organization_id TEXT,
    CHECK ((root_grant_id IS NULL AND root_grant_expires_at IS NULL AND root_organization_id IS NULL)
        OR (root_grant_id IS NOT NULL AND root_grant_expires_at IS NOT NULL AND root_organization_id IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_console_sessions_user ON console_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_console_sessions_expiry ON console_sessions(expires_at);
ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS session_id UUID REFERENCES console_sessions(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_session ON refresh_tokens(session_id);
-- Old releases may have duplicate legacy hashes; retain those records unchanged.
CREATE UNIQUE INDEX IF NOT EXISTS idx_refresh_tokens_family_hash
    ON refresh_tokens(token_hash) WHERE session_id IS NOT NULL;

-- Existing credentials have no durable family. Require a fresh sign-in on upgrade.
UPDATE refresh_tokens SET revoked=TRUE, revoked_at=COALESCE(revoked_at, NOW())
 WHERE session_id IS NULL AND (revoked=FALSE OR revoked_at IS NULL);

-- A grant cannot become valid again when a tenant transfer or password change
-- is later undone. All writers, including administrative SQL, cross this boundary.
CREATE OR REPLACE FUNCTION invalidate_console_root_grants() RETURNS TRIGGER AS $$
BEGIN
    UPDATE console_sessions
       SET root_grant_id=NULL, root_grant_expires_at=NULL, root_organization_id=NULL
     WHERE user_id=NEW.id AND root_grant_id IS NOT NULL;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER console_root_grant_identity_change
AFTER UPDATE OF organization_id, password_hash_root ON users
FOR EACH ROW
WHEN (COALESCE(OLD.organization_id, 'org-default') IS DISTINCT FROM COALESCE(NEW.organization_id, 'org-default')
    OR OLD.password_hash_root IS DISTINCT FROM NEW.password_hash_root)
EXECUTE FUNCTION invalidate_console_root_grants();
