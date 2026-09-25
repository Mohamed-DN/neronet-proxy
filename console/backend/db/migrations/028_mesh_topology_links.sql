-- ============================================================================
-- Migration 028: Mesh Topology Link Overrides & Visibility
-- ============================================================================

CREATE TABLE IF NOT EXISTS mesh_link_configs (
    id VARCHAR(64) PRIMARY KEY,
    source_node_id VARCHAR(64) NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    target_node_id VARCHAR(64) NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    mode VARCHAR(32) NOT NULL DEFAULT 'direct' CHECK (mode IN ('direct', 'derp', 'openvpn', 'onion')),
    relay_id VARCHAR(64) DEFAULT NULL,
    is_visible BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_mesh_link_pair UNIQUE (source_node_id, target_node_id)
);

CREATE INDEX IF NOT EXISTS idx_mesh_link_configs_src ON mesh_link_configs(source_node_id);
CREATE INDEX IF NOT EXISTS idx_mesh_link_configs_dst ON mesh_link_configs(target_node_id);
