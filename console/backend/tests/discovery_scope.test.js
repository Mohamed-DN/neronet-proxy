const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');

const { setupTestDatabase } = require('./helpers/db');
const { createApp } = require('../server');
const NodeCredentialService = require('../services/NodeCredentialService');
const RevocationEngine = require('../services/RevocationEngine');
const AclEngine = require('../services/AclEngine');
const { buildNetmap } = require('../services/NetmapService');
const {
  seedHiddenTier,
  NODES,
  ORG_A,
  ORG_B,
  DEFAULT_COMPARTMENT,
  HIDDEN_COMPARTMENT
} = require('./helpers/hiddenTier');

describe('Discovery confines node credentials to their permitted overlay peers', () => {
  let db;
  let app;
  let credential;
  let previousToken;

  const discover = (body = {}, token = credential) =>
    request(app).post('/v4/control/discover').set('Authorization', `Bearer ${token}`).send(body);
  const ids = (response) => response.body.bridges.map((bridge) => bridge.node_id).sort();

  before(async () => {
    db = await setupTestDatabase();
    app = createApp();
    await seedHiddenTier(db.pool);
    await db.pool.query(
      `UPDATE nodes SET role = 'RELAY', last_heartbeat = NOW(), country_code = 'IT',
                        endpoints = '["198.51.100.7:51820"]'::jsonb, latency_ms = 100
       WHERE id = ANY($1::text[])`,
      [[NODES.v2.id, NODES.h1.id, NODES.b1.id]]
    );
    // The foreign relay wins the old global ranking, even when limit is one.
    await db.pool.query('UPDATE nodes SET latency_ms = 1 WHERE id = $1', [NODES.b1.id]);
    credential = (await NodeCredentialService.mintCredential(NODES.v1.id)).credential;
    previousToken = process.env.SOVEREIGN_REGISTRATION_TOKEN;
    process.env.SOVEREIGN_REGISTRATION_TOKEN = 'discovery-scope-enrolment-only';
  });

  after(async () => {
    if (previousToken === undefined) delete process.env.SOVEREIGN_REGISTRATION_TOKEN;
    else process.env.SOVEREIGN_REGISTRATION_TOKEN = previousToken;
    if (db) await db.cleanup();
  });

  it('returns the own permitted relay with usable wire fields, excluding foreign and isolated compartments', async () => {
    const response = await discover({ limit: 100 });
    assert.strictEqual(response.status, 200, JSON.stringify(response.body));
    assert.deepStrictEqual(ids(response), [NODES.v2.id]);
    assert.strictEqual(response.body.bridges[0].public_key_hex.length, 64);
    assert.strictEqual(response.body.bridges[0].overlay_ipv4, NODES.v2.vip);
    assert.ok(response.body.bridges[0].endpoints.length > 0);
  });

  it('applies tenant and compartment scope before ranking and limit', async () => {
    const response = await discover({ target_country: 'IT', limit: 1 });
    assert.strictEqual(response.status, 200);
    assert.deepStrictEqual(ids(response), [NODES.v2.id]);
  });

  it('answers explicit foreign and unknown relay IDs with the same empty result', async () => {
    const foreign = await discover({ explicit_host_id: NODES.b1.id });
    const unknown = await discover({ explicit_host_id: 'node-discovery-absent' });
    assert.strictEqual(foreign.status, 200);
    assert.deepStrictEqual(foreign.body, unknown.body);
    assert.deepStrictEqual(foreign.body, { bridges: [] });
  });

  it('does not reveal an isolated compartment through an explicit relay ID', async () => {
    const response = await discover({ explicit_host_id: NODES.h1.id });
    assert.strictEqual(response.status, 200);
    assert.deepStrictEqual(response.body.bridges, []);
  });

  it('offers a hidden compartment peer only when the data-plane peering grants it', async () => {
    await db.pool.query(
      `INSERT INTO compartment_peerings (id, organization_id, src_compartment_id, dst_compartment_id, policy)
       VALUES ('peer-discovery-scope', $1, $2, $3, 'allow')`,
      [ORG_A, DEFAULT_COMPARTMENT, HIDDEN_COMPARTMENT]
    );
    try {
      const netmap = await buildNetmap(NODES.v1.id);
      assert.ok(netmap.peers.some((peer) => peer.node_id === NODES.h1.id));
      const response = await discover({ limit: 100 });
      assert.strictEqual(response.status, 200);
      assert.deepStrictEqual(ids(response), [NODES.h1.id, NODES.v2.id].sort());
    } finally {
      await db.pool.query("DELETE FROM compartment_peerings WHERE id = 'peer-discovery-scope'");
    }
  });

  it('withholds a relay excluded by the compiled DROP rules', async () => {
    for (const [source, destination] of [
      [NODES.v1.vip, NODES.v2.vip],
      [NODES.v2.vip, NODES.v1.vip]
    ]) {
      await AclEngine.createRule(
        {
          priority: 1,
          source_cidr: `${source}/32`,
          destination_cidr: `${destination}/32`,
          action: 'DROP',
          description: 'discovery-scope-test'
        },
        { organizationId: ORG_A }
      );
    }
    try {
      assert.ok(!(await buildNetmap(NODES.v1.id)).peers.some((peer) => peer.node_id === NODES.v2.id));
      const response = await discover({ explicit_host_id: NODES.v2.id });
      assert.strictEqual(response.status, 200);
      assert.deepStrictEqual(response.body.bridges, []);
    } finally {
      await db.pool.query("DELETE FROM acl_rules WHERE organization_id = $1 AND description = 'discovery-scope-test'", [
        ORG_A
      ]);
    }
  });

  it('uses the current node organisation rather than retaining its former scope', async () => {
    await db.pool.query('UPDATE nodes SET organization_id = $1 WHERE id = $2', [ORG_B, NODES.v1.id]);
    try {
      const response = await discover({ limit: 100 });
      assert.strictEqual(response.status, 200);
      assert.deepStrictEqual(ids(response), [NODES.b1.id]);
    } finally {
      await db.pool.query('UPDATE nodes SET organization_id = $1 WHERE id = $2', [ORG_A, NODES.v1.id]);
    }
  });

  it('does not enumerate relays in a deny organisation without an ACCEPT', async () => {
    await db.pool.query("UPDATE organizations SET default_policy = 'deny' WHERE id = $1", [ORG_A]);
    try {
      const response = await discover({ limit: 100 });
      assert.strictEqual(response.status, 200);
      assert.deepStrictEqual(response.body.bridges, []);
    } finally {
      await db.pool.query("UPDATE organizations SET default_policy = 'open' WHERE id = $1", [ORG_A]);
    }
  });

  it('does not advertise a revoked key whose node row still exists', async () => {
    await RevocationEngine.revokeNodeKeys(NODES.v2.id, { reason: 'discovery-scope-test' });
    try {
      const response = await discover({ explicit_host_id: NODES.v2.id });
      assert.strictEqual(response.status, 200);
      assert.deepStrictEqual(response.body.bridges, []);
    } finally {
      await db.pool.query("DELETE FROM revoked_keys WHERE node_id = $1 AND reason = 'discovery-scope-test'", [
        NODES.v2.id
      ]);
    }
  });

  it('keeps the explicitly authenticated fleet-inventory compatibility path', async () => {
    const response = await discover({ explicit_host_id: NODES.b1.id }, 'discovery-scope-enrolment-only');
    assert.strictEqual(response.status, 200);
    assert.deepStrictEqual(ids(response), [NODES.b1.id]);
  });

  it('refuses a revoked caller credential before discovery', async () => {
    const revoked = await NodeCredentialService.mintCredential(NODES.v1.id);
    await db.pool.query('UPDATE node_credentials SET revoked_at = NOW() WHERE id = $1', [revoked.credentialId]);
    const response = await discover({}, revoked.credential);
    assert.strictEqual(response.status, 401);
    assert.strictEqual(response.body.bridges, undefined);
  });
});
