-- ============================================================================
-- Migration 007: Zero-trust ACL rules and mesh epochs
-- ============================================================================
--
-- ACL rules had no storage. They existed as fixture data in the frontend, and
-- /v4/control/sync-acls did not exist, so pkg/acl -- which compiles and enforces
-- policy correctly -- was never handed anything. Every rule configured in the
-- console had no effect on any node.
--
-- Rules are authored against CIDRs. pkg/acl matches on an exact peer address
-- (CompiledFilterRule.AllowedPeerVIP, compared with net.IP.Equal), so the control
-- plane expands each rule into one entry per matching peer before delivery. That
-- expansion is what "compiled" means in CompiledPeerPolicy, and it is why the policy
-- changes when the fleet changes, not only when the rules do.

CREATE TABLE IF NOT EXISTS acl_rules (
    id VARCHAR(64) PRIMARY KEY,
    priority INTEGER NOT NULL DEFAULT 100,
    source_cidr VARCHAR(64) NOT NULL DEFAULT '0.0.0.0/0',
    destination_cidr VARCHAR(64) NOT NULL DEFAULT '0.0.0.0/0',
    protocol VARCHAR(8) NOT NULL DEFAULT 'ALL' CHECK (protocol IN ('TCP', 'UDP', 'ICMP', 'ALL')),
    port_start INTEGER NOT NULL DEFAULT 0,
    port_end INTEGER NOT NULL DEFAULT 65535,
    action VARCHAR(8) NOT NULL DEFAULT 'ACCEPT' CHECK (action IN ('ACCEPT', 'DROP')),
    description TEXT NOT NULL DEFAULT '',
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_acl_rules_priority ON acl_rules(priority, id);
CREATE INDEX IF NOT EXISTS idx_acl_rules_enabled ON acl_rules(enabled);

-- Monotonic counters nodes compare against to decide whether to re-fetch.
--
-- A node sends the epoch it holds; an unchanged epoch means the control plane can
-- answer without compiling or transferring a policy at all. At fleet scale that is
-- the difference between every node pulling a full policy every 15 seconds and
-- almost none of them doing so.
CREATE TABLE IF NOT EXISTS mesh_epochs (
    name VARCHAR(32) PRIMARY KEY,
    epoch BIGINT NOT NULL DEFAULT 1,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO mesh_epochs (name, epoch) VALUES ('acl', 1) ON CONFLICT (name) DO NOTHING;
INSERT INTO mesh_epochs (name, epoch) VALUES ('routes', 1) ON CONFLICT (name) DO NOTHING;
