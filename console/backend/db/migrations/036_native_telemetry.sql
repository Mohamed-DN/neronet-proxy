-- One current, server-issued observation session per enrolled node. The legacy
-- heartbeat buffer never owns this watermark or these cumulative byte counters.
CREATE TABLE IF NOT EXISTS node_native_telemetry (
    node_id TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
    session_id UUID NOT NULL,
    organization_id TEXT NOT NULL,
    user_id TEXT,
    sequence NUMERIC(20, 0),
    counter_epoch NUMERIC(20, 0),
    source TEXT,
    traffic_available BOOLEAN,
    rx_bytes NUMERIC(20, 0),
    tx_bytes NUMERIC(20, 0),
    memory_runtime_sys_bytes NUMERIC(20, 0),
    payload_hash TEXT,
    received_at TIMESTAMPTZ,
    CHECK (sequence BETWEEN 1 AND 18446744073709551615),
    CHECK (counter_epoch BETWEEN 1 AND 18446744073709551615),
    CHECK (rx_bytes BETWEEN 0 AND 18446744073709551615),
    CHECK (tx_bytes BETWEEN 0 AND 18446744073709551615),
    CHECK (memory_runtime_sys_bytes BETWEEN 0 AND 18446744073709551615)
);
