-- T0 P1: the control plane's authority over node transports (ADR 0022).
--
-- The installation ceiling is operator configuration (SOVEREIGN_TRANSPORT_CEILING),
-- not a row: an organisation administrator must not be able to raise it. What is
-- stored here is the last ceiling the netmap was built under, so a restart with a new
-- ceiling moves the netmap version instead of answering "unchanged".

-- Relays the installation runs. A node may only be sent, and may only report, a relay
-- listed and enabled here. The credential is the relay's service identity towards the
-- admission snapshot; only its SHA-256 is kept.
CREATE TABLE IF NOT EXISTS transport_relays (
    relay_id VARCHAR(63) PRIMARY KEY CHECK (relay_id ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
    url TEXT NOT NULL CHECK (url LIKE 'https://%' AND length(url) <= 512),
    capability VARCHAR(32) NOT NULL DEFAULT 'derp-v2' CHECK (capability = 'derp-v2'),
    credential_hash CHAR(64) NOT NULL UNIQUE CHECK (credential_hash ~ '^[0-9a-f]{64}$'),
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_by VARCHAR(64),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    credential_rotated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- NULL is "not configured", which is UDP only: the behaviour before this migration.
ALTER TABLE organizations
    ADD COLUMN IF NOT EXISTS allowed_transports TEXT[]
        CHECK (allowed_transports IS NULL OR allowed_transports <@ ARRAY['udp', 'derp']::TEXT[]);

-- What the node's binary carries, as declared at registration (proven key possession).
-- Only known values are stored. A node with no capability is legacy: UDP only, and it
-- cannot enforce a transport ban.
ALTER TABLE nodes
    ADD COLUMN IF NOT EXISTS transports_built TEXT[] NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS node_capabilities TEXT[] NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS relay_homes JSONB NOT NULL DEFAULT '[]'::jsonb
        CHECK (jsonb_typeof(relay_homes) = 'array' AND jsonb_array_length(relay_homes) <= 2),
    ADD COLUMN IF NOT EXISTS relay_homes_reported_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_nodes_relay_homes_reported
    ON nodes (relay_homes_reported_at)
    WHERE relay_homes_reported_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS transport_policy_state (
    singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
    applied_ceiling TEXT[] NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
