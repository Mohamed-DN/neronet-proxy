-- An authenticator being enrolled or replaced is kept apart from the one in use until
-- a code from it is confirmed. /api/auth/mfa/setup used to overwrite totp_secret and
-- switch MFA off straight away, which let a caller holding only the password replace
-- the account's authenticator with their own.
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_pending_secret TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_pending_recovery_codes JSONB;
