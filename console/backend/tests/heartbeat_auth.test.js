const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const request = require('supertest');

const testDbPath = path.resolve(__dirname, '../../data/test_heartbeat_auth.db');
process.env.SOVEREIGN_DB_PATH = testDbPath;

// The bridge only enforces the shared token when one is configured; with the
// variable unset it warns and lets every caller in, which is the development
// default the other bridge suites run under.
const REGISTRATION_TOKEN = crypto.randomBytes(24).toString('hex');
process.env.SOVEREIGN_REGISTRATION_TOKEN = REGISTRATION_TOKEN;

const { getDatabase, closeDatabase } = require('../db/index');
const { runMigrations } = require('../db/migrator');
const { seedDatabase } = require('../db/seed');
const { createApp } = require('../server');

/**
 * /v4/control/heartbeat was the only /v4/control handler that authenticated
 * nothing. It looked the node up first and answered 404 for an id it did not know
 * and 200 for one it did, so an unauthenticated caller could enumerate node ids and
 * forge telemetry and read the quarantine state of any node whose id they guessed.
 */

const GO_PUBKEY = 'c'.repeat(64);
const UNKNOWN_NODE_ID = 'pk_00000000deadbeef';

describe('Heartbeat authentication', () => {
  let app;
  let nodeId;

  before(async () => {
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
    const db = getDatabase(testDbPath);
    runMigrations(db);
    seedDatabase(db);
    app = createApp();

    const registered = await request(app)
      .post('/v4/control/register')
      .set('Authorization', `Bearer ${REGISTRATION_TOKEN}`)
      .send({ public_key_hex: GO_PUBKEY, role: 'RELAY', endpoints: [], capability: { country_code: 'DE' } });

    assert.strictEqual(registered.status, 200, `registration failed: ${JSON.stringify(registered.body)}`);
    nodeId = registered.body.assigned_node_id;
  });

  after(() => {
    closeDatabase();
    for (const suffix of ['', '-wal', '-shm']) {
      const f = `${testDbPath}${suffix}`;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  });

  it('refuses a heartbeat that carries no credential', async () => {
    const res = await request(app).post('/v4/control/heartbeat').send({ node_id: nodeId, cpu_usage_pct: 12 });

    assert.strictEqual(res.status, 401);
  });

  it('refuses a heartbeat that carries the wrong token', async () => {
    const res = await request(app)
      .post('/v4/control/heartbeat')
      .set('Authorization', `Bearer ${crypto.randomBytes(24).toString('hex')}`)
      .send({ node_id: nodeId });

    assert.strictEqual(res.status, 401);
  });

  it('answers an unauthenticated caller the same way whether the node exists or not', async () => {
    const known = await request(app).post('/v4/control/heartbeat').send({ node_id: nodeId });
    const unknown = await request(app).post('/v4/control/heartbeat').send({ node_id: UNKNOWN_NODE_ID });

    // The 404/200 split was an existence oracle: knowing which ids answer 200 is
    // the first half of forging another node's telemetry.
    assert.strictEqual(known.status, 401);
    assert.strictEqual(unknown.status, 401);
    assert.deepStrictEqual(known.body, unknown.body);
  });

  it('does not read the nodes table before authenticating', async () => {
    const db = getDatabase();
    const realPrepare = db.prepare.bind(db);
    let nodeReads = 0;

    db.prepare = (sql) => {
      if (/from\s+nodes/i.test(sql)) nodeReads += 1;
      return realPrepare(sql);
    };

    try {
      await request(app).post('/v4/control/heartbeat').send({ node_id: nodeId });
      await request(app).post('/v4/control/heartbeat').send({ node_id: UNKNOWN_NODE_ID });
    } finally {
      delete db.prepare;
    }

    // Rejecting after the lookup would still leak existence through timing and
    // would let an anonymous caller drive database work.
    assert.strictEqual(nodeReads, 0, `the handler read the nodes table ${nodeReads} time(s) before authenticating`);
  });

  it('accepts a heartbeat that carries the enrolment token', async () => {
    const res = await request(app)
      .post('/v4/control/heartbeat')
      .set('Authorization', `Bearer ${REGISTRATION_TOKEN}`)
      .send({ node_id: nodeId, cpu_usage_pct: 12, rtt_ms: 7 });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.acknowledged, true);
    assert.strictEqual(typeof res.body.policy_epoch, 'number');
  });

  it('still answers 404 for an unknown node once the caller is authenticated', async () => {
    const res = await request(app)
      .post('/v4/control/heartbeat')
      .set('Authorization', `Bearer ${REGISTRATION_TOKEN}`)
      .send({ node_id: UNKNOWN_NODE_ID });

    assert.strictEqual(res.status, 404);
  });
});
