-- Several profile gateways per organisation (study GATEWAY-PER-UTENTE-NOV12, option B).
--
-- 046 allowed one gateway per organisation. An organisation with two sites, or a gateway
-- under maintenance, needs more: any number of its mesh nodes may now serve profile
-- devices (profile_gateway_endpoint set), exactly one of them the default, and each
-- profile device names the gateway that serves it. Its profile has that gateway as its
-- only peer, so moving a device means importing its profile again.

DROP INDEX IF EXISTS idx_nodes_one_profile_gateway_per_org;

-- The gateway new devices join unless an administrator chooses another. A flag left on a
-- node whose endpoint was cleared means nothing: every reader checks both columns.
ALTER TABLE nodes
    ADD COLUMN IF NOT EXISTS is_default_profile_gateway BOOLEAN NOT NULL DEFAULT FALSE;

CREATE UNIQUE INDEX IF NOT EXISTS idx_nodes_one_default_profile_gateway_per_org
    ON nodes (COALESCE(organization_id, 'org-default'))
    WHERE is_default_profile_gateway AND profile_gateway_endpoint IS NOT NULL;

-- The gateway that serves a profile device. NULL means the organisation's default.
ALTER TABLE nodes
    ADD COLUMN IF NOT EXISTS gateway_node_id VARCHAR(64) REFERENCES nodes(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_nodes_gateway_node_id ON nodes (gateway_node_id) WHERE gateway_node_id IS NOT NULL;

-- Existing installs: the one gateway each organisation had becomes its default (046's
-- index guaranteed at most one), and every profile device stays on it.
UPDATE nodes g SET is_default_profile_gateway = TRUE
 WHERE g.profile_gateway_endpoint IS NOT NULL
   AND g.device_kind = 'mesh'
   AND NOT g.is_default_profile_gateway
   AND NOT EXISTS (
       SELECT 1 FROM nodes o
        WHERE o.is_default_profile_gateway AND o.profile_gateway_endpoint IS NOT NULL
          AND COALESCE(o.organization_id, 'org-default') = COALESCE(g.organization_id, 'org-default'));

UPDATE nodes d SET gateway_node_id = g.id
  FROM nodes g
 WHERE d.device_kind = 'profile'
   AND d.gateway_node_id IS NULL
   AND g.is_default_profile_gateway
   AND g.profile_gateway_endpoint IS NOT NULL
   AND g.device_kind = 'mesh'
   AND COALESCE(g.organization_id, 'org-default') = COALESCE(d.organization_id, 'org-default');
