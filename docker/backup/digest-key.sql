-- Row counts and checksums of the tables a restore must bring back, one line each:
--   name <TAB> rows <TAB> checksum
-- Run by `neronet-backup digest --scope key`; scripts/ops/restore.sh --verify runs it
-- against the restored copy and against the live database and compares the lines.
--
-- A checksum is the md5 of the sorted per-row md5 of the row as JSON. Row order does
-- not matter, and a column added by a later migration is covered without editing this
-- file. What is left out of a table is what changes while the system runs, because a
-- checksum of it could never match a database that is in use:
--   nodes   what a heartbeat writes (health, counters, posture, endpoints, load) and
--           what the risk engine recomputes
--   others  updated_at
-- The audit chain is compared as a prefix: events are only ever appended, so the live
-- chain up to the last event of the restored one must be identical. :audit_upto is
-- that last sequence number, or -1 for the whole chain.
\set ON_ERROR_STOP on
\pset format unaligned
\pset tuples_only on
\pset fieldsep '\t'
\pset footer off

SELECT 'schema:columns', count(*),
       md5(coalesce(string_agg(table_name || '.' || column_name || ':' || data_type, ',' ORDER BY table_name, ordinal_position), ''))
  FROM information_schema.columns WHERE table_schema = 'public';

SELECT 'schema:indexes', count(*), md5(coalesce(string_agg(indexdef, ',' ORDER BY indexname), ''))
  FROM pg_indexes WHERE schemaname = 'public';

SELECT 'nodes', count(*), md5(coalesce(string_agg(h, '' ORDER BY h), ''))
  FROM (SELECT md5((to_jsonb(t) - ARRAY[
          'is_healthy', 'last_heartbeat', 'latency_ms', 'tx_bytes', 'rx_bytes', 'cpu_usage_pct',
          'memory_usage_pct', 'battery_pct', 'posture_checks', 'endpoints', 'endpoints_bumped_at',
          'risk_score', 'last_geo_drift_at', 'updated_at'])::text) AS h FROM nodes t) s;

SELECT 'acl_rules', count(*), md5(coalesce(string_agg(h, '' ORDER BY h), ''))
  FROM (SELECT md5((to_jsonb(t) - 'updated_at')::text) AS h FROM acl_rules t) s;

SELECT 'compartments', count(*), md5(coalesce(string_agg(h, '' ORDER BY h), ''))
  FROM (SELECT md5((to_jsonb(t) - 'updated_at')::text) AS h FROM compartments t) s;

SELECT 'compartment_peerings', count(*), md5(coalesce(string_agg(h, '' ORDER BY h), ''))
  FROM (SELECT md5((to_jsonb(t) - 'updated_at')::text) AS h FROM compartment_peerings t) s;

SELECT 'organizations', count(*), md5(coalesce(string_agg(h, '' ORDER BY h), ''))
  FROM (SELECT md5((to_jsonb(t) - 'updated_at')::text) AS h FROM organizations t) s;

SELECT 'users', count(*), md5(coalesce(string_agg(h, '' ORDER BY h), ''))
  FROM (SELECT md5((to_jsonb(t) - 'updated_at')::text) AS h FROM users t) s;

SELECT 'node_credentials', count(*), md5(coalesce(string_agg(h, '' ORDER BY h), ''))
  FROM (SELECT md5((to_jsonb(t) - ARRAY['last_used_at', 'revoked_at'])::text) AS h FROM node_credentials t WHERE revoked_at IS NULL) s;

SELECT 'audit_events', count(*), md5(coalesce(string_agg(h, '' ORDER BY h), ''))
  FROM (SELECT md5(to_jsonb(t)::text) AS h FROM audit_events t WHERE :audit_upto < 0 OR sequence_num <= :audit_upto) s;

-- The newest event of the compared range and its hash: the head of the chain.
SELECT 'audit_chain_head', coalesce(max(sequence_num), 0),
       coalesce((SELECT entry_hash FROM audit_events e
                  WHERE e.sequence_num = max(a.sequence_num)), '-')
  FROM audit_events a WHERE :audit_upto < 0 OR sequence_num <= :audit_upto;

-- Every event names the hash of the one before it. Anything but 0 is a broken chain.
SELECT 'audit_chain_broken_links', count(*), ''
  FROM (SELECT prev_hash, lag(entry_hash) OVER (ORDER BY sequence_num) AS expected
          FROM audit_events WHERE :audit_upto < 0 OR sequence_num <= :audit_upto) s
 WHERE expected IS NOT NULL AND prev_hash IS DISTINCT FROM expected;
