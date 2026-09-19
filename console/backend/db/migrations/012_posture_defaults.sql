-- ============================================================================
-- Migration 012: posture and IP class stop defaulting to fabricated values
-- ============================================================================
--
-- Numbering: the work package assigned 010, but 010_nodes_fillfactor.sql and
-- 011_remove_tiering.sql are already on main and must not be edited. 012 is the
-- next free number.
--
-- nodes.posture_checks defaulted to
--   {"compliant": true, "disk_encrypted": true, "os": "Linux"}
-- so every row inserted without an explicit value asserted that the host was
-- compliant, its disk encrypted and its operating system known. Nothing measured
-- any of it, and the heartbeat handler did not write the column, so that default
-- was the value the console reported for the entire fleet.
--
-- nodes.ip_class defaulted to RESIDENTIAL for the same reason: it is a property
-- nothing determines. UNKNOWN is already in the column's CHECK constraint.
--
-- Rows are reset only when they hold exactly the old fabricated default. jsonb
-- equality ignores key order, so this matches the value however it was written.
-- A row carrying anything else -- a real measurement, or an operator's entry -- is
-- left alone. Existing ip_class values are not rewritten: unlike the posture
-- default they may have been set deliberately, and this migration cannot tell the
-- two apart.

ALTER TABLE nodes ALTER COLUMN posture_checks SET DEFAULT '{}'::jsonb;
ALTER TABLE nodes ALTER COLUMN ip_class SET DEFAULT 'UNKNOWN';

UPDATE nodes
   SET posture_checks = '{}'::jsonb
 WHERE posture_checks = '{"compliant": true, "disk_encrypted": true, "os": "Linux"}'::jsonb;
