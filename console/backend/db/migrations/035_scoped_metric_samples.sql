-- Legacy system_metrics has no attributable node or tenant. Preserve it, but
-- start scoped history from actual new samples rather than invent a backfill.
CREATE TABLE node_metric_samples (
    sampled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    node_id VARCHAR(64) NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    organization_id TEXT NOT NULL,
    user_id VARCHAR(64),
    is_hidden BOOLEAN NOT NULL,
    is_live BOOLEAN NOT NULL,
    is_quarantined BOOLEAN NOT NULL,
    rx_bytes BIGINT NOT NULL,
    tx_bytes BIGINT NOT NULL,
    cpu_usage_pct REAL,
    memory_usage_pct REAL,
    PRIMARY KEY (sampled_at, node_id)
);
CREATE INDEX node_metric_samples_scope_time ON node_metric_samples (organization_id, sampled_at DESC);
CREATE INDEX node_metric_samples_source_time ON node_metric_samples (node_id, sampled_at);
