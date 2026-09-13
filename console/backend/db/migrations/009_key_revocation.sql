-- ============================================================================
-- Migration 009: Key revocation
-- ============================================================================
--
-- Revoking a peering agreement set a database row to 'revoked' and broadcast an
-- event to the console. Nothing reached the data plane: an established tunnel
-- survived it, and the withdrawn device stayed reachable. HeartbeatResponse has
-- carried a revoked_keys field since the protocol was written and it was always
-- empty, with no consumer on the node either.
--
-- Revocations are delivered to every node for a retention window rather than
-- tracked per node. That is deliberate: applying the same revocation twice is
-- harmless, so a stateless window is idempotent and survives a node being offline,
-- where a per-node cursor would need to be stored, replicated, and reconciled after
-- a control plane failover. Beyond the window a node has re-synced its ACL policy
-- anyway, and a revoked peer is no longer in it.

CREATE TABLE IF NOT EXISTS revoked_keys (
    public_key_hex VARCHAR(64) PRIMARY KEY,
    node_id VARCHAR(64),
    reason VARCHAR(64) NOT NULL DEFAULT 'manual',
    revoked_by VARCHAR(64),
    revoked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_revoked_keys_expiry ON revoked_keys(expires_at);
