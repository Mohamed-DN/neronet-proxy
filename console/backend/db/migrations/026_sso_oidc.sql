-- Migration 026: SSO OIDC Configuration and Group-to-Role Mapping (WP-303)
--
-- Enables enterprise OpenID Connect single sign-on with per-organization IdP
-- configuration, standard OAuth2 PKCE authorization flows, group claim mapping
-- to NeroNet roles (super-admin, admin, network_admin, auditor, member), and
-- link to user identities for automatic provisioning and IdP-driven session deactivation.

CREATE TABLE IF NOT EXISTS organization_oidc_configs (
    id                VARCHAR(64) PRIMARY KEY,
    organization_id   VARCHAR(64) NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    issuer_url        TEXT NOT NULL,
    client_id         VARCHAR(255) NOT NULL,
    client_secret     TEXT NOT NULL,
    group_mappings    JSONB NOT NULL DEFAULT '{}'::jsonb,
    default_role      VARCHAR(32) NOT NULL DEFAULT 'member',
    enabled           BOOLEAN NOT NULL DEFAULT TRUE,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_org_oidc UNIQUE (organization_id)
);

CREATE INDEX IF NOT EXISTS idx_org_oidc_org_id ON organization_oidc_configs(organization_id);

-- Link local user accounts with external OIDC subject identity
ALTER TABLE users ADD COLUMN IF NOT EXISTS oidc_sub VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS oidc_idp_id VARCHAR(64);

CREATE INDEX IF NOT EXISTS idx_users_oidc_sub ON users(oidc_sub) WHERE oidc_sub IS NOT NULL;
