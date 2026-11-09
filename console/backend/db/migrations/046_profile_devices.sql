-- ADR 0029 phase A: profile devices and the gateway that serves them.
--
-- A profile device is a node row like any other (overlay address, ACL, quarantine,
-- revocation, audit) whose WireGuard configuration is a static profile: it is reached
-- only through its organisation's gateway, with its own PSK, and never runs our node.
ALTER TABLE nodes
    ADD COLUMN IF NOT EXISTS device_kind VARCHAR(16) NOT NULL DEFAULT 'mesh'
        CHECK (device_kind IN ('mesh', 'profile'));

-- Set on the one mesh node per organisation that serves profile devices: the public
-- host:port a device's profile names as its peer endpoint.
ALTER TABLE nodes
    ADD COLUMN IF NOT EXISTS profile_gateway_endpoint VARCHAR(262)
        CHECK (profile_gateway_endpoint IS NULL OR profile_gateway_endpoint ~ '^[A-Za-z0-9.\[\]:-]{1,255}:[0-9]{1,5}$');

CREATE UNIQUE INDEX IF NOT EXISTS idx_nodes_one_profile_gateway_per_org
    ON nodes (COALESCE(organization_id, 'org-default'))
    WHERE profile_gateway_endpoint IS NOT NULL;
