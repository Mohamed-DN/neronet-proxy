const crypto = require('node:crypto');

function quoteIdentifier(name) {
  return '"' + name.replaceAll('"', '""') + '"';
}

function digest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function normalizeConstraintDefinition(definition) {
  // PostgreSQL can deparse the same varchar CHECK as either a text[] cast
  // over the literal array or text casts on each varchar literal after pg_dump
  // and restore. These casts are binary-coercible and do not change the CHECK.
  // Restrict normalization to literal enum checks. Global replacements would
  // also alter quoted values, hiding real changes to a constraint.
  const match = definition.match(
    /^CHECK \(((?:"(?:[^"]|"")*"|[a-zA-Z_][a-zA-Z0-9_$]*)::text) = ANY \(ARRAY\[('(?:[^']|'')*'::character varying(?:::text)?(?:, '(?:[^']|'')*'::character varying(?:::text)?)*)\](?:::text\[\])?\)\)$/
  );
  if (!match) return definition;
  const values = match[2].replace(/('(?:[^']|'')*')::character varying(?:::text)?/g, '$1::text');
  return `CHECK (${match[1]} = ANY (ARRAY[${values}]))`;
}

// Ownership and grants are outside this comparison: pg_restore uses --no-owner
// and --no-acl. Catalog OIDs identify local objects and must not enter the digest.
async function collectSchema(client) {
  const queries = {
    relations: `SELECT c.relname AS name, c.relkind AS kind, c.relpersistence AS persistence,
      c.relrowsecurity AS row_security, c.relforcerowsecurity AS force_row_security,
      pg_get_expr(c.relpartbound, c.oid) AS partition_bound
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','f','c') ORDER BY c.relname COLLATE "C"`,
    columns: `SELECT c.relname AS table_name, a.attname AS name, row_number() OVER (PARTITION BY c.oid ORDER BY a.attnum) AS position,
      format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS not_null, a.attidentity AS identity,
      a.attgenerated AS generated, pg_get_expr(d.adbin, d.adrelid) AS default_expression,
      CASE WHEN a.attcollation <> 0 THEN cn.nspname || '.' || co.collname END AS collation
      FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
      LEFT JOIN pg_collation co ON co.oid = a.attcollation LEFT JOIN pg_namespace cn ON cn.oid = co.collnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','f','c') AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY c.relname COLLATE "C", a.attnum`,
    constraints: `SELECT co.conname AS name, c.relname AS table_name, t.typname AS domain_name,
      co.contype AS type, pg_get_constraintdef(co.oid, true) AS definition, co.convalidated AS validated
      FROM pg_constraint co JOIN pg_namespace n ON n.oid = co.connamespace
      LEFT JOIN pg_class c ON c.oid = co.conrelid LEFT JOIN pg_type t ON t.oid = co.contypid
      WHERE n.nspname = 'public' ORDER BY c.relname COLLATE "C", t.typname COLLATE "C", co.conname COLLATE "C"`,
    indexes: `SELECT c.relname AS table_name, i.relname AS name, pg_get_indexdef(x.indexrelid) AS definition,
      x.indisvalid AS valid, x.indisready AS ready FROM pg_index x JOIN pg_class c ON c.oid = x.indrelid
      JOIN pg_class i ON i.oid = x.indexrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' ORDER BY c.relname COLLATE "C", i.relname COLLATE "C"`,
    sequences: `SELECT c.relname AS name, format_type(s.seqtypid, NULL) AS type,
      s.seqstart AS start, s.seqincrement AS increment, s.seqmin AS minimum, s.seqmax AS maximum,
      s.seqcache AS cache, s.seqcycle AS cycle, tn.nspname || '.' || t.relname AS owned_table,
      a.attname AS owned_column FROM pg_sequence s JOIN pg_class c ON c.oid = s.seqrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_depend d ON d.classid = 'pg_class'::regclass AND d.objid = c.oid
      AND d.deptype IN ('a','i') AND d.refobjsubid > 0
      LEFT JOIN pg_class t ON t.oid = d.refobjid LEFT JOIN pg_namespace tn ON tn.oid = t.relnamespace
      LEFT JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = d.refobjsubid
      WHERE n.nspname = 'public' ORDER BY c.relname COLLATE "C"`,
    views: `SELECT c.relname AS name, pg_get_viewdef(c.oid, true) AS definition FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('v','m')
      ORDER BY c.relname COLLATE "C"`,
    triggers: `SELECT c.relname AS table_name, t.tgname AS name, t.tgenabled AS enabled, pg_get_triggerdef(t.oid, true) AS definition
      FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND NOT t.tgisinternal ORDER BY c.relname COLLATE "C", t.tgname COLLATE "C"`,
    functions: `SELECT p.proname AS name, pg_get_function_identity_arguments(p.oid) AS arguments, pg_get_functiondef(p.oid) AS definition
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.prokind IN ('f','p')
      ORDER BY p.proname COLLATE "C", pg_get_function_identity_arguments(p.oid) COLLATE "C"`,
    types: `SELECT t.typname AS name, t.typtype AS kind, format_type(t.typbasetype, t.typtypmod) AS base_type,
      t.typnotnull AS not_null, t.typdefault AS default_expression,
      (SELECT jsonb_agg(e.enumlabel ORDER BY e.enumsortorder) FROM pg_enum e WHERE e.enumtypid = t.oid) AS enum_values
      FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = 'public' AND t.typtype IN ('d','e') ORDER BY t.typname COLLATE "C"`,
    policies: `SELECT tablename, policyname, permissive, roles, cmd, qual, with_check FROM pg_policies
      WHERE schemaname = 'public' ORDER BY tablename COLLATE "C", policyname COLLATE "C"`,
    extensions: `SELECT e.extname AS name, e.extversion AS version FROM pg_extension e
      JOIN pg_namespace n ON n.oid = e.extnamespace WHERE n.nspname = 'public' ORDER BY e.extname COLLATE "C"`
  };
  const schema = {};
  for (const [kind, sql] of Object.entries(queries)) {
    const rows = (await client.query(sql)).rows;
    schema[kind] =
      kind === 'constraints'
        ? rows.map((row) => ({ ...row, definition: normalizeConstraintDefinition(row.definition) }))
        : rows;
  }
  return schema;
}

async function collectSequences(client, schema) {
  const states = {};
  for (const sequence of schema.sequences) {
    const res = await client.query('SELECT last_value::text, is_called FROM public.' + quoteIdentifier(sequence.name));
    states[sequence.name] = res.rows[0];
  }
  return states;
}

async function collectData(client, schema) {
  const tables = {};
  for (const relation of schema.relations.filter((r) => ['r', 'p', 'm'].includes(r.kind))) {
    const hash = crypto.createHash('sha256');
    let count = 0;
    // Bounded batches avoid buffering whole tables in Node. PostgreSQL's JSON
    // text preserves bigint/numeric values that JS would round.
    await client.query(
      'DECLARE dr_rows NO SCROLL CURSOR FOR SELECT row_data FROM (SELECT to_jsonb(t)::text AS row_data FROM ' +
        (relation.kind === 'm' ? '' : 'ONLY ') +
        'public.' +
        quoteIdentifier(relation.name) +
        ' t) rows ORDER BY row_data COLLATE "C"'
    );
    try {
      while (true) {
        const batch = await client.query('FETCH FORWARD 1000 FROM dr_rows');
        if (batch.rows.length === 0) break;
        for (const row of batch.rows) hash.update(row.row_data).update('\n');
        count += batch.rows.length;
      }
    } finally {
      await client.query('CLOSE dr_rows');
    }
    tables[relation.name] = { count, hash: hash.digest('hex') };
  }
  return tables;
}

module.exports = {
  collectSchema,
  collectSequences,
  collectData,
  digest,
  normalizeConstraintDefinition,
  quoteIdentifier
};
