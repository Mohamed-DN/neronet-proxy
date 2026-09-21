const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { setupTestDatabase } = require('./helpers/db');

describe('Migration 014: Drop dead feature tables and enforce row-count guard', () => {
  let dbHelper;

  before(async () => {
    dbHelper = await setupTestDatabase();
  });

  after(async () => {
    if (dbHelper) await dbHelper.cleanup();
  });

  it('drops dead tables after migration 014 runs', async () => {
    const res = await dbHelper.pool.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name IN ('app_bundles', 'app_share_links', 'nerodrop_sessions')
    `);
    assert.strictEqual(res.rowCount, 0, 'Dead tables should be dropped by migration 014');
  });

  it('refuses to run and aborts if a target table contains rows', async () => {
    const pool = dbHelper.pool;
    // Recreate a temporary dead table with a dummy row
    await pool.query(`
      CREATE TABLE IF NOT EXISTS app_bundles (
        id VARCHAR(64) PRIMARY KEY,
        name VARCHAR(64) NOT NULL
      );
      INSERT INTO app_bundles (id, name) VALUES ('bundle-test-1', 'Test Bundle')
      ON CONFLICT (id) DO NOTHING;
    `);

    const m14Sql = fs.readFileSync(path.resolve(__dirname, '../db/migrations/014_drop_dead_tables.sql'), 'utf8');

    // Attempting to run migration 014 DDL must reject with the guard message
    await assert.rejects(async () => {
      await pool.query(m14Sql);
    }, /Refusing to drop app_bundles: table contains 1 row/);

    // Clean up test table
    await pool.query('DROP TABLE IF EXISTS app_bundles CASCADE;');
  });
});
