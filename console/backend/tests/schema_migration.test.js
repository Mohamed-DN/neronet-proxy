const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { setupTestDatabase } = require('./helpers/db');

const MIGRATIONS_DIR = path.resolve(__dirname, '../db/migrations');

describe('PostgreSQL Schema & Migration Verification', () => {
  let dbHelper;

  before(async () => {
    dbHelper = await setupTestDatabase();
  });

  after(async () => {
    if (dbHelper) await dbHelper.cleanup();
  });

  it('records every migration file as applied in _migrations', async () => {
    const pool = dbHelper.pool;
    const files = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    const res = await pool.query('SELECT name FROM _migrations ORDER BY name');
    const applied = new Set(res.rows.map((r) => r.name));

    for (const file of files) {
      assert.ok(applied.has(file), `Migration ${file} is not recorded in _migrations`);
    }
    assert.strictEqual(applied.size >= 15, true, 'At least 15 migrations must be applied');
  });

  it('declares the expected production schema tables', async () => {
    const pool = dbHelper.pool;
    const res = await pool.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    `);
    const tables = new Set(res.rows.map((r) => r.table_name));

    const expectedTables = [
      '_migrations',
      'users',
      'nodes',
      'audit_events',
      'system_metrics',
      'refresh_tokens',
      'dead_man_switch',
      'peering_agreements',
      'cloud_pcs',
      'custom_domains',
      'warrant_canaries',
      'acl_rules',
      'mesh_epochs',
      'network_routes',
      'revoked_keys',
      'preauth_keys',
      'node_credentials'
    ];

    for (const t of expectedTables) {
      assert.ok(tables.has(t), `Expected table '${t}' is missing from schema`);
    }

    // Dead tables from WP-006 / Migration 014 must NOT exist
    const deadTables = ['app_bundles', 'app_share_links', 'nerodrop_sessions'];
    for (const dt of deadTables) {
      assert.ok(!tables.has(dt), `Dead table '${dt}' should have been dropped by migration 014`);
    }
  });

  it('carries correct column types and no obsolete tier columns', async () => {
    const pool = dbHelper.pool;
    const userColsRes = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'users'
    `);
    const userCols = new Set(userColsRes.rows.map((r) => r.column_name));

    assert.ok(userCols.has('id'), 'users.id missing');
    assert.ok(userCols.has('username'), 'users.username missing');
    assert.ok(userCols.has('email'), 'users.email missing');
    assert.ok(userCols.has('password_hash'), 'users.password_hash missing');
    assert.ok(userCols.has('role'), 'users.role missing');

    // Migration 011 removed tier columns
    assert.ok(!userCols.has('tier'), 'users.tier must be absent');
    assert.ok(!userCols.has('bandwidth_quota_gb'), 'users.bandwidth_quota_gb must be absent');
    assert.ok(!userCols.has('bandwidth_used_bytes'), 'users.bandwidth_used_bytes must be absent');
    assert.ok(!userCols.has('max_nodes'), 'users.max_nodes must be absent');

    const nodeColsRes = await pool.query(`
      SELECT column_name, data_type FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'nodes'
    `);
    const nodeCols = new Map(nodeColsRes.rows.map((r) => [r.column_name, r.data_type]));

    assert.ok(nodeCols.has('latitude'), 'nodes.latitude missing');
    assert.ok(nodeCols.has('longitude'), 'nodes.longitude missing');
    assert.strictEqual(nodeCols.get('onion_routing_enabled'), 'boolean');
    assert.strictEqual(nodeCols.get('kill_switch_enabled'), 'boolean');
    assert.strictEqual(nodeCols.get('endpoints'), 'jsonb');
    assert.strictEqual(nodeCols.get('posture_checks'), 'jsonb');

    // PostGIS location column dropped in migration 004
    assert.ok(!nodeCols.has('location'), 'nodes.location (PostGIS) must be absent');
  });
});
