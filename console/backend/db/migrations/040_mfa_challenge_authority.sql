-- Password-only MFA steps are registered proofs, consumed with the resulting
-- session in one transaction. Legacy unregistered steps require a fresh login.
ALTER TABLE users ADD COLUMN IF NOT EXISTS console_auth_epoch BIGINT NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_pending_proof_id UUID;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_pending_proof_type TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_pending_expires_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_pending_auth_epoch BIGINT;

CREATE TABLE IF NOT EXISTS console_mfa_challenges (
    id UUID PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    issued_organization_id TEXT NOT NULL,
    issued_auth_epoch BIGINT NOT NULL CHECK (issued_auth_epoch > 0),
    access_tier TEXT NOT NULL CHECK (access_tier IN ('standard','root')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,
    CHECK (expires_at > created_at)
);
CREATE INDEX IF NOT EXISTS console_mfa_challenges_user_idx ON console_mfa_challenges(user_id);
CREATE INDEX IF NOT EXISTS console_mfa_challenges_expiry_idx ON console_mfa_challenges(expires_at);

-- Existing enrolled authenticators and recovery codes remain intact. Pending
-- QR setups predate proof binding and must be restarted after the API upgrade.
UPDATE users SET totp_pending_secret=NULL,totp_pending_recovery_codes=NULL,
    totp_pending_proof_id=NULL,totp_pending_proof_type=NULL,
    totp_pending_expires_at=NULL,totp_pending_auth_epoch=NULL
WHERE totp_pending_proof_id IS NULL;

CREATE OR REPLACE FUNCTION advance_console_auth_epoch() RETURNS TRIGGER AS $$
BEGIN
    IF NEW.password_hash IS DISTINCT FROM OLD.password_hash
       OR NEW.password_hash_root IS DISTINCT FROM OLD.password_hash_root
       OR NEW.password_hash_stealth_wipe IS DISTINCT FROM OLD.password_hash_stealth_wipe
       OR NEW.password_hash_nuclear_wipe IS DISTINCT FROM OLD.password_hash_nuclear_wipe
       OR COALESCE(NEW.organization_id,'org-default') IS DISTINCT FROM COALESCE(OLD.organization_id,'org-default')
       OR NEW.status IS DISTINCT FROM OLD.status
       OR NEW.role IS DISTINCT FROM OLD.role
       OR NEW.totp_secret IS DISTINCT FROM OLD.totp_secret
       OR NEW.totp_enabled IS DISTINCT FROM OLD.totp_enabled THEN
        NEW.console_auth_epoch := OLD.console_auth_epoch + 1;
        NEW.totp_pending_secret := NULL;
        NEW.totp_pending_recovery_codes := NULL;
        NEW.totp_pending_proof_id := NULL;
        NEW.totp_pending_proof_type := NULL;
        NEW.totp_pending_expires_at := NULL;
        NEW.totp_pending_auth_epoch := NULL;
    ELSIF NEW.console_auth_epoch < OLD.console_auth_epoch THEN
        RAISE EXCEPTION 'Console authentication epoch cannot decrease';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS users_console_auth_epoch ON users;
CREATE TRIGGER users_console_auth_epoch BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION advance_console_auth_epoch();
