-- Migration 019: Compartments (L2 Logical Mesh Segregation) & Hidden Duress Compartments
-- Implements OCI/AWS Compartment/VPC Isolation and Plausible Deniability Ghost Compartments

-- 1. Create compartments table
CREATE TABLE IF NOT EXISTS compartments (
    id VARCHAR(64) PRIMARY KEY,
    organization_id VARCHAR(64) NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name VARCHAR(128) NOT NULL,
    slug VARCHAR(128) NOT NULL,
    subnet_cidr VARCHAR(45) NOT NULL DEFAULT '100.64.0.0/24',
    is_hidden BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (organization_id, slug)
);

CREATE INDEX IF NOT EXISTS idx_compartments_org ON compartments(organization_id);
CREATE INDEX IF NOT EXISTS idx_compartments_hidden ON compartments(is_hidden);

-- 2. Add multi-tier duress password columns to users
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash_root VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash_stealth_wipe VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash_nuclear_wipe VARCHAR(255);

-- 3. Add compartment_id column to nodes
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS compartment_id VARCHAR(64) REFERENCES compartments(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_nodes_compartment ON nodes(compartment_id);

-- 3. Seed default compartments for existing organizations
INSERT INTO compartments (id, organization_id, name, slug, subnet_cidr, is_hidden)
SELECT 'cmp-' || id, id, 'Default Compartment', 'default', '100.64.0.0/24', FALSE
FROM organizations
ON CONFLICT (id) DO NOTHING;

-- 4. Backfill existing nodes to their organization default compartment
UPDATE nodes
SET compartment_id = 'cmp-' || organization_id
WHERE compartment_id IS NULL AND organization_id IS NOT NULL;

-- 5. Create compartment_peerings table (VPC mesh peering rules)
CREATE TABLE IF NOT EXISTS compartment_peerings (
    id VARCHAR(64) PRIMARY KEY,
    organization_id VARCHAR(64) NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    src_compartment_id VARCHAR(64) NOT NULL REFERENCES compartments(id) ON DELETE CASCADE,
    dst_compartment_id VARCHAR(64) NOT NULL REFERENCES compartments(id) ON DELETE CASCADE,
    policy VARCHAR(32) NOT NULL DEFAULT 'allow' CHECK (policy IN ('allow', 'deny')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (src_compartment_id, dst_compartment_id)
);

CREATE INDEX IF NOT EXISTS idx_compartment_peerings_org ON compartment_peerings(organization_id);
