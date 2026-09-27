-- Migration 030: record which key hashed each audit event
--
-- The audit chain was keyed with the JWT signing secret. It now has a key of its own
-- (SOVEREIGN_AUDIT_HMAC_SECRET). Each event records the id of the key that hashed it,
-- derived from the key so that it reveals nothing about it. Events written before
-- this migration have none: they were hashed with the JWT secret, and verification
-- accepts them only as an unbroken prefix of the chain.

ALTER TABLE audit_events ADD COLUMN IF NOT EXISTS hmac_key_id VARCHAR(16);
