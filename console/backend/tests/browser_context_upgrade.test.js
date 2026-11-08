const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const request = require('supertest');
const { createApp } = require('../server');
const { setupTestDatabase } = require('./helpers/db');

// Migration 043 on a populated schema 042: existing users, session families and
// refresh credentials are unchanged, legacy clients keep working on them, and the
// browser-v2 protocol works on the upgraded database.
describe('Migration 043 upgrades a populated schema 042 without touching existing sessions', () => {
  let db;
  let app;
  const password = 'UpgradeFixture123!';
  const origin = 'http://localhost:8081';
  let previousMfa;

  before(async () => {
    db = await setupTestDatabase();
    app = createApp();
    previousMfa = process.env.SOVEREIGN_MFA_MANDATORY;
    process.env.SOVEREIGN_MFA_MANDATORY = 'off';
  });
  after(async () => {
    if (previousMfa === undefined) delete process.env.SOVEREIGN_MFA_MANDATORY;
    else process.env.SOVEREIGN_MFA_MANDATORY = previousMfa;
    if (db) await db.cleanup();
  });

  it('applies 043 after legacy sessions exist and keeps them valid', async () => {
    // setupTestDatabase supplies the complete schema; removing only 043's objects
    // reconstructs the real schema at migration 042.
    await db.pool.query(`
      ALTER TABLE console_browser_contexts DROP CONSTRAINT console_browser_selected_issuance;
      DROP TABLE console_browser_issuances;
      DROP TABLE console_browser_operations;
      DROP TABLE console_browser_contexts;
      DROP INDEX idx_refresh_tokens_browser_family_id;`);
    const hash = await bcrypt.hash(password, 4);
    const accounts = [];
    for (let n = 0; n < 3; n++) {
      const id = `usr-upgrade-043-${n}`;
      await db.pool.query(
        `INSERT INTO users(id,username,email,password_hash,role,status,organization_id)
         VALUES($1,$1,$2,$3,'user','active','org-default')`,
        [id, `${id}@test.local`, hash]
      );
      const login = await request(app).post('/api/auth/login').send({ username: id, password });
      assert.equal(login.status, 200);
      accounts.push({ id, token: login.body.token, cookies: login.headers['set-cookie'].map((c) => c.split(';')[0]) });
    }
    const snapshot = async () =>
      (
        await db.pool.query(`SELECT
          (SELECT md5(string_agg(id||':'||user_id||':'||coalesce(revoked_at::text,'-'), ',' ORDER BY id)) FROM console_sessions) AS families,
          (SELECT md5(string_agg(id||':'||token_hash||':'||revoked::text, ',' ORDER BY id)) FROM refresh_tokens) AS credentials,
          (SELECT count(*)::int FROM refresh_tokens) AS count`)
      ).rows[0];
    const beforeUpgrade = await snapshot();
    assert.ok(beforeUpgrade.count >= 3);

    await db.pool.query(
      fs.readFileSync(path.join(__dirname, '../db/migrations/043_browser_context_authority.sql'), 'utf8')
    );
    assert.deepEqual(await snapshot(), beforeUpgrade, 'families and refresh credentials are untouched');

    // Legacy Bearer and legacy cookie clients keep working on their existing sessions.
    const bearer = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${accounts[0].token}`);
    assert.equal(bearer.status, 200);
    assert.equal(bearer.body.user.id, accounts[0].id);
    const refreshed = await request(app).post('/api/auth/refresh').set('Cookie', accounts[1].cookies).send({});
    assert.equal(refreshed.status, 200);

    // The browser-v2 protocol works on the upgraded schema.
    const protocol = { 'X-NeroNet-Browser-Protocol': '2', Origin: origin };
    const contextId = crypto.randomUUID();
    const created = await request(app).post('/api/auth/browser/context').set(protocol).send({ context_id: contextId });
    assert.equal(created.status, 200);
    const binding = created.headers['set-cookie'][0].split(';')[0];
    const operation = {
      operation_id: crypto.randomUUID(),
      intent: '1',
      kind: 'login',
      expected_issuance_id: null,
      successor_issuance_id: crypto.randomUUID()
    };
    const withContext = (call) => call.set(protocol).set('X-NeroNet-Browser-Context', contextId);
    assert.equal(
      (await withContext(request(app).post('/api/auth/browser/intent')).set('Cookie', binding).send(operation)).status,
      200
    );
    const login = await withContext(request(app).post('/api/auth/login'))
      .set('Cookie', binding)
      .send({ username: accounts[2].id, password, operation_id: operation.operation_id });
    assert.equal(login.status, 200, JSON.stringify(login.body));
    const cookies = [binding, ...login.headers['set-cookie'].map((c) => c.split(';')[0])].join('; ');
    const selected = await withContext(request(app).post('/api/auth/browser/select'))
      .set('Cookie', cookies)
      .send({ operation_id: operation.operation_id, intent: '1', issuance_id: operation.successor_issuance_id });
    assert.equal(selected.status, 200, JSON.stringify(selected.body));
    const me = await withContext(request(app).get('/api/auth/me'))
      .set('Cookie', cookies)
      .set('X-NeroNet-Browser-Issuance', operation.successor_issuance_id);
    assert.equal(me.status, 200);
    assert.equal(me.body.user.id, accounts[2].id);
  });
});
