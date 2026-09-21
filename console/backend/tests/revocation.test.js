const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const request = require('supertest');

const { setupTestDatabase } = require('./helpers/db');
const { createApp } = require('../server');
const RevocationEngine = require('../services/RevocationEngine');
const AclEngine = require('../services/AclEngine');

/**
 * Revoking used to change a database row and broadcast an event to the console.
 * Nothing reached a node: the tunnel stayed up and the withdrawn device stayed
 * reachable. HeartbeatResponse has carried revoked_keys since the protocol was
 * written and it was always empty, with no consumer on the node either.
 */

function registerBody(publicKeyHex, overrides = {}) {
  return {
    public_key_hex: publicKeyHex,
    role: 'CLIENT_ORIGIN',
    endpoints: [],
    capability: { country_code: 'IT' },
    ...overrides
  };
}

describe('Key revocation', () => {
  let app;
  let dbHelper;
  let alpha;
  let beta;
  let betaKey;

  before(async () => {
    dbHelper = await setupTestDatabase();
    app = createApp();

    betaKey = crypto.randomBytes(32).toString('hex');
    alpha = (
      await request(app)
        .post('/v4/control/register')
        .send(registerBody('a'.repeat(64)))
    ).body;
    beta = (await request(app).post('/v4/control/register').send(registerBody(betaKey))).body;
  });

  after(async () => {
    if (dbHelper) {
      await dbHelper.cleanup();
    }
  });

  beforeEach(async () => {
    await dbHelper.pool.query('DELETE FROM revoked_keys');
  });

  it('delivers a revoked key on the next heartbeat', async () => {
    const before = await request(app)
      .post('/v4/control/heartbeat')
      .send({ node_id: alpha.assigned_node_id, cpu_usage_pct: 1 });

    assert.deepStrictEqual(before.body.revoked_keys, []);

    await RevocationEngine.revokeNodeKeys([beta.assigned_node_id], { reason: 'test' });

    const after = await request(app)
      .post('/v4/control/heartbeat')
      .send({ node_id: alpha.assigned_node_id, cpu_usage_pct: 1 });

    // This is the only channel that reaches a running node.
    assert.ok(after.body.revoked_keys.includes(betaKey), 'the revoked key never reached the node');
  });

  it('raises the ACL epoch so peers drop the revoked node', async () => {
    const before = await AclEngine.getEpoch('acl');
    await RevocationEngine.revokeNodeKeys([beta.assigned_node_id], { reason: 'test' });
    const after = await AclEngine.getEpoch('acl');

    // Without this the revoked peer stays in every other node's compiled policy
    // until something else happens to change it.
    assert.ok(after > before, 'revocation did not invalidate existing policies');
  });

  it('is idempotent', async () => {
    await RevocationEngine.revokeNodeKeys([beta.assigned_node_id], { reason: 'first' });
    await RevocationEngine.revokeNodeKeys([beta.assigned_node_id], { reason: 'second' });

    const active = await RevocationEngine.activeRevocations();

    // The control plane sends a window rather than a per-node cursor precisely
    // because applying a revocation twice must be harmless.
    assert.strictEqual(active.filter((k) => k === betaKey).length, 1);
  });

  it('stops delivering a revocation once it expires', async () => {
    await RevocationEngine.revokeNodeKeys([beta.assigned_node_id], { reason: 'test' });

    await dbHelper.pool.query(
      "UPDATE revoked_keys SET expires_at = NOW() - INTERVAL '1 hour' WHERE public_key_hex = $1",
      [betaKey]
    );

    const active = await RevocationEngine.activeRevocations();

    // Past the window a node has re-synced its policy anyway, and the revoked peer
    // is no longer in it. Delivering forever would grow the heartbeat without bound.
    assert.ok(!active.includes(betaKey));
  });

  it('purges expired entries', async () => {
    await RevocationEngine.revokeNodeKeys([beta.assigned_node_id], { reason: 'test' });
    await dbHelper.pool.query("UPDATE revoked_keys SET expires_at = NOW() - INTERVAL '1 hour'");

    await RevocationEngine.purgeExpired();

    const res = await dbHelper.pool.query('SELECT count(*) AS n FROM revoked_keys');
    const count = parseInt(res.rows[0].n, 10);
    assert.strictEqual(count, 0);
  });

  it('revokes every node a user owns', async () => {
    const ownerRes = await dbHelper.pool.query('SELECT user_id FROM nodes WHERE id = $1', [beta.assigned_node_id]);
    const owner = ownerRes.rows[0].user_id;

    const revoked = await RevocationEngine.revokeUserNodes(owner, { reason: 'user_destroyed' });

    assert.ok(revoked.includes(betaKey));
    assert.ok(revoked.length >= 2, 'both registered nodes share the seeded owner and should both be revoked');
  });

  it('skips a node whose stored key is unusable rather than failing the batch', async () => {
    await dbHelper.pool.query(
      `INSERT INTO nodes (id, user_id, name, public_key, overlay_ipv4, overlay_ipv6, role)
       VALUES ('broken', (SELECT user_id FROM nodes LIMIT 1), 'broken', 'not-a-key', '100.64.250.99', 'fd7a:115c:a1e0::ff99', 'RELAY')`
    );

    // Rows written before the bridge spoke the right contract carry placeholders. One
    // of them must not stop the rest of a revocation from being applied.
    const revoked = await RevocationEngine.revokeNodeKeys(['broken', beta.assigned_node_id], { reason: 'test' });

    assert.ok(revoked.includes(betaKey));
    assert.strictEqual(revoked.length, 1);

    await dbHelper.pool.query("DELETE FROM nodes WHERE id = 'broken'");
  });

  it('does nothing for an empty list', async () => {
    assert.deepStrictEqual(await RevocationEngine.revokeNodeKeys([]), []);
  });
});
