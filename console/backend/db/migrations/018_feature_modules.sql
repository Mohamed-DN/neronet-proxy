-- Migration 018: Feature Module Isolation & Organization Profiles
-- Implements ADR 0020 (WP-107)

-- 1. Add profile column to organizations
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS profile VARCHAR(32) NOT NULL DEFAULT 'standard' CHECK (profile IN ('standard', 'regulated'));

-- 2. Create organization_modules table
CREATE TABLE IF NOT EXISTS organization_modules (
    organization_id VARCHAR(64) NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    module_id VARCHAR(64) NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (organization_id, module_id)
);

CREATE INDEX IF NOT EXISTS idx_org_modules_org ON organization_modules(organization_id);

-- 3. Seed default enabled modules for org-default and existing orgs
INSERT INTO organization_modules (organization_id, module_id, enabled)
SELECT id, m.module_id, TRUE
FROM organizations
CROSS JOIN (
    SELECT 'nuke' AS module_id UNION ALL
    SELECT 'deniability' UNION ALL
    SELECT 'onion'
) m
ON CONFLICT (organization_id, module_id) DO NOTHING;
