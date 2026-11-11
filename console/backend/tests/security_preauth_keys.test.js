// M2: pre-auth keys are enrolment credentials for the whole organisation. Only
// owner/admin/network_admin (and the platform super-admin) may mint, list or revoke them,
// and a reusable key honours max_uses like a single-use one honours its single use.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { setupTestDatabase } = require('./helpers/db');
const { createOrgFixture } = require('./helpers/orgFixture');
const { createApp } = require('../server');
const PreAuthKeyService = require('../services/PreAuthKeyService');

describe('M2: pre-auth key roles and max_uses', () => {
  let dbHelper;
  let pool;
  let app;
  let fx;
  const auth = (name) => ({ Authorization: `Bearer ${fx.tokens[name]}` });

  before(async () => {
    dbHelper = await setupTestDatabase();
    pool = dbHelper.pool;
    app = createApp();
    fx = await createOrgFixture(pool);
  });

  after(async () => {
    if (dbHelper) await dbHelper.cleanup();
  });

  it('refuses a plain member every operation on pre-auth keys', async () => {
    const created = await request(app).post('/api/preauth-keys').set(auth('memberA')).send({ is_reusable: true });
    assert.strictEqual(created.status, 403);
    assert.strictEqual((await request(app).get('/api/preauth-keys').set(auth('memberA'))).status, 403);

    const adminKey = await PreAuthKeyService.createPreAuthKey({ ownerId: fx.ids.adminA, organizationId: fx.orgs.A });
    const revoke = await request(app).delete(`/api/preauth-keys/${adminKey.id}`).set(auth('memberA'));
    assert.strictEqual(revoke.status, 403);
    const row = await pool.query('SELECT revoked_at FROM preauth_keys WHERE id = $1', [adminKey.id]);
    assert.strictEqual(row.rows[0].revoked_at, null, 'the admin key was revoked by a member');
  });

  it('lets owner, admin, network_admin and super-admin mint, list and revoke', async () => {
    for (const who of ['ownerA', 'adminA', 'netAdminA', 'superAdmin']) {
      const created = await request(app).post('/api/preauth-keys').set(auth(who)).send({});
      assert.strictEqual(created.status, 201, who);
      assert.strictEqual((await request(app).get('/api/preauth-keys').set(auth(who))).status, 200, who);
      assert.strictEqual(
        (await request(app).delete(`/api/preauth-keys/${created.body.id}`).set(auth(who))).status,
        200
      );
    }
  });

  it('refuses a reusable key once max_uses is reached', async () => {
    const key = await PreAuthKeyService.createPreAuthKey({
      ownerId: fx.ids.adminA,
      organizationId: fx.orgs.A,
      isReusable: true,
      maxUses: 2
    });
    assert.strictEqual((await PreAuthKeyService.validateAndConsumePreAuthKey(key.secret)).ok, true);
    assert.strictEqual((await PreAuthKeyService.validateAndConsumePreAuthKey(key.secret)).ok, true);
    const third = await PreAuthKeyService.validateAndConsumePreAuthKey(key.secret);
    assert.strictEqual(third.ok, false);
    assert.strictEqual(third.status, 401);
    const row = await pool.query('SELECT used_count FROM preauth_keys WHERE id = $1', [key.id]);
    assert.strictEqual(row.rows[0].used_count, 2);
  });

  it('keeps a reusable key without max_uses usable', async () => {
    const key = await PreAuthKeyService.createPreAuthKey({
      ownerId: fx.ids.adminA,
      organizationId: fx.orgs.A,
      isReusable: true
    });
    for (let i = 0; i < 4; i++) {
      assert.strictEqual((await PreAuthKeyService.validateAndConsumePreAuthKey(key.secret)).ok, true);
    }
  });
});
