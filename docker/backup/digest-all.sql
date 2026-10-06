-- Canonical application schema and contents, captured from the actual restored dump.
-- The database must be quiescent. Cluster roles and grants are managed separately.
\set ON_ERROR_STOP on
\pset format unaligned
\pset tuples_only on
\pset fieldsep '\t'
\pset footer off

SELECT 'schema:columns', count(*), encode(sha256(convert_to(coalesce(string_agg(
       (to_jsonb(c) - ARRAY['table_catalog', 'domain_catalog', 'udt_catalog', 'ordinal_position', 'dtd_identifier'])::text,
       E'\n' ORDER BY table_name, canonical_position), ''), 'UTF8')), 'hex')
  FROM (SELECT c.*, row_number() OVER (PARTITION BY table_name ORDER BY ordinal_position) AS canonical_position
          FROM information_schema.columns c WHERE table_schema = 'public') c;

SELECT 'schema:constraints', count(*), encode(sha256(convert_to(coalesce(string_agg(
       r.relname || ':' || c.conname || ':' || pg_get_constraintdef(c.oid, true) || ':' || c.convalidated,
       E'\n' ORDER BY r.relname, c.conname), ''), 'UTF8')), 'hex')
  FROM pg_constraint c JOIN pg_class r ON r.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = r.relnamespace WHERE n.nspname = 'public';

SELECT 'schema:indexes', count(*), encode(sha256(convert_to(coalesce(string_agg(
       indexdef, E'\n' ORDER BY tablename, indexname), ''), 'UTF8')), 'hex')
  FROM pg_indexes WHERE schemaname = 'public';

SELECT 'schema:views', count(*), encode(sha256(convert_to(coalesce(string_agg(
       r.relname || ':' || pg_get_viewdef(r.oid, true), E'\n' ORDER BY r.relname), ''), 'UTF8')), 'hex')
  FROM pg_class r JOIN pg_namespace n ON n.oid = r.relnamespace
 WHERE n.nspname = 'public' AND r.relkind IN ('v', 'm');

SELECT 'schema:functions', count(*), encode(sha256(convert_to(coalesce(string_agg(
       pg_get_functiondef(p.oid), E'\n' ORDER BY p.proname, pg_get_function_identity_arguments(p.oid)), ''), 'UTF8')), 'hex')
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.prokind <> 'a';

SELECT 'schema:triggers', count(*), encode(sha256(convert_to(coalesce(string_agg(
       pg_get_triggerdef(t.oid, true), E'\n' ORDER BY r.relname, t.tgname), ''), 'UTF8')), 'hex')
  FROM pg_trigger t JOIN pg_class r ON r.oid = t.tgrelid
  JOIN pg_namespace n ON n.oid = r.relnamespace WHERE n.nspname = 'public' AND NOT t.tgisinternal;

SELECT 'schema:sequences', count(*), encode(sha256(convert_to(coalesce(string_agg(
       (to_jsonb(s) - ARRAY['last_value', 'sequenceowner'])::text, E'\n' ORDER BY sequencename), ''), 'UTF8')), 'hex')
  FROM pg_sequences s WHERE schemaname = 'public';

SELECT format('SELECT %L, last_value, is_called FROM %I.%I',
       'sequence:' || sequencename, schemaname, sequencename)
  FROM pg_sequences WHERE schemaname = 'public' ORDER BY sequencename
\gexec

-- One generated query per table. %I quotes the names.
SELECT format(
  'SELECT %L, count(*), encode(sha256(convert_to(coalesce(string_agg(h, '''' ORDER BY h), ''''), ''UTF8'')), ''hex'') FROM (SELECT encode(sha256(convert_to(to_jsonb(t)::text, ''UTF8'')), ''hex'') AS h FROM %I.%I t) s',
  'table:' || tablename, schemaname, tablename)
  FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename
\gexec
