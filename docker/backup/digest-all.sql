-- Row count and checksum of every table in the public schema, every sequence's last
-- value, and the shape of the schema, one line each:
--   name <TAB> rows <TAB> checksum
-- Run by `neronet-backup digest --scope all`. Nothing is left out, so it is only
-- meaningful on a database nothing writes to: the backup drill stops the backend first,
-- takes the checksums, and takes them again after the restore.
-- A checksum is the md5 of the sorted per-row md5 of the row as JSON.
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

SELECT 'sequence:' || sequencename, coalesce(last_value, 0), ''
  FROM pg_sequences WHERE schemaname = 'public' ORDER BY sequencename;

-- One generated query per table. %I quotes the names.
SELECT format(
  'SELECT %L, count(*), md5(coalesce(string_agg(h, '''' ORDER BY h), '''')) FROM (SELECT md5(to_jsonb(t)::text) AS h FROM %I.%I t) s',
  'table:' || tablename, schemaname, tablename)
  FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename
\gexec
