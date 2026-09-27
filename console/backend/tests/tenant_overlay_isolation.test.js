const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const config = require('../config/env');
const { setupTestDatabase } = require('./helpers/db');
const { createApp } = require('../server');
const { generateCurve25519Keypair } = require('../utils/crypto');
const ControlPlaneKeyService = require('../services/ControlPlaneKeyService');
const PreAuthKeyService = require('../services/PreAuthKeyService');
const AclEngine = require('../services/AclEngine');
const { buildNetmap } = require('../services/NetmapService');

// The overlay did not know about organisations. Every node on the platform was a
// candidate peer of every other, every ACL rule applied everywhere, and an
// organisation's default policy was stored but never compiled. Two organisations
// with no rules could reach each other's nodes, and a "deny" organisation was open.

describe('The overlay keeps organisations apart', () => {
  let dbHelper;
  let pool;
  let app;
  let adminId;

  const peersOf = (policy) => new Set(policy.outbound_rules.map((r) => r.allowed_peer_vip));

  let n = 0;
  async function addNode(id, orgId) {
    n += 1;
    const kp = generateCurve25519Keypair();
    await pool.query(
      `INSERT INTO nodes (id, user_id, organization_id, name, public_key, overlay_ipv4, overlay_ipv6)
       VALUES ($1, $2, $3, $1, $4, $5, $6)`,
      [id, adminId, orgId, kp.publicKeyHex, `100.64.99.${n}`, `fd7a:115c:a1e0::99:${n}`]
    );
    return `100.64.99.${n}`;
  }

  function token(id, role, orgId) {
    return jwt.sign({ sub: id, id, username: id, role, organization_id: orgId }, config.JWT_SECRET);
  }

  const vip = {};

  before(async () => {
    dbHelper = await setupTestDatabase();
    pool = dbHelper.pool;
    app = createApp();

    adminId = (await pool.query("SELECT id FROM users WHERE role = 'super-admin' LIMIT 1")).rows[0].id;
    await pool.query(
      `INSERT INTO organizations (id, name, slug, default_policy) VALUES
         ('org-iso-open', 'Open Co', 'open-co', 'open'),
         ('org-iso-deny', 'Deny Co', 'deny-co', 'deny')`
    );

    vip.d1 = await addNode('node-iso-d1', null); // no organisation: the default one
    vip.d2 = await addNode('node-iso-d2', 'org-default');
    vip.o1 = await addNode('node-iso-o1', 'org-iso-open');
    vip.o2 = await addNode('node-iso-o2', 'org-iso-open');
    vip.x1 = await addNode('node-iso-x1', 'org-iso-deny');
    vip.x2 = await addNode('node-iso-x2', 'org-iso-deny');
  });

  after(async () => {
    if (dbHelper) await dbHelper.cleanup();
  });

  it('peers only with nodes of the same organisation', async () => {
    assert.deepStrictEqual(peersOf(await AclEngine.compilePolicyFor('node-iso-o1')), new Set([vip.o2]));

    // The default organisation also holds the seeded nodes; what matters is that d1
    // (no organisation recorded) sees d2 and nothing of the other two.
    const d1 = peersOf(await AclEngine.compilePolicyFor('node-iso-d1'));
    assert.ok(d1.has(vip.d2));
    for (const other of [vip.o1, vip.o2, vip.x1, vip.x2]) {
      assert.ok(!d1.has(other), `${other} belongs to another organisation`);
    }
  });

  it('keeps other organisations out of the netmap', async () => {
    const netmap = await buildNetmap('node-iso-o1');
    const peerVips = netmap.peers.map((p) => (p.allowed_ips || []).join(','));
    assert.ok(
      peerVips.every((ips) => ips.includes(vip.o2)),
      `only o2 may appear: ${JSON.stringify(peerVips)}`
    );
    assert.strictEqual(netmap.peers.length, 1);
  });

  it('compiles a deny default policy as no peers', async () => {
    assert.strictEqual((await AclEngine.compilePolicyFor('node-iso-x1')).outbound_rules.length, 0);
  });

  it("does not apply one organisation's rules to another", async () => {
    await AclEngine.createRule(
      { priority: 1, source_cidr: '0.0.0.0/0', destination_cidr: '0.0.0.0/0', action: 'ACCEPT' },
      { organizationId: 'org-iso-open' }
    );
    try {
      assert.strictEqual(
        (await AclEngine.compilePolicyFor('node-iso-x1')).outbound_rules.length,
        0,
        'an ACCEPT written for another organisation must not open this one'
      );
      assert.deepStrictEqual(peersOf(await AclEngine.compilePolicyFor('node-iso-o1')), new Set([vip.o2]));
    } finally {
      await pool.query("DELETE FROM acl_rules WHERE organization_id = 'org-iso-open'");
    }
  });

  it('enrols a node into the organisation of its pre-auth key', async () => {
    const pak = await PreAuthKeyService.createPreAuthKey({ ownerId: adminId, organizationId: 'org-iso-deny' });
    const kp = generateCurve25519Keypair();

    const ch = await request(app).post('/v4/control/challenge').send({});
    assert.strictEqual(ch.status, 200);
    const proof = ControlPlaneKeyService.computeClientProof(kp.privateKeyHex, ch.body.cp_public_key, ch.body.nonce);
    const reg = await request(app).post('/v4/control/register').send({
      public_key_hex: kp.publicKeyHex,
      role: 'CLIENT_ORIGIN',
      preauth_key: pak.secret,
      nonce: ch.body.nonce,
      proof
    });
    assert.strictEqual(reg.status, 200, JSON.stringify(reg.body));

    const row = await pool.query('SELECT organization_id FROM nodes WHERE public_key = $1', [kp.publicKeyHex]);
    assert.strictEqual(row.rows[0].organization_id, 'org-iso-deny');
  });

  it('config generation puts the node in the caller’s organisation and refuses auditors', async () => {
    await pool.query(
      `INSERT INTO users (id, username, email, password_hash, role, organization_id) VALUES
         ('usr-iso-member', 'isomember', 'isomember@iso.test', 'hash', 'user', 'org-iso-open'),
         ('usr-iso-auditor', 'isoauditor', 'isoauditor@iso.test', 'hash', 'user', 'org-iso-open')`
    );
    await pool.query(
      `INSERT INTO memberships (id, user_id, organization_id, role) VALUES
         ('mem-iso-member', 'usr-iso-member', 'org-iso-open', 'member'),
         ('mem-iso-auditor', 'usr-iso-auditor', 'org-iso-open', 'auditor')`
    );

    const auditor = await request(app)
      .post('/api/configs/generate')
      .set('Authorization', `Bearer ${token('usr-iso-auditor', 'user', 'org-iso-open')}`)
      .send({ name: 'auditor-node' });
    assert.strictEqual(auditor.status, 403);

    const member = await request(app)
      .post('/api/configs/generate')
      .set('Authorization', `Bearer ${token('usr-iso-member', 'user', 'org-iso-open')}`)
      .send({ name: 'member-node' });
    assert.strictEqual(member.status, 200, JSON.stringify(member.body));
    const row = await pool.query("SELECT organization_id FROM nodes WHERE name = 'member-node'");
    assert.strictEqual(row.rows[0].organization_id, 'org-iso-open');
  });

  it("lists only the rules that apply to the caller's organisation", async () => {
    await AclEngine.createRule(
      { priority: 5, source_cidr: '100.64.99.0/24', destination_cidr: '100.64.99.0/24', action: 'DROP' },
      { organizationId: 'org-iso-deny' }
    );
    const res = await request(app)
      .get('/api/acl/rules')
      .set('Authorization', `Bearer ${token('usr-iso-member', 'user', 'org-iso-open')}`);
    assert.strictEqual(res.status, 200);
    assert.ok(!res.body.rules.some((r) => r.organization_id === 'org-iso-deny'));
  });
});
