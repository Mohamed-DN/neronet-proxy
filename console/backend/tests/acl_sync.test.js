const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const request = require('supertest');

const testDbPath = path.resolve(__dirname, '../../data/test_acl_sync.db');
process.env.SOVEREIGN_DB_PATH = testDbPath;

const { getDatabase, closeDatabase } = require('../db/index');
const { runMigrations } = require('../db/migrator');
const { seedDatabase } = require('../db/seed');
const { createApp } = require('../server');
const AclEngine = require('../services/AclEngine');

/**
 * pkg/acl compiles and enforces zero-trust policy correctly and was handed nothing,
 * because /v4/control/sync-acls did not exist. Every rule configured in the console
 * had no effect on any node.
 */

function registerBody(publicKeyHex, overrides = {}) {
  return {
    public_key_hex: publicKeyHex,
    role: 'CLIENT_ORIGIN',
    endpoints: [],
    capability: { country_code: 'IT', ip_class: 'RESIDENTIAL' },
    ...overrides
  };
}

describe('CIDR matching', () => {
  it('matches addresses inside a range and rejects those outside', () => {
    assert.ok(AclEngine.cidrContains('100.64.0.0/10', '100.64.0.1'));
    assert.ok(AclEngine.cidrContains('100.64.0.0/10', '100.127.255.254'));
    assert.ok(!AclEngine.cidrContains('100.64.0.0/10', '100.128.0.1'));
    assert.ok(!AclEngine.cidrContains('100.64.0.0/10', '10.0.0.1'));
  });

  it('treats a bare address as a /32', () => {
    assert.ok(AclEngine.cidrContains('100.64.0.5', '100.64.0.5'));
    assert.ok(!AclEngine.cidrContains('100.64.0.5', '100.64.0.6'));
  });

  it('handles /0 and the any wildcards', () => {
    for (const any of ['0.0.0.0/0', 'any', '*']) {
      assert.ok(AclEngine.cidrContains(any, '8.8.8.8'), `${any} should match everything`);
    }
  });

  it('normalises a non-aligned prefix to its network address', () => {
    // 100.64.5.7/24 describes 100.64.5.0-255, not a range starting at .7.
    assert.ok(AclEngine.cidrContains('100.64.5.7/24', '100.64.5.1'));
    assert.ok(!AclEngine.cidrContains('100.64.5.7/24', '100.64.6.1'));
  });

  it('rejects malformed input rather than matching it', () => {
    assert.strictEqual(AclEngine.parseCidr('not-a-cidr'), null);
    assert.strictEqual(AclEngine.parseCidr('100.64.0.0/33'), null);
    assert.strictEqual(AclEngine.parseCidr('300.1.1.1/24'), null);
    assert.ok(!AclEngine.cidrContains('100.64.0.0/8', 'nonsense'));
  });
});

