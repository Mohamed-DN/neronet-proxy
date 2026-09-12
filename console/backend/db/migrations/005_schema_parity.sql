-- ============================================================================
-- NeroNet Sovereign Mesh Enterprise Management Console
-- Migration 005: Align the PostgreSQL schema with the SQLite schema and the code
-- ============================================================================
--
-- The two schemas are maintained by hand in separate files and had drifted. The
-- application reads metadata_json and webrtc_signal_json -- the SQLite spelling --
-- so the PostgreSQL columns named metadata and webrtc_signal were unreachable:
-- every query touching them worked on SQLite and returned nothing on PostgreSQL.
-- routes/stats.js already carried a defensive `r.metadata || r.metadata_json`,
-- which is what working around this drift looks like before anyone names it.
--
-- Migration 001 now declares the aligned names for fresh databases; this migration
-- brings existing ones across.

-- 1. audit_events.metadata -> metadata_json
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'audit_events' AND column_name = 'metadata'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'audit_events' AND column_name = 'metadata_json'
  ) THEN
    ALTER TABLE audit_events RENAME COLUMN metadata TO metadata_json;
  END IF;
END;
$$;

-- 2. nerodrop_sessions.webrtc_signal -> webrtc_signal_json
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'nerodrop_sessions' AND column_name = 'webrtc_signal'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'nerodrop_sessions' AND column_name = 'webrtc_signal_json'
  ) THEN
    ALTER TABLE nerodrop_sessions RENAME COLUMN webrtc_signal TO webrtc_signal_json;
  END IF;
END;
$$;

-- 3. Remove the shared default OTP secret.
--
--    A column default is the worst place for a credential: every row created without
--    an explicit value silently shares the same secret, and the value is committed in
--    the schema. Callers must now supply one.
ALTER TABLE custom_domains ALTER COLUMN otp_secret DROP DEFAULT;
