-- ============================================================================
-- Migration 008: Subnet routes
-- ============================================================================
--
-- Routes had no storage and /v4/control/sync-routes did not exist, so a node could
-- never learn that a subnet was reachable through a peer. pkg/routes models
-- failover across several gateway nodes; none of it was reachable from a deployment.
--
-- routing_peers is stored as JSON rather than a join table: the set is small, always
-- read whole, and is rewritten as a unit when an operator changes the gateways for a
-- route. A join table would add a second write path for no query that needs one.

CREATE TABLE IF NOT EXISTS network_routes (
    id VARCHAR(64) PRIMARY KEY,
    network_id VARCHAR(64) NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    network_cidr VARCHAR(64) NOT NULL,
    masquerade BOOLEAN NOT NULL DEFAULT TRUE,
    failover_mode VARCHAR(24) NOT NULL DEFAULT 'ACTIVE_PASSIVE'
        CHECK (failover_mode IN ('ACTIVE_PASSIVE', 'ACTIVE_ACTIVE_ECMP')),
    routing_peers JSONB NOT NULL DEFAULT '[]'::jsonb,
    groups JSONB NOT NULL DEFAULT '[]'::jsonb,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_network_routes_enabled ON network_routes(enabled);
CREATE INDEX IF NOT EXISTS idx_network_routes_network ON network_routes(network_id);
