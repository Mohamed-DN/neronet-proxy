-- Migration 016: Console Session Hardening and TOTP MFA
-- Implements ADR 0018 (WP-105)

-- 1. Add TOTP columns to users table
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_recovery_codes JSONB DEFAULT '[]'::jsonb;

-- 2. Enhance refresh_tokens table for single-use token rotation
ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_revoked_at ON refresh_tokens(revoked_at);
