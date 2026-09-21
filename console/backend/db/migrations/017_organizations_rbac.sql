-- Migration 017: Organizations, RBAC, and Tenant Isolation
-- Implements ADR 0019 (WP-106)

-- 1. Create organizations table
CREATE TABLE IF NOT EXISTS organizations (
    id VARCHAR(64) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    slug VARCHAR(255) NOT NULL UNIQUE,
    default_policy VARCHAR(32) NOT NULL DEFAULT 'deny' CHECK (default_policy IN ('open', 'deny')),
    max_netmap_staleness_seconds INT NOT NULL DEFAULT 300,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_organizations_slug ON organizations(slug);

-- 2. Create default organization if not exists
INSERT INTO organizations (id, name, slug, default_policy)
VALUES ('org-default', 'Default Organization', 'default-org', 'open')
ON CONFLICT (id) DO NOTHING;

-- 3. Add organization_id to users
ALTER TABLE users ADD COLUMN IF NOT EXISTS organization_id VARCHAR(64) REFERENCES organizations(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_users_org_id ON users(organization_id);

-- 4. Update users role check constraint to support enterprise roles
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('super-admin', 'user', 'owner', 'admin', 'network_admin', 'auditor', 'member'));

-- 5. Create memberships table
CREATE TABLE IF NOT EXISTS memberships (
    id VARCHAR(64) PRIMARY KEY,
    user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    organization_id VARCHAR(64) NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    role VARCHAR(32) NOT NULL CHECK (role IN ('owner', 'admin', 'network_admin', 'auditor', 'member')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, organization_id)
);

CREATE INDEX IF NOT EXISTS idx_memberships_user_id ON memberships(user_id);
CREATE INDEX IF NOT EXISTS idx_memberships_org_id ON memberships(organization_id);

-- 6. Add organization_id to tenant-owned tables
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS organization_id VARCHAR(64) REFERENCES organizations(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_nodes_org_id ON nodes(organization_id);

ALTER TABLE acl_rules ADD COLUMN IF NOT EXISTS organization_id VARCHAR(64) REFERENCES organizations(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_acl_rules_org_id ON acl_rules(organization_id);

ALTER TABLE preauth_keys ADD COLUMN IF NOT EXISTS organization_id VARCHAR(64) REFERENCES organizations(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_preauth_keys_org_id ON preauth_keys(organization_id);

-- 7. Backfill existing data
UPDATE users SET organization_id = 'org-default' WHERE organization_id IS NULL;

INSERT INTO memberships (id, user_id, organization_id, role)
SELECT 'mem-' || substr(md5(id || 'org-default'), 1, 12), id, 'org-default',
       CASE WHEN role = 'super-admin' THEN 'owner' ELSE 'member' END
FROM users
ON CONFLICT (user_id, organization_id) DO NOTHING;

UPDATE nodes n
SET organization_id = COALESCE((SELECT organization_id FROM users u WHERE u.id = n.user_id), 'org-default')
WHERE n.organization_id IS NULL;

UPDATE acl_rules a
SET organization_id = 'org-default'
WHERE a.organization_id IS NULL;

UPDATE preauth_keys p
SET organization_id = COALESCE((SELECT organization_id FROM users u WHERE u.id = p.owner_id), 'org-default')
WHERE p.organization_id IS NULL;
