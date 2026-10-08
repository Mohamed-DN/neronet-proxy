-- Preserve legacy samples without treating their unversioned counters as evidence.
ALTER TABLE node_metric_samples
  ADD COLUMN IF NOT EXISTS native_generation TEXT,
  ADD COLUMN IF NOT EXISTS native_sequence NUMERIC(20,0),
  ADD COLUMN IF NOT EXISTS native_received_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS native_status TEXT CHECK (native_status IN ('unknown','fresh','stale')),
  ADD COLUMN IF NOT EXISTS native_traffic_available BOOLEAN,
  ADD COLUMN IF NOT EXISTS native_rx_bytes NUMERIC(20,0) CHECK (native_rx_bytes BETWEEN 0 AND 18446744073709551615),
  ADD COLUMN IF NOT EXISTS native_tx_bytes NUMERIC(20,0) CHECK (native_tx_bytes BETWEEN 0 AND 18446744073709551615),
  ADD COLUMN IF NOT EXISTS native_memory_runtime_sys_bytes NUMERIC(20,0) CHECK (native_memory_runtime_sys_bytes BETWEEN 0 AND 18446744073709551615);
