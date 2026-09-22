-- Migration 023: Tamper-Evident Audit Chain & SIEM Export (WP-301)
--
-- Adds cryptographic HMAC-SHA256 hash chaining to audit_events,
-- signed verification checkpoints, and SIEM destination configuration.

-- 1. Extend audit_events with cryptographic chain fields
ALTER TABLE audit_events ADD COLUMN IF NOT EXISTS sequence_num BIGINT;
ALTER TABLE audit_events ADD COLUMN IF NOT EXISTS prev_hash VARCHAR(64);
ALTER TABLE audit_events ADD COLUMN IF NOT EXISTS entry_hash VARCHAR(64);

CREATE SEQUENCE IF NOT EXISTS audit_events_sequence_seq;

-- Backfill sequence_num for existing events if any
UPDATE audit_events
   SET sequence_num = id
 WHERE sequence_num IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_events_sequence_num ON audit_events(sequence_num);
CREATE INDEX IF NOT EXISTS idx_audit_events_entry_hash ON audit_events(entry_hash);

-- 2. Checkpoints table for signed state verifications
CREATE TABLE IF NOT EXISTS audit_checkpoints (
    id                 BIGSERIAL PRIMARY KEY,
    last_event_id      BIGINT NOT NULL,
    last_sequence_num  BIGINT NOT NULL,
    checkpoint_hash    VARCHAR(64) NOT NULL,
    signature          TEXT NOT NULL,
    public_key         TEXT NOT NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_checkpoints_created_at ON audit_checkpoints(created_at DESC);

-- 3. SIEM destinations table
CREATE TABLE IF NOT EXISTS audit_siem_destinations (
    id          VARCHAR(64) PRIMARY KEY,
    name        VARCHAR(128) NOT NULL,
    protocol    VARCHAR(16) NOT NULL CHECK (protocol IN ('udp', 'tcp', 'tls', 'webhook')),
    endpoint    VARCHAR(255) NOT NULL,
    format      VARCHAR(32) NOT NULL DEFAULT 'rfc5424' CHECK (format IN ('rfc5424', 'json_nd', 'cef')),
    enabled     BOOLEAN NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
