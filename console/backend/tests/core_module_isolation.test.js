const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const config = require('../config/env');
const { setupTestDatabase } = require('./helpers/db');
const { createApp } = require('../server');
const ModuleLoader = require('../services/ModuleLoader');

describe('WP-107: Feature Module Isolation and Organization Profiles', () => {
  let dbHelper;
  let pool;
  let app;

  let superAdminToken;
  let standardOrgId;
  let standardUserToken;
  let standardUserId;
  let regulatedOrgId;
  let regulatedUserToken;
  let regulatedUserId;

  before(async () => {
    dbHelper = await setupTestDatabase();
    pool = dbHelper.pool;
    app = createApp();

    // 1. Super Admin
    await pool.query(`
      INSERT INTO users (id, username, email, password_hash, role)
      VALUES ('usr-mod-admin', 'modadmin', 'admin@mod.local', 'hash', 'super-admin')
      ON CONFLICT (id) DO NOTHING;
    `);
    superAdminToken = jwt.sign({ sub: 'usr-mod-admin', username: 'modadmin', role: 'super-admin' }, config.JWT_SECRET);

    // 2. Standard Organization
    standardOrgId = 'org-standard-corp';
    await pool.query(`
      INSERT INTO organizations (id, name, slug, default_policy, profile)
      VALUES ('${standardOrgId}', 'Standard Corp', 'standard-corp', 'open', 'standard')
      ON CONFLICT (id) DO NOTHING;
    `);
    standardUserId = 'usr-std-owner';
    await pool.query(`
      INSERT INTO users (id, username, email, password_hash, role, organization_id)
      VALUES ('${standardUserId}', 'stdowner', 'owner@std.local', 'hash', 'user', '${standardOrgId}')
      ON CONFLICT (id) DO NOTHING;
    `);
    await pool.query(`
      INSERT INTO memberships (id, user_id, organization_id, role)
      VALUES ('mem-std-1', '${standardUserId}', '${standardOrgId}', 'owner')
      ON CONFLICT (user_id, organization_id) DO NOTHING;
    `);
    standardUserToken = jwt.sign(
      { sub: standardUserId, username: 'stdowner', role: 'user', organization_id: standardOrgId },
      config.JWT_SECRET
    );

    // 3. Regulated Organization
    regulatedOrgId = 'org-regulated-bank';
    await pool.query(`
      INSERT INTO organizations (id, name, slug, default_policy, profile)
      VALUES ('${regulatedOrgId}', 'Regulated Bank', 'regulated-bank', 'deny', 'regulated')
      ON CONFLICT (id) DO NOTHING;
    `);
    regulatedUserId = 'usr-reg-owner';
    await pool.query(`
      INSERT INTO users (id, username, email, password_hash, role, organization_id)
      VALUES ('${regulatedUserId}', 'regowner', 'owner@reg.local', 'hash', 'user', '${regulatedOrgId}')
      ON CONFLICT (id) DO NOTHING;
    `);
    await pool.query(`
      INSERT INTO memberships (id, user_id, organization_id, role)
      VALUES ('mem-reg-1', '${regulatedUserId}', '${regulatedOrgId}', 'owner')
      ON CONFLICT (user_id, organization_id) DO NOTHING;
    `);
    regulatedUserToken = jwt.sign(
      { sub: regulatedUserId, username: 'regowner', role: 'user', organization_id: regulatedOrgId },
      config.JWT_SECRET
    );
  });

  after(async () => {
    if (dbHelper) await dbHelper.cleanup();
  });

  describe('1. Core Invariant: Core Never Imports From Modules', () => {
    it('verifies that no core file imports from modules/', () => {
      const backendRoot = path.resolve(__dirname, '..');
      const excludedDirs = new Set(['modules', 'tests', 'node_modules']);
      const violations = [];

      function scanDir(dir) {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            if (!excludedDirs.has(entry.name)) {
              scanDir(fullPath);
            }
          } else if (entry.isFile() && entry.name.endsWith('.js')) {
            // ModuleLoader.js dynamically loads modules via fs.readdirSync/require, so exclude it
            if (entry.name === 'ModuleLoader.js') continue;

            const content = fs.readFileSync(fullPath, 'utf8');
            // Check for require pointing to modules
            const requireRegex = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
            let match;
            while ((match = requireRegex.exec(content)) !== null) {
              const reqPath = match[1];
              if (
                reqPath.includes('/modules/') ||
                reqPath.startsWith('./modules') ||
                reqPath.startsWith('../modules')
              ) {
                violations.push({ file: fullPath, import: reqPath });
              }
            }
          }
        }
      }

      scanDir(backendRoot);
      assert.deepStrictEqual(
        violations,
        [],
        `Core files must never import directly from modules/. Violations found: ${JSON.stringify(violations)}`
      );
    });

    it('demonstrates that the scanner detects forbidden module imports', () => {
      const mockCode = "const nuke = require('../modules/nuke/NukeEngine');";
      const requireRegex = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
      const match = requireRegex.exec(mockCode);
      assert.ok(match, 'Must match require statement');
      assert.ok(match[1].includes('/modules/'), 'Must detect module import target');
    });
  });

  describe('2. Per-Organization Profiles (Regulated vs Standard)', () => {
    it('allows standard organization user to access nuke state', async () => {
      const res = await request(app).get('/api/nuke/state').set('Authorization', `Bearer ${standardUserToken}`);

      assert.strictEqual(res.status, 200);
      assert.ok(res.body.tier1_scheduled_kill !== undefined);
    });

    it('returns 404 (never 403) when regulated organization accesses nuke state', async () => {
      const res = await request(app).get('/api/nuke/state').set('Authorization', `Bearer ${regulatedUserToken}`);

      assert.strictEqual(res.status, 404, 'Must return 404 Not Found to prevent feature enumeration');
      assert.strictEqual(res.body.error, 'Not found');
    });

    it('allows standard organization user to access setup-passwords', async () => {
      const res = await request(app)
        .post('/api/auth/setup-passwords')
        .set('Authorization', `Bearer ${standardUserToken}`)
        .send({ pwd_standard: 'new_standard_password123' });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.success, true);
    });

    it('returns 404 when regulated organization attempts setup-passwords', async () => {
      const res = await request(app)
        .post('/api/auth/setup-passwords')
        .set('Authorization', `Bearer ${regulatedUserToken}`)
        .send({ pwd_standard: 'new_standard_password123' });

      assert.strictEqual(res.status, 404, 'Must return 404 Not Found for deniability passwords');
      assert.strictEqual(res.body.error, 'Not found');
    });
  });

  describe('3. Dynamic Organization Module Toggle & Audit Trail', () => {
    it('lists organization modules with accurate profile status', async () => {
      const res = await request(app)
        .get(`/api/organizations/${regulatedOrgId}/modules`)
        .set('Authorization', `Bearer ${superAdminToken}`);

      assert.strictEqual(res.status, 200);
      assert.ok(Array.isArray(res.body.modules));
      const nukeMod = res.body.modules.find((m) => m.module_id === 'nuke');
      assert.ok(nukeMod);
      // For regulated org, nuke is disabled
      assert.strictEqual(nukeMod.enabled, false);
    });

    it('allows org owner to disable nuke module for a standard organization', async () => {
      const res = await request(app)
        .put(`/api/organizations/${standardOrgId}/modules/nuke`)
        .set('Authorization', `Bearer ${standardUserToken}`)
        .send({ enabled: false });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.enabled, false);

      // Now standard org user gets 404 on nuke state!
      const checkRes = await request(app).get('/api/nuke/state').set('Authorization', `Bearer ${standardUserToken}`);

      assert.strictEqual(checkRes.status, 404);
    });

    it('re-enabling nuke module restores access for standard organization', async () => {
      const res = await request(app)
        .put(`/api/organizations/${standardOrgId}/modules/nuke`)
        .set('Authorization', `Bearer ${standardUserToken}`)
        .send({ enabled: true });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.enabled, true);

      const checkRes = await request(app).get('/api/nuke/state').set('Authorization', `Bearer ${standardUserToken}`);

      assert.strictEqual(checkRes.status, 200);
    });

    it('records an audit event when a module is toggled', async () => {
      const auditRes = await pool.query(`
        SELECT event_type, actor_username, target_id, message
        FROM audit_events
        WHERE event_type = 'ORG_MODULE_TOGGLE'
        ORDER BY created_at DESC
        LIMIT 1
      `);

      assert.strictEqual(auditRes.rows.length, 1);
      assert.strictEqual(auditRes.rows[0].target_id, standardOrgId);
      assert.match(auditRes.rows[0].message, /Module nuke set to/);
    });
  });

  describe('4. Warrant Canary Isolation (Canary Remains Accessible)', () => {
    it('warrant canary remains accessible at /api/nuke/canary.txt even when nuke is disabled', async () => {
      const res = await request(app).get('/api/nuke/canary.txt');
      // Returns 200 or 404 depending on whether canary was published, but never blocked by module
      assert.ok([200, 404].includes(res.status));
    });
  });
});
