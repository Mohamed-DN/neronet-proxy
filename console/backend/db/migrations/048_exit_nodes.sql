-- ADR 0032 phase 1: exit nodes for profile devices.
--
-- A profile device may send all its traffic through an exit: its organisation's gateway
-- or a mesh node started as an exit (role EXIT_BRIDGE or HYBRID). NULL means no exit, and
-- the gateway drops the device's internet-bound packets.
ALTER TABLE nodes
    ADD COLUMN IF NOT EXISTS exit_node_id VARCHAR(64) REFERENCES nodes(id) ON DELETE SET NULL;

-- Whether the device may reach the exit's private networks (RFC 1918, unique-local IPv6).
-- Off by default; only an administrator turns it on. Loopback, link-local and the cloud
-- metadata address are never reachable, whatever this says.
ALTER TABLE nodes
    ADD COLUMN IF NOT EXISTS exit_allow_lan BOOLEAN NOT NULL DEFAULT FALSE;

-- Who may choose an exit for a device: administrators always; the device's owner too when
-- the organisation turns this on. The hook ADR 0030's `devices.exit.set` will replace.
ALTER TABLE organizations
    ADD COLUMN IF NOT EXISTS exit_self_service BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_nodes_exit_node_id ON nodes (exit_node_id) WHERE exit_node_id IS NOT NULL;
