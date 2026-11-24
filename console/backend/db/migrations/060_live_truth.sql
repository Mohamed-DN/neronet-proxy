-- Location and round trip tell the truth (ADR 0042).
--
-- 1. LOCATION. nodes.country_code defaulted to 'US' and several writers added their own
--    'US' / Washington / Frankfurt fallbacks, so a device whose position nothing had ever
--    measured or stated was shown in the United States. Unknown is now NULL. The only
--    sources are an owner/admin ('declared') and the node operator's explicit setting
--    ('agent'); location_source records which.
--
-- 2. ROUND TRIP. nodes.latency_ms is the gateway's HTTP heartbeat round trip to the
--    console, not a device's response time, and a profile device has none. The serving
--    gateway now pings the device through its netstack: value, time of the sample and
--    method are stored. rtt_ms NULL with a sample time means "pinged, no reply".
--
-- 3. CONNECTION TEST. probe_requests holds one on-demand ping asked from the console,
--    delivered to the serving gateway and answered by it.
--
-- Reversible note: this file only widens (DROP NOT NULL / DROP DEFAULT) and adds columns
-- and a table. To go back: ALTER COLUMN country_code SET DEFAULT 'US'; the cleared values
-- cannot be restored, because they were never information. Idempotent: re-running it
-- clears nothing it did not clear the first time.

ALTER TABLE nodes ALTER COLUMN country_code DROP DEFAULT;
ALTER TABLE nodes ALTER COLUMN country_code DROP NOT NULL;

-- The telemetry history had the same default; a telemetry sample that names no country says so.
ALTER TABLE node_telemetry_history ALTER COLUMN country_code DROP DEFAULT;
ALTER TABLE node_telemetry_history ALTER COLUMN country_code DROP NOT NULL;

ALTER TABLE nodes ADD COLUMN IF NOT EXISTS location_source VARCHAR(16)
    CHECK (location_source IS NULL OR location_source IN ('declared', 'agent'));
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS rtt_ms REAL
    CHECK (rtt_ms IS NULL OR (rtt_ms >= 0 AND rtt_ms <= 60000));
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS rtt_measured_at TIMESTAMPTZ;
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS rtt_method VARCHAR(16)
    CHECK (rtt_method IS NULL OR rtt_method IN ('icmp'));

-- Coordinates a node operator stated were recorded in metadata until now. They are the
-- 'agent' source; the column replaces the metadata key.
UPDATE nodes SET location_source = 'agent'
 WHERE location_source IS NULL AND metadata ->> 'location_source' = 'declared';

-- What was written by a default is not information, and is cleared. Nothing that an
-- owner/admin or an operator stated is touched.
--
-- (a) Profile devices: the row was created with the column default.
UPDATE nodes SET country_code = NULL
 WHERE device_kind = 'profile' AND country_code = 'US' AND location_source IS NULL;

-- (b) Rows carrying the two coordinates the console invented when a node was created by
--     hand (Washington for 'US', Frankfurt for anything else). The coordinates go. The
--     country goes only when it is 'US': that is the value the same code substituted when
--     none was given; a different country was typed by whoever created the node.
UPDATE nodes SET
       country_code = CASE WHEN country_code = 'US' THEN NULL ELSE country_code END,
       latitude = NULL,
       longitude = NULL
 WHERE location_source IS NULL
   AND ((ABS(latitude - 38.9072) < 0.001 AND ABS(longitude + 77.0369) < 0.001)
     OR (ABS(latitude - 50.1109) < 0.001 AND ABS(longitude - 8.6821) < 0.001));

-- (c) Nodes that enrolled themselves: the Go agent's -country flag defaulted to 'US', so a
--     'US' with no declared source cannot be told from a deliberate one and is cleared;
--     the next registration sets it again if the operator configured it explicitly. Any
--     other value had to be configured, so it is kept and attributed to the agent.
UPDATE nodes SET country_code = NULL
 WHERE device_kind <> 'profile' AND country_code = 'US' AND location_source IS NULL;
UPDATE nodes SET location_source = 'agent'
 WHERE device_kind <> 'profile' AND country_code IS NOT NULL AND location_source IS NULL
   AND id LIKE 'pk\_%' ESCAPE '\';

-- A value that is not two letters is not a country. Lower case is repaired, the rest cleared.
UPDATE nodes SET country_code = UPPER(country_code) WHERE country_code ~ '^[a-z]{2}$';
UPDATE nodes SET country_code = NULL WHERE country_code IS NOT NULL AND country_code !~ '^[A-Z]{2}$';

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'nodes_country_code_iso') THEN
        ALTER TABLE nodes ADD CONSTRAINT nodes_country_code_iso
            CHECK (country_code IS NULL OR country_code ~ '^[A-Z]{2}$');
    END IF;
END $$;

-- One on-demand ping from the console to a profile device, through its serving gateway.
CREATE TABLE IF NOT EXISTS probe_requests (
    id VARCHAR(64) PRIMARY KEY,
    device_id VARCHAR(64) NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    gateway_id VARCHAR(64) NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    organization_id VARCHAR(64) NOT NULL,
    requested_by VARCHAR(64),
    state VARCHAR(16) NOT NULL DEFAULT 'pending'
        CHECK (state IN ('pending', 'delivered', 'done', 'expired')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    answered_at TIMESTAMPTZ,
    replied BOOLEAN,
    rtt_ms REAL CHECK (rtt_ms IS NULL OR (rtt_ms >= 0 AND rtt_ms <= 60000))
);
-- One live request per device: a second ask returns the first.
CREATE UNIQUE INDEX IF NOT EXISTS probe_requests_one_live_per_device
    ON probe_requests (device_id) WHERE state IN ('pending', 'delivered');
CREATE INDEX IF NOT EXISTS probe_requests_gateway_live
    ON probe_requests (gateway_id) WHERE state IN ('pending', 'delivered');
