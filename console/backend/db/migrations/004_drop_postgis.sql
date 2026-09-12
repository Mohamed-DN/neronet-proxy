-- ============================================================================
-- NeroNet Sovereign Mesh Enterprise Management Console
-- Migration 004: Remove PostGIS, replace geometry with plain coordinates
-- ============================================================================
--
-- Migration 001 declared the postgis extension, a GEOMETRY(Point, 4326) column on
-- nodes, and a GiST index over it. No query in the codebase ever referenced any of
-- them: geo-fencing policies match on country_code, and impossible-travel detection
-- computes Haversine distance in RiskEngine over node_telemetry_history. The column
-- was never written and never read.
--
-- What it did cost: a PostGIS-specific base image, a PostgreSQL schema that could
-- not be mirrored in the SQLite path, and tests that asserted the presence of DDL
-- text instead of exercising a query. Spatial indexing earns its keep at millions of
-- rows with polygon predicates; this fleet is three orders of magnitude away.
--
-- The replacement for spatial work, if it is ever needed, is a bounding-box
-- prefilter over the columns below followed by exact Haversine. Same answers, same
-- code on both database backends, no extension.
--
-- Written to be safe on a database where 001 already ran and on one where it did not.

-- 1. Coordinates as plain columns, mirroring the SQLite schema
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS latitude REAL;
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS longitude REAL;

-- 2. Carry over any coordinates that were written to the geometry column
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'nodes' AND column_name = 'location'
  ) THEN
    EXECUTE 'UPDATE nodes
               SET latitude  = COALESCE(latitude,  ST_Y(location::geometry)),
                   longitude = COALESCE(longitude, ST_X(location::geometry))
             WHERE location IS NOT NULL';
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Could not copy coordinates from the legacy location column: %', SQLERRM;
END;
$$;

-- 3. Drop the spatial index and column
DROP INDEX IF EXISTS idx_nodes_location_gix;
ALTER TABLE nodes DROP COLUMN IF EXISTS location;

-- 4. Index supporting bounding-box prefilters
CREATE INDEX IF NOT EXISTS idx_nodes_latlng ON nodes(latitude, longitude);

-- 5. Drop the extension.
--    Only succeeds once nothing depends on it; the guard keeps the migration from
--    failing on a database where something else still does.
DO $$
BEGIN
  DROP EXTENSION IF EXISTS postgis;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'postgis extension still has dependents, leaving it in place: %', SQLERRM;
END;
$$;
