-- Canonical application schema and contents, captured from the actual restored dump.
-- The database must be quiescent. Cluster roles and grants are managed separately.
\set ON_ERROR_STOP on
\pset format unaligned
\pset tuples_only on
\pset fieldsep '\t'
\pset footer off

SET TIME ZONE 'UTC';
SET DateStyle = 'ISO, YMD';
SET search_path = public, pg_catalog;
SET row_security = off;

-- pg_dump may distribute a varchar-array to text-array cast over its literal
-- elements. Normalize only that enum CHECK shape, preserving quoted contents.
-- The temporary helper never enters the public application-schema manifest.
CREATE OR REPLACE FUNCTION pg_temp.neronet_normalize_constraint(definition text)
RETURNS text LANGUAGE plpgsql IMMUTABLE AS $body$
DECLARE parts text[];
BEGIN
  parts := regexp_match(definition,
    $re$^CHECK \(((?:"(?:[^"]|"")*"|[a-zA-Z_][a-zA-Z0-9_$]*)::text) = ANY \(ARRAY\[('(?:[^']|'')*'::character varying(?:::text)?(?:, '(?:[^']|'')*'::character varying(?:::text)?)*)\](?:::text\[\])?\)\)$$re$);
  IF parts IS NULL THEN RETURN definition; END IF;
  RETURN format('CHECK (%s = ANY (ARRAY[%s]))', parts[1],
    regexp_replace(parts[2], $re$('(?:[^']|'')*')::character varying(?:::text)?$re$, E'\\1::text', 'g'));
END
$body$;

SELECT 'schema:relations', count(*), encode(sha256(convert_to(coalesce(string_agg(
       to_jsonb(r)::text, E'\n' ORDER BY name), ''), 'UTF8')), 'hex')
  FROM (SELECT c.relname AS name, c.relkind AS kind, c.relpersistence AS persistence,
        c.relrowsecurity AS row_security, c.relforcerowsecurity AS force_row_security,
        pg_get_expr(c.relpartbound, c.oid) AS partition_bound
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','f','c')) r;

SELECT 'schema:types', count(*), encode(sha256(convert_to(coalesce(string_agg(
       to_jsonb(t)::text, E'\n' ORDER BY name), ''), 'UTF8')), 'hex')
  FROM (SELECT t.typname AS name, t.typtype AS kind,
        format_type(t.typbasetype, t.typtypmod) AS base_type,
        t.typnotnull AS not_null, t.typdefault AS default_expression,
        (SELECT jsonb_agg(e.enumlabel ORDER BY e.enumsortorder)
           FROM pg_enum e WHERE e.enumtypid = t.oid) AS enum_values
        FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE n.nspname = 'public' AND t.typtype IN ('d','e')) t;

SELECT 'schema:policies', count(*), encode(sha256(convert_to(coalesce(string_agg(
       to_jsonb(p)::text, E'\n' ORDER BY tablename, policyname), ''), 'UTF8')), 'hex')
  FROM pg_policies p WHERE schemaname = 'public';

SELECT 'schema:extensions', count(*), encode(sha256(convert_to(coalesce(string_agg(
       e.extname || ':' || e.extversion, E'\n' ORDER BY e.extname), ''), 'UTF8')), 'hex')
  FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE n.nspname = 'public';

SELECT 'schema:columns', count(*), encode(sha256(convert_to(coalesce(string_agg(
       (to_jsonb(c) - ARRAY['table_catalog', 'domain_catalog', 'udt_catalog', 'ordinal_position', 'dtd_identifier'])::text,
       E'\n' ORDER BY table_name, canonical_position), ''), 'UTF8')), 'hex')
  FROM (SELECT c.*, row_number() OVER (PARTITION BY table_name ORDER BY ordinal_position) AS canonical_position
          FROM information_schema.columns c WHERE table_schema = 'public') c;

SELECT 'schema:constraints', count(*), encode(sha256(convert_to(coalesce(string_agg(
       r.relname || ':' || c.conname || ':' || pg_temp.neronet_normalize_constraint(pg_get_constraintdef(c.oid, true)) || ':' || c.convalidated,
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
       t.tgenabled::text || ':' || pg_get_triggerdef(t.oid, true), E'\n' ORDER BY r.relname, t.tgname), ''), 'UTF8')), 'hex')
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
  'SELECT %L, count(*), encode(sha256(convert_to(coalesce(string_agg(h, '''' ORDER BY h), ''''), ''UTF8'')), ''hex'') FROM (SELECT encode(sha256(convert_to(to_jsonb(t)::text, ''UTF8'')), ''hex'') AS h FROM %spublic.%I t) s',
  'table:' || c.relname, CASE WHEN c.relkind = 'm' THEN '' ELSE 'ONLY ' END, c.relname)
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind IN ('r','p','m') ORDER BY c.relname
\gexec
