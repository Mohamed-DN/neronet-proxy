-- Migration 021: DAITA Anti-AI Traffic Fingerprinting & Maybenot Traffic Shaping
-- Implements packet padding, discrete bucket normalization, and dummy cover traffic injection.

ALTER TABLE organizations ADD COLUMN IF NOT EXISTS default_daita_mode VARCHAR(32) NOT NULL DEFAULT 'off' CHECK (default_daita_mode IN ('off', 'balanced', 'paranoid'));

ALTER TABLE nodes ADD COLUMN IF NOT EXISTS daita_mode VARCHAR(32) NOT NULL DEFAULT 'off' CHECK (daita_mode IN ('off', 'balanced', 'paranoid'));

CREATE INDEX IF NOT EXISTS idx_nodes_daita_mode ON nodes(daita_mode);
CREATE INDEX IF NOT EXISTS idx_organizations_default_daita_mode ON organizations(default_daita_mode);
