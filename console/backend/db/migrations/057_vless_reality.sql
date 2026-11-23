-- The vless-reality access method (ADR 0036): VLESS + REALITY + XTLS-Vision, terminated by Xray on
-- the profile gateway, for heavily censored networks. Each device is one Xray user.

-- A device's VLESS user id: random, one per device, revoked with the device (the row goes, the
-- gateway stops listing it). Only the gateway's netmap and the answer to the person who just
-- added the device carry it.
ALTER TABLE nodes
    ADD COLUMN IF NOT EXISTS vless_uuid UUID;
CREATE UNIQUE INDEX IF NOT EXISTS idx_nodes_vless_uuid ON nodes (vless_uuid) WHERE vless_uuid IS NOT NULL;

-- The public TCP port of the gateway's VLESS terminator, reported at registration with capability
-- vless-v1. The host is never reported: it is the host of the endpoint an administrator named for
-- the gateway, as for AmneziaWG.
ALTER TABLE nodes
    ADD COLUMN IF NOT EXISTS vless_port INTEGER
        CHECK (vless_port IS NULL OR (vless_port BETWEEN 1 AND 65535));

-- The organisation's REALITY parameters: X25519 private and public key, short ids, the fallback
-- target and server names. Generated at random by the console the first time an administrator
-- turns the method on; NULL until then. The private key is a secret of the same kind as a node
-- key: never logged, never shown after generation, sent only to the organisation's own gateway.
-- The public key and a short id go into the link of each device.
ALTER TABLE organizations
    ADD COLUMN IF NOT EXISTS vless_params JSONB
        CHECK (vless_params IS NULL OR jsonb_typeof(vless_params) = 'object');

-- The method value, in every place that lists the methods. Dropped by name and re-added so the
-- migration can run again.
ALTER TABLE nodes DROP CONSTRAINT IF EXISTS nodes_access_method_check;
ALTER TABLE nodes
    ADD CONSTRAINT nodes_access_method_check
        CHECK (access_method IN ('wireguard', 'wireguard-wss', 'amneziawg', 'vless-reality'));
-- The column is VARCHAR(16): 'vless-reality' is 13 characters, 'wireguard-wss' 13. Nothing to widen.

ALTER TABLE organizations DROP CONSTRAINT IF EXISTS organizations_allowed_access_methods_check;
ALTER TABLE organizations
    ADD CONSTRAINT organizations_allowed_access_methods_check
        CHECK (allowed_access_methods <@ ARRAY['wireguard', 'wireguard-wss', 'amneziawg', 'vless-reality']::TEXT[]
               AND 'wireguard' = ANY (allowed_access_methods));

-- Connection orders (migration 056) may now name it, and hold four methods.
ALTER TABLE organizations DROP CONSTRAINT IF EXISTS organizations_connection_order_check;
ALTER TABLE organizations
    ADD CONSTRAINT organizations_connection_order_check
        CHECK (connection_order IS NULL OR (cardinality(connection_order) BETWEEN 1 AND 4
               AND connection_order <@ ARRAY['wireguard', 'wireguard-wss', 'amneziawg', 'vless-reality']::TEXT[]));

ALTER TABLE compartments DROP CONSTRAINT IF EXISTS compartments_connection_order_check;
ALTER TABLE compartments
    ADD CONSTRAINT compartments_connection_order_check
        CHECK (connection_order IS NULL OR (cardinality(connection_order) BETWEEN 1 AND 4
               AND connection_order <@ ARRAY['wireguard', 'wireguard-wss', 'amneziawg', 'vless-reality']::TEXT[]));

ALTER TABLE nodes DROP CONSTRAINT IF EXISTS nodes_connection_order_check;
ALTER TABLE nodes
    ADD CONSTRAINT nodes_connection_order_check
        CHECK (connection_order IS NULL OR (cardinality(connection_order) BETWEEN 1 AND 4
               AND connection_order <@ ARRAY['wireguard', 'wireguard-wss', 'amneziawg', 'vless-reality']::TEXT[]));

ALTER TABLE user_connection_orders DROP CONSTRAINT IF EXISTS user_connection_orders_connection_order_check;
ALTER TABLE user_connection_orders
    ADD CONSTRAINT user_connection_orders_connection_order_check
        CHECK (cardinality(connection_order) BETWEEN 1 AND 4
               AND connection_order <@ ARRAY['wireguard', 'wireguard-wss', 'amneziawg', 'vless-reality']::TEXT[]);
