-- Migration 029: identity provider refresh token for OIDC accounts
--
-- A console session refresh redeems this token at the organisation's identity
-- provider. A provider that refuses it (invalid_grant) has deactivated the user, and
-- the local account is suspended. Before this, "deactivation on the IdP" was only
-- ever checked against an in-memory test fixture.
--
-- Stored as issued. Its audience is this console's OIDC client, so on its own it
-- grants nothing beyond signing in here; it goes with the client secret already held
-- in organization_oidc_configs.

ALTER TABLE users ADD COLUMN IF NOT EXISTS oidc_refresh_token TEXT;

-- Accounts are found by (provider, subject), never by e-mail, and one identity maps
-- to one account.
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_oidc_identity ON users(oidc_idp_id, oidc_sub) WHERE oidc_sub IS NOT NULL;