describe('ACL policy delivery', () => {
  let app;
  let alpha;
  let beta;
  let gamma;

  before(async () => {
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
    const db = getDatabase(testDbPath);
    runMigrations(db);
    seedDatabase(db);
    app = createApp();

    const register = async (key) =>
      (await request(app).post('/v4/control/register').send(registerBody(key))).body;

    alpha = await register('a'.repeat(64));
    beta = await register('b'.repeat(64));
    gamma = await register('c'.repeat(64));
  });

  after(() => {
    closeDatabase();
    for (const suffix of ['', '-wal', '-shm']) {
      const f = `${testDbPath}${suffix}`;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  });

  beforeEach(() => {
    getDatabase().prepare('DELETE FROM acl_rules').run();
  });

  async function sync(nodeId, epoch = 0) {
    return request(app).post('/v4/control/sync-acls').send({ node_id: nodeId, policy_epoch: epoch });
  }

  it('permits every peer when no rules are configured', async () => {
    // pkg/acl defaults to deny, so an empty rule set delivered to a fleet would
    // black-hole all traffic the moment delivery was switched on. A mesh with no
    // policy written is open; it closes when the first rule is written.
    const res = await sync(alpha.assigned_node_id);

    assert.strictEqual(res.status, 200);
    const peers = res.body.policy.outbound_rules.map((r) => r.allowed_peer_vip);

    assert.ok(peers.includes(beta.overlay_ipv4));
    assert.ok(peers.includes(gamma.overlay_ipv4));
    assert.ok(res.body.policy.outbound_rules.every((r) => r.action === 'ACCEPT'));
  });

  it('never includes the node itself as a peer', async () => {
    const res = await sync(alpha.assigned_node_id);
    const peers = res.body.policy.outbound_rules.map((r) => r.allowed_peer_vip);

    assert.ok(!peers.includes(alpha.overlay_ipv4), 'a node was given a rule allowing itself');
  });

  it('expands a CIDR rule to only the peers it covers', async () => {
    // Rules are authored against CIDRs; pkg/acl matches an exact peer address with
    // net.IP.Equal. The expansion is what makes the two meet.
    await AclEngine.createRule({
      source_cidr: '0.0.0.0/0',
      destination_cidr: `${beta.overlay_ipv4}/32`,
      protocol: 'TCP',
      port_start: 443,
      port_end: 443,
      action: 'ACCEPT'
    });

    const res = await sync(alpha.assigned_node_id);
    const outbound = res.body.policy.outbound_rules;

    assert.strictEqual(outbound.length, 1, `expected one rule, got ${outbound.length}`);
    assert.strictEqual(outbound[0].allowed_peer_vip, beta.overlay_ipv4);
    assert.strictEqual(outbound[0].protocol, 'TCP');
    assert.deepStrictEqual(outbound[0].port_ranges, [{ start: 443, end: 443 }]);
  });

  it('compiles inbound and outbound from the same rule, per direction', async () => {
    await AclEngine.createRule({
      source_cidr: `${alpha.overlay_ipv4}/32`,
      destination_cidr: `${beta.overlay_ipv4}/32`,
      protocol: 'ALL',
      action: 'ACCEPT'
    });

    const alphaPolicy = (await sync(alpha.assigned_node_id)).body.policy;
    const betaPolicy = (await sync(beta.assigned_node_id)).body.policy;

    // Alpha may reach Beta outbound; Beta accepts Alpha inbound. Neither gets the
    // other direction from this rule.
    assert.deepStrictEqual(alphaPolicy.outbound_rules.map((r) => r.allowed_peer_vip), [beta.overlay_ipv4]);
    assert.deepStrictEqual(alphaPolicy.inbound_rules, []);
    assert.deepStrictEqual(betaPolicy.inbound_rules.map((r) => r.allowed_peer_vip), [alpha.overlay_ipv4]);
    assert.deepStrictEqual(betaPolicy.outbound_rules, []);
  });

  it('carries a DROP action through rather than omitting the rule', async () => {
    await AclEngine.createRule({
      source_cidr: '0.0.0.0/0',
      destination_cidr: `${gamma.overlay_ipv4}/32`,
      protocol: 'ALL',
      action: 'DROP'
    });

    const res = await sync(alpha.assigned_node_id);
    const rule = res.body.policy.outbound_rules.find((r) => r.allowed_peer_vip === gamma.overlay_ipv4);

    // An explicit DROP must beat a later ACCEPT; dropping the rule entirely would
    // leave the decision to default-deny, which is not the same thing.
    assert.ok(rule, 'the DROP rule was not delivered');
    assert.strictEqual(rule.action, 'DROP');
  });

  it('excludes quarantined peers', async () => {
    getDatabase().prepare('UPDATE nodes SET is_quarantined = 1 WHERE id = ?').run(gamma.assigned_node_id);

    const res = await sync(alpha.assigned_node_id);
    const peers = res.body.policy.outbound_rules.map((r) => r.allowed_peer_vip);

    assert.ok(!peers.includes(gamma.overlay_ipv4), 'a quarantined peer was still reachable');

    getDatabase().prepare('UPDATE nodes SET is_quarantined = 0 WHERE id = ?').run(gamma.assigned_node_id);
  });

  it('answers an unchanged epoch without transferring a policy', async () => {
    const first = await sync(alpha.assigned_node_id, 0);
    const epoch = first.body.new_policy_epoch;

    const second = await sync(alpha.assigned_node_id, epoch);

    assert.strictEqual(second.body.new_policy_epoch, epoch);
    assert.strictEqual(second.body.policy, null);
  });

  it('bumps the epoch when a rule changes', async () => {
    const before = await AclEngine.getEpoch('acl');
    await AclEngine.createRule({ source_cidr: '0.0.0.0/0', destination_cidr: '0.0.0.0/0' });
    const after = await AclEngine.getEpoch('acl');

    assert.ok(after > before, 'a rule change left nodes holding a stale policy');
  });

  it('bumps the epoch when a node joins', async () => {
    // Rules expand per peer, so the compiled result changes when the fleet changes.
    // Missing this leaves rules identical while the peers they expand to are not.
    const before = await AclEngine.getEpoch('acl');
    await request(app).post('/v4/control/register').send(registerBody('d'.repeat(64)));
    const after = await AclEngine.getEpoch('acl');

    assert.ok(after > before, 'a new node did not invalidate existing policies');
  });

  // The epoch a node holds only ever changes through register and heartbeat. Both
  // returned a hardcoded 0, so cmd/sovereign-node's `hbResp.PolicyEpoch > policyEpoch`
  // was permanently false and a running node never learned a rule had changed --
  // policy delivery worked once, at enrolment, and never again.
  //
  // The earlier tests missed this because they called sync-acls directly instead of
  // going through the path a node actually uses.
  it('reports the current epoch on registration', async () => {
    await AclEngine.bumpEpoch('acl');
    const epoch = await AclEngine.getEpoch('acl');

    const res = await request(app)
      .post('/v4/control/register')
      .send(registerBody('e'.repeat(64)));

    assert.strictEqual(res.body.policy_epoch, epoch + 1, 'registration itself bumps the epoch, and must report the new one');
    assert.ok(res.body.route_epoch >= 1);
  });

  it('reports a raised epoch on heartbeat so a running node re-syncs', async () => {
    const reg = await request(app).post('/v4/control/register').send(registerBody('f'.repeat(64)));
    const held = reg.body.policy_epoch;

    const before = await request(app)
      .post('/v4/control/heartbeat')
      .send({ node_id: reg.body.assigned_node_id, cpu_usage_pct: 1 });

    assert.strictEqual(before.body.policy_epoch, held, 'nothing changed, so the node must not re-sync');

    await AclEngine.createRule({ source_cidr: '0.0.0.0/0', destination_cidr: '0.0.0.0/0' });

    const after = await request(app)
      .post('/v4/control/heartbeat')
      .send({ node_id: reg.body.assigned_node_id, cpu_usage_pct: 1 });

    assert.ok(
      after.body.policy_epoch > held,
      `heartbeat reported ${after.body.policy_epoch}, node holds ${held}: a rule change would never reach it`
    );
  });

  it('refuses an unknown node', async () => {
    const res = await sync('pk_0000000000000000');
    assert.strictEqual(res.status, 404);
  });

  it('requires the enrolment token when one is configured', async () => {
    process.env.SOVEREIGN_REGISTRATION_TOKEN = 'acl-token';
    try {
      const denied = await sync(alpha.assigned_node_id);
      assert.strictEqual(denied.status, 401);

      const allowed = await request(app)
        .post('/v4/control/sync-acls')
        .set('Authorization', 'Bearer acl-token')
        .send({ node_id: alpha.assigned_node_id, policy_epoch: 0 });
      assert.strictEqual(allowed.status, 200);
    } finally {
      delete process.env.SOVEREIGN_REGISTRATION_TOKEN;
    }
  });
});
