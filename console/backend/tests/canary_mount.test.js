const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const request = require('supertest');
const { setupTestDatabase } = require('./helpers/db');
const { createApp } = require('../server');
const CanaryService = require('../services/CanaryService');

/**
 * The whole nuke router was mounted at '/' as well as at '/api/nuke', so that the
 * warrant canary could be served from the root. That also published every
 * self-destruct and dead man's switch route outside /api, where the API rate limiter
 * does not reach. Only the canary belongs at the root.
 */

describe('Root mount', () => {
  let dbHelper;
  let app;

  before(async () => {
    dbHelper = await setupTestDatabase();
    app = createApp();
  });

  after(async () => {
    if (dbHelper) await dbHelper.cleanup();
  });

  // A 401 here means the route exists and only the credential is missing, which is
  // the whole finding: these are reachable outside /api.
  for (const [method, route] of [
    ['get', '/user/status'],
    ['get', '/personal-dms/status'],
    ['get', '/state'],
    ['post', '/user/self-destruct'],
    ['post', '/personal-dms/unlock'],
    ['post', '/owner-dms/trigger']
  ]) {
    it(`does not serve ${method.toUpperCase()} ${route} at the root`, async () => {
      const res = await request(app)[method](route).send({});

      assert.strictEqual(res.status, 404, `${route} is still mounted at the root`);
    });
  }

  it('still serves the nuke API under /api/nuke', async () => {
    const res = await request(app).get('/api/nuke/user/status');

    // Mounted, and refusing an anonymous caller: 404 here would mean the router
    // moved rather than narrowed.
    assert.strictEqual(res.status, 401);
  });

  const PATHS = ['/canary', '/canary.txt', '/.well-known/canary.txt', '/api/nuke/canary', '/api/nuke/canary.txt'];
  const rows = async () => (await dbHelper.pool.query('SELECT count(*)::int AS n FROM warrant_canaries')).rows[0].n;

  // The console used to write and sign a legal statement in the operator's name whenever one of
  // these addresses was opened.
  for (const route of PATHS) {
    it(`publishes nothing by itself at ${route}`, async () => {
      const before = await rows();
      const res = await request(app).get(route);
      assert.strictEqual(res.status, 404);
      assert.strictEqual(res.body.error, 'canary_not_published');
      assert.strictEqual(await rows(), before, 'a read must not create a statement');
    });
  }

  describe('a statement in the database', () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
    const publicRaw = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64');
    const statement = 'A statement a person made.';
    const signature = crypto.sign(null, Buffer.from(statement), privateKey).toString('base64');

    const insert = (id, publishedBy, text = statement) =>
      dbHelper.pool.query(
        `INSERT INTO warrant_canaries (id, statement_text, ed25519_signature, signer_public_key, is_active, published_by)
         VALUES ($1, $2, $3, $4, TRUE, $5)`,
        [id, text, signature, publicRaw, publishedBy]
      );

    afterEach(() => dbHelper.pool.query('DELETE FROM warrant_canaries'));

    it('is not served when no account published it', async () => {
      await insert('c-auto', null);
      assert.strictEqual((await request(app).get('/.well-known/canary.txt')).status, 404);
    });

    it('is served with its signature checked when an account published it', async () => {
      await insert('c-person', 'usr-person');
      const res = await request(app).get('/.well-known/canary.txt');
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.valid, true);
      const text = await request(app).get('/.well-known/canary.txt').set('Accept', 'text/plain');
      assert.match(text.headers['content-type'], /text\/plain/);
      assert.match(text.text, /A statement a person made/);
    });

    it('is reported invalid when the text does not match the signature', async () => {
      await insert('c-tampered', 'usr-person', `${statement} Changed.`);
      assert.strictEqual((await request(app).get('/canary')).body.valid, false);
    });

    it('is reported invalid under another key', () => {
      const other = crypto.randomBytes(32).toString('base64');
      assert.strictEqual(CanaryService.verifyCanary(statement, signature, other), false);
    });
  });

  it('withdraws what the console wrote by itself: migration 061', async () => {
    await dbHelper.pool.query(
      `INSERT INTO warrant_canaries (id, statement_text, ed25519_signature, signer_public_key, is_active)
       VALUES ('c-old', 'x', 'x', 'x', TRUE)`
    );
    await dbHelper.pool.query(
      fs.readFileSync(path.join(__dirname, '../db/migrations/061_withdraw_automatic_canaries.sql'), 'utf8')
    );
    const row = (await dbHelper.pool.query("SELECT is_active FROM warrant_canaries WHERE id = 'c-old'")).rows[0];
    assert.strictEqual(row.is_active, false);
  });
});
