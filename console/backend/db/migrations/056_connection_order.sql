-- Connection order by scope (ADR 0037).
--
-- An order is an ordered list of access methods; `forced` means "only the first". The
-- organisation's ceiling is organizations.allowed_access_methods (migration 055). NULL
-- order means "inherit" (the organisation's NULL is the built-in Automatico order).
-- Resolution is done by the console (ConnectionOrderResolver), not in SQL.

-- Organisation: base order, forced flag, and whether members may choose for their own devices.
ALTER TABLE organizations
    ADD COLUMN IF NOT EXISTS connection_order TEXT[]
        CHECK (connection_order IS NULL OR (cardinality(connection_order) BETWEEN 1 AND 3
               AND connection_order <@ ARRAY['wireguard', 'wireguard-wss', 'amneziawg']::TEXT[]));
ALTER TABLE organizations
    ADD COLUMN IF NOT EXISTS connection_forced BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE organizations
    ADD COLUMN IF NOT EXISTS members_choose_connection BOOLEAN NOT NULL DEFAULT FALSE;

-- Line (compartment): inherit (NULL) or its own subset; `locked` stops members overriding it.
ALTER TABLE compartments
    ADD COLUMN IF NOT EXISTS connection_order TEXT[]
        CHECK (connection_order IS NULL OR (cardinality(connection_order) BETWEEN 1 AND 3
               AND connection_order <@ ARRAY['wireguard', 'wireguard-wss', 'amneziawg']::TEXT[]));
ALTER TABLE compartments
    ADD COLUMN IF NOT EXISTS connection_forced BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE compartments
    ADD COLUMN IF NOT EXISTS connection_locked BOOLEAN NOT NULL DEFAULT FALSE;

-- Device: inherit (NULL), its own order, or forced single. `connection_owner_set` records that the
-- owner (not an administrator) made the setting, so it outranks the owner's person-level default.
ALTER TABLE nodes
    ADD COLUMN IF NOT EXISTS connection_order TEXT[]
        CHECK (connection_order IS NULL OR (cardinality(connection_order) BETWEEN 1 AND 3
               AND connection_order <@ ARRAY['wireguard', 'wireguard-wss', 'amneziawg']::TEXT[]));
ALTER TABLE nodes
    ADD COLUMN IF NOT EXISTS connection_forced BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE nodes
    ADD COLUMN IF NOT EXISTS connection_locked BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE nodes
    ADD COLUMN IF NOT EXISTS connection_owner_set BOOLEAN NOT NULL DEFAULT FALSE;

-- Person: the default for their own devices, used only while the organisation lets members choose.
CREATE TABLE IF NOT EXISTS user_connection_orders (
    user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    organization_id VARCHAR(64) NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    connection_order TEXT[] NOT NULL
        CHECK (cardinality(connection_order) BETWEEN 1 AND 3
               AND connection_order <@ ARRAY['wireguard', 'wireguard-wss', 'amneziawg']::TEXT[]),
    connection_forced BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, organization_id)
);
