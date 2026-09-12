const { describe, it, before } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const Database = require('better-sqlite3');
const { runMigrations } = require('../db/migrator');

const MIGRATIONS_DIR = path.resolve(__dirname, '../db/migrations');

/**
 * This project maintains two schemas by hand: the SQLite DDL lives in string literals
 * inside db/migrator.js, the PostgreSQL DDL in db/migrations/*.sql. Nothing connected
 * them, and they had already drifted -- the nodes table carried a PostGIS geometry
 * column on one side and no coordinates at all on the other, and the suite did not
 * notice because it only checked that each file contained certain text.
 *
 * This compares what the two schemas actually declare. The SQLite side is built for
 * real and introspected; the PostgreSQL side is parsed, since no server is available
 * in the unit test environment.
 */

/** Column names per table, from a real SQLite database built by the migrator. */
function buildSqliteSchema() {
  const db = new Database(':memory:');
  runMigrations(db);

  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((r) => r.name);

  const schema = {};
  for (const table of tables) {
    schema[table] = new Set(db.pragma(`table_info(${table})`).map((c) => c.name));
  }

  db.close();
  return schema;
}

/** Column names per table, parsed from the PostgreSQL migration files. */
function buildPostgresSchema() {
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const schema = {};

  for (const file of files) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');

    const createRe = /CREATE TABLE IF NOT EXISTS (\w+)\s*\(([\s\S]*?)\n\);/g;
    let match;
    while ((match = createRe.exec(sql)) !== null) {
      const [, table, body] = match;
      const columns = new Set();

      for (const rawLine of body.split('\n')) {
        const line = rawLine.trim();
        if (!line || line.startsWith('--')) continue;
        // Skip table-level constraints, which are not columns.
        if (/^(PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT)\b/i.test(line)) continue;

        const col = line.match(/^(\w+)\s+/);
        if (col) columns.add(col[1]);
      }

      schema[table] = columns;
    }

    // Columns added by later migrations via ALTER TABLE.
    const alterRe = /ALTER TABLE (\w+) ADD COLUMN(?: IF NOT EXISTS)? (\w+)/g;
    while ((match = alterRe.exec(sql)) !== null) {
      const [, table, column] = match;
      if (schema[table]) schema[table].add(column);
    }

    const dropRe = /ALTER TABLE (\w+) DROP COLUMN(?: IF EXISTS)? (\w+)/g;
    while ((match = dropRe.exec(sql)) !== null) {
      const [, table, column] = match;
      if (schema[table]) schema[table].delete(column);
    }
  }

  return schema;
}

// Tables that legitimately exist on only one side, with the reason.
const EXPECTED_ONLY_IN_POSTGRES = new Set([
  // Both are created lazily at runtime by their owning service, for either backend:
  // NukeEngine and CanaryService each issue their own CREATE TABLE IF NOT EXISTS.
  // They appear in the .sql files but not in the SQLite migrator.
  'dead_man_switch',
  'warrant_canaries'
]);

const EXPECTED_ONLY_IN_SQLITE = new Set([
  // PostgreSQL allocates overlay addresses from a SEQUENCE, which is not a table and
  // so cannot appear on both sides. SQLite has no sequences, so the same counter is
  // a single-row table there. The asymmetry is in the mechanism, not the schema.
  'vip_allocator'
]);

describe('SQLite and PostgreSQL schemas stay in step', () => {
  let sqlite;
  let postgres;

  before(() => {
    sqlite = buildSqliteSchema();
    postgres = buildPostgresSchema();
  });

  it('declares the same set of tables on both backends', () => {
    const sqliteTables = new Set(Object.keys(sqlite).filter((t) => t !== '_migrations'));
    const postgresTables = new Set(Object.keys(postgres));

    const missingFromSqlite = [...postgresTables].filter(
      (t) => !sqliteTables.has(t) && !EXPECTED_ONLY_IN_POSTGRES.has(t)
    );
    const missingFromPostgres = [...sqliteTables].filter(
      (t) => !postgresTables.has(t) && !EXPECTED_ONLY_IN_SQLITE.has(t)
    );

    assert.deepStrictEqual(
      missingFromSqlite,
      [],
      `tables declared for PostgreSQL but absent from the SQLite migrator: ${missingFromSqlite.join(', ')}`
    );
    assert.deepStrictEqual(
      missingFromPostgres,
      [],
      `tables declared for SQLite but absent from the PostgreSQL migrations: ${missingFromPostgres.join(', ')}`
    );
  });

  it('declares the same columns for every shared table', () => {
    const problems = [];

    for (const [table, pgColumns] of Object.entries(postgres)) {
      const sqliteColumns = sqlite[table];
      if (!sqliteColumns) continue; // covered by the table-level test above

      for (const column of pgColumns) {
        if (!sqliteColumns.has(column)) {
          problems.push(`${table}.${column} exists in PostgreSQL but not in SQLite`);
        }
      }
      for (const column of sqliteColumns) {
        if (!pgColumns.has(column)) {
          problems.push(`${table}.${column} exists in SQLite but not in PostgreSQL`);
        }
      }
    }

    assert.deepStrictEqual(problems, [], `schema drift:\n  ${problems.join('\n  ')}`);
  });

  it('carries node coordinates as plain columns on both backends', () => {
    // The replacement for the PostGIS geometry column. Spatial work, if it is ever
    // needed, is a bounding-box prefilter over these followed by exact Haversine --
    // same answers, same code on both backends, no extension to install.
    for (const [name, schema] of [['SQLite', sqlite], ['PostgreSQL', postgres]]) {
      assert.ok(schema.nodes.has('latitude'), `${name}: nodes.latitude is missing`);
      assert.ok(schema.nodes.has('longitude'), `${name}: nodes.longitude is missing`);
    }
  });

  it('no longer declares a PostGIS geometry column anywhere', () => {
    assert.ok(!postgres.nodes.has('location'), 'nodes.location survived migration 004');

    const combined = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql') && f !== '004_drop_postgis.sql')
      .map((f) => fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8'))
      .join('\n');

    assert.ok(!/USING GIST/i.test(combined), 'a GiST index is still declared');
    assert.ok(
      !/CREATE EXTENSION IF NOT EXISTS "postgis"/i.test(combined),
      'the postgis extension is still declared'
    );
  });
});
