-- ============================================================================
-- NeroNet Sovereign Mesh Enterprise Management Console
-- Migration 014: Drop dead feature tables removed in WP-006
-- ============================================================================
--
-- Safety guard: refuse to drop any table that contains rows. If data is present,
-- raise an exception so an administrator must inspect and purge manually.

DO $$
DECLARE
    cnt BIGINT;
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'app_share_links') THEN
        EXECUTE 'SELECT count(*) FROM app_share_links' INTO cnt;
        IF cnt > 0 THEN
            RAISE EXCEPTION 'Refusing to drop app_share_links: table contains % row(s)', cnt;
        END IF;
    END IF;

    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'app_bundles') THEN
        EXECUTE 'SELECT count(*) FROM app_bundles' INTO cnt;
        IF cnt > 0 THEN
            RAISE EXCEPTION 'Refusing to drop app_bundles: table contains % row(s)', cnt;
        END IF;
    END IF;

    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'nerodrop_sessions') THEN
        EXECUTE 'SELECT count(*) FROM nerodrop_sessions' INTO cnt;
        IF cnt > 0 THEN
            RAISE EXCEPTION 'Refusing to drop nerodrop_sessions: table contains % row(s)', cnt;
        END IF;
    END IF;
END $$;

DROP TABLE IF EXISTS app_share_links CASCADE;
DROP TABLE IF EXISTS app_bundles CASCADE;
DROP TABLE IF EXISTS nerodrop_sessions CASCADE;
