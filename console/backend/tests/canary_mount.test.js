const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const request = require('supertest');

const testDbPath = path.resolve(__dirname, '../../data/test_canary_mount.db');
process.env.SOVEREIGN_DB_PATH = testDbPath;

const { getDatabase, closeDatabase } = require('../db/index');
const { runMigrations } = require('../db/migrator');
const { seedDatabase } = require('../db/seed');
const { createApp } = require('../server');
const CanaryService = require('../services/CanaryService');

/**
 * The whole nuke router was mounted at '/' as well as at '/api/nuke', so that the
 * warrant canary could be served from the root. That also published every
 * self-destruct and dead man's switch route outside /api, where the API rate limiter
 * does not reach. Only the canary belongs at the root.
 */

describe('Root mount', () => {
  let app;

  before(async () => {
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
    const db = getDatabase(testDbPath);
    runMigrations(db);
    seedDatabase(db);
    app = createApp();
    await CanaryService.generateCanary();
  });

  after(() => {
    closeDatabase();
    for (const suffix of ['', '-wal', '-shm']) {
      const f = `${testDbPath}${suffix}`;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
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

  for (const route of ['/canary', '/canary.txt', '/.well-known/canary.txt']) {
    it(`serves the warrant canary at ${route}`, async () => {
      const res = await request(app).get(route);

      assert.strictEqual(res.status, 200);
      assert.ok(res.body.signature, 'the canary must carry its Ed25519 signature');
      assert.strictEqual(res.body.valid, true);
    });
  }

  it('serves the raw signed canary as text when the caller asks for text/plain', async () => {
    const res = await request(app).get('/.well-known/canary.txt').set('Accept', 'text/plain');

    assert.strictEqual(res.status, 200);
    assert.match(res.headers['content-type'], /text\/plain/);
    assert.match(res.text, /BEGIN NERONET WARRANT CANARY/);
  });

  it('keeps serving the canary under /api/nuke for the console', async () => {
    const res = await request(app).get('/api/nuke/canary');

    assert.strictEqual(res.status, 200);
    assert.ok(res.body.signature);
  });
});
