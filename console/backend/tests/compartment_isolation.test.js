const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const REGISTRATION_TOKEN = crypto.randomBytes(24).toString('hex');
process.env.SOVEREIGN_REGISTRATION_TOKEN = REGISTRATION_TOKEN;

const config = require('../config/env');
const { setupTestDatabase } = require('./helpers/db');
const { createApp } = require('../server');
const AclEngine = require('../services/AclEngine');
const { nodeKey, register } = require('./helpers/nodeEnrolment');

/**
 * Compartments are sub-networks the data plane enforces (ADR 0021). Each test goes
 * through the console API an operator uses, then asks for the netmaps the nodes would
 * receive: the peer set is what decides who can open a tunnel to whom.
 *
 * The nodes are enrolled over the control plane, as a real fleet is, so they carry no
 * organisation and no compartment: they are in the default compartment of the default
 * organisation, which is the case that has to keep working untouched.
 */

const ORG = 'org-default';
const DEFAULT_COMPARTMENT = `cmp-${ORG}`;
const OTHER_ORG = 'org-cmp-elsewhere';

const credentials = new Map();

async function registerNode(app) {
  const res = await register(
    app,
    { public_key_hex: nodeKey(), role: 'CLIENT_ORIGIN', endpoints: [], capability: { country_code: 'IT' } },
    { token: REGISTRATION_TOKEN }
  );
  assert.strictEqual(res.status, 200, `registration failed: ${JSON.stringify(res.body)}`);
  credentials.set(res.body.assigned_node_id, res.body.credential);
  return { id: res.body.assigned_node_id, vip: res.body.overlay_ipv4 };
}

async function peersOf(app, node) {
  const res = await request(app)
    .post('/v4/control/netmap')
    .set('Authorization', `Bearer ${credentials.get(node.id)}`)
    .send({ node_id: node.id, version: 0 });
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  return res.body.peers.map((p) => p.node_id).sort();
}

describe('Compartments isolate in the data plane', () => {
  let dbHelper;
  let app;
  let ownerToken;
  let alpha;
  let beta;
  let gamma;
  let hiddenId;
  let foreignId;

  const api = (method, path) => request(app)[method](path).set('Authorization', `Bearer ${ownerToken}`);

  async function createCompartment(name) {
    const res = await api('post', '/api/compartments').send({ name });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    return res.body.compartment.id;
  }

  async function moveInto(compartmentId, nodes) {
    const res = await api('post', `/api/compartments/${compartmentId}/members`).send({
      node_ids: nodes.map((n) => n.id)
    });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    return res.body.moved;
  }

  before(async () => {
    dbHelper = await setupTestDatabase();
    const { pool } = dbHelper;
    await pool.query("DELETE FROM nodes WHERE id LIKE 'svrn-node-seed%'");
    app = createApp();

    await pool.query(
      `INSERT INTO organizations (id, name, slug, default_policy) VALUES ($1, 'Default', 'default-org', 'open')
       ON CONFLICT (id) DO UPDATE SET default_policy = 'open'`,
      [ORG]
    );
    await pool.query(
      `INSERT INTO compartments (id, organization_id, name, slug, subnet_cidr, is_hidden)
       VALUES ($1, $2, 'Default Compartment', 'default', '100.64.0.0/24', FALSE) ON CONFLICT (id) DO NOTHING`,
      [DEFAULT_COMPARTMENT, ORG]
    );
    await pool.query(
      `INSERT INTO users (id, username, email, password_hash, role, organization_id)
       VALUES ('usr-cmp-iso', 'cmpiso', 'cmpiso@example.test', 'x', 'user', $1) ON CONFLICT (id) DO NOTHING`,
      [ORG]
    );
    await pool.query(
      `INSERT INTO memberships (id, user_id, organization_id, role) VALUES ('mem-cmp-iso', 'usr-cmp-iso', $1, 'owner')
       ON CONFLICT (user_id, organization_id) DO NOTHING`,
      [ORG]
    );
    ownerToken = jwt.sign(
      {
        sub: 'usr-cmp-iso',
        id: 'usr-cmp-iso',
        username: 'cmpiso',
        role: 'user',
        organization_id: ORG,
        compartment_access: 'standard'
      },
      config.JWT_SECRET
    );

    // A hidden compartment of this organisation, and a compartment of another one.
    hiddenId = 'cmp-iso-hidden';
    await pool.query(
      `INSERT INTO compartments (id, organization_id, name, slug, subnet_cidr, is_hidden)
       VALUES ($1, $2, 'Vault', 'vault', '100.64.9.0/24', TRUE)`,
      [hiddenId, ORG]
    );
    await pool.query(
      `INSERT INTO organizations (id, name, slug, default_policy) VALUES ($1, 'Elsewhere', 'elsewhere', 'open')`,
      [OTHER_ORG]
    );
    foreignId = 'cmp-iso-foreign';
    await pool.query(
      `INSERT INTO compartments (id, organization_id, name, slug, subnet_cidr, is_hidden)
       VALUES ($1, $2, 'Theirs', 'theirs', '100.64.8.0/24', FALSE)`,
      [foreignId, OTHER_ORG]
    );

    alpha = await registerNode(app);
    beta = await registerNode(app);
    gamma = await registerNode(app);
  });

  after(async () => {
    if (dbHelper) await dbHelper.cleanup();
  });

  beforeEach(async () => {
    const { pool } = dbHelper;
    await pool.query('UPDATE nodes SET compartment_id = NULL');
    await pool.query('DELETE FROM compartment_peerings');
    await pool.query('DELETE FROM compartments WHERE organization_id = $1 AND id NOT IN ($2, $3)', [
      ORG,
      DEFAULT_COMPARTMENT,
      hiddenId
    ]);
    for (const rule of await AclEngine.listRules()) await AclEngine.deleteRule(rule.id);
  });

  it('leaves a fleet with no sub-network as one mesh', async () => {
    assert.deepStrictEqual(await peersOf(app, alpha), [beta.id, gamma.id].sort());
    assert.deepStrictEqual(await peersOf(app, gamma), [alpha.id, beta.id].sort());
  });

  it('isolates the devices moved into a sub-network from the rest', async () => {
    const lab = await createCompartment('Lab');
    const before = await AclEngine.getEpoch('acl');
    assert.deepStrictEqual(await moveInto(lab, [alpha, beta]), [alpha.id, beta.id].sort());
    assert.ok((await AclEngine.getEpoch('acl')) > before, 'moving devices must make the fleet recompile');

    assert.deepStrictEqual(await peersOf(app, alpha), [beta.id]);
    assert.deepStrictEqual(await peersOf(app, beta), [alpha.id]);
    assert.deepStrictEqual(await peersOf(app, gamma), []);
  });

  it('connects two sub-networks both ways, and disconnects them again', async () => {
    const lab = await createCompartment('Lab');
    await moveInto(lab, [alpha]);

    const created = await api('post', '/api/compartments/peerings/create').send({
      src_compartment_id: lab,
      dst_compartment_id: DEFAULT_COMPARTMENT,
      policy: 'allow'
    });
    assert.strictEqual(created.status, 201, JSON.stringify(created.body));
    assert.deepStrictEqual(await peersOf(app, alpha), [beta.id, gamma.id].sort());
    assert.deepStrictEqual(await peersOf(app, gamma), [alpha.id, beta.id].sort(), 'a peering works in both directions');

    const removed = await api('delete', `/api/compartments/peerings/${created.body.peering.id}`);
    assert.strictEqual(removed.status, 200);
    assert.deepStrictEqual(await peersOf(app, alpha), []);
    assert.deepStrictEqual(await peersOf(app, gamma), [beta.id]);
  });

  it('does not let an ACL rule reach across a sub-network boundary', async () => {
    const lab = await createCompartment('Lab');
    await moveInto(lab, [alpha]);
    await AclEngine.createRule({
      priority: 1,
      source_cidr: `${alpha.vip}/32`,
      destination_cidr: `${gamma.vip}/32`,
      action: 'ACCEPT'
    });
    await AclEngine.createRule({
      priority: 1,
      source_cidr: `${gamma.vip}/32`,
      destination_cidr: `${alpha.vip}/32`,
      action: 'ACCEPT'
    });

    assert.deepStrictEqual(await peersOf(app, alpha), []);
    assert.deepStrictEqual(await peersOf(app, gamma), []);
  });

  it('gives the simulator the boundary too', async () => {
    const lab = await createCompartment('Lab');
    await moveInto(lab, [alpha]);
    const across = await AclEngine.simulatePacket({
      source_ip: alpha.vip,
      destination_ip: gamma.vip,
      defaultPolicy: 'open',
      organizationId: ORG
    });
    const inside = await AclEngine.simulatePacket({
      source_ip: beta.vip,
      destination_ip: gamma.vip,
      defaultPolicy: 'open',
      organizationId: ORG
    });
    assert.strictEqual(across.verdict, 'DROP');
    assert.strictEqual(inside.verdict, 'ACCEPT');
  });

  it('returns the devices of a deleted sub-network to the default one', async () => {
    const lab = await createCompartment('Lab');
    await moveInto(lab, [alpha, beta]);
    assert.deepStrictEqual(await peersOf(app, gamma), []);

    const res = await api('delete', `/api/compartments/${lab}`);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.deepStrictEqual(await peersOf(app, gamma), [alpha.id, beta.id].sort());
  });

  it("refuses a peering with another organisation's compartment", async () => {
    const res = await api('post', '/api/compartments/peerings/create').send({
      src_compartment_id: DEFAULT_COMPARTMENT,
      dst_compartment_id: foreignId
    });
    assert.strictEqual(res.status, 404);
  });

  it('treats a hidden compartment as absent below the root tier', async () => {
    const peer = await api('post', '/api/compartments/peerings/create').send({
      src_compartment_id: DEFAULT_COMPARTMENT,
      dst_compartment_id: hiddenId
    });
    assert.strictEqual(peer.status, 404, 'peering with a hidden compartment must read as not found');

    const move = await api('post', `/api/compartments/${hiddenId}/members`).send({ node_ids: [alpha.id] });
    assert.strictEqual(move.status, 404);

    // A peering that already exists must not leak the hidden compartment's name.
    await dbHelper.pool.query(
      `INSERT INTO compartment_peerings (id, organization_id, src_compartment_id, dst_compartment_id, policy)
       VALUES ('peer-iso-hidden', $1, $2, $3, 'allow')`,
      [ORG, DEFAULT_COMPARTMENT, hiddenId]
    );
    const list = await api('get', '/api/compartments/peerings/list');
    assert.strictEqual(list.status, 200);
    assert.ok(!JSON.stringify(list.body).includes(hiddenId), 'the peering list named a hidden compartment');
    assert.ok(!JSON.stringify(list.body).includes('Vault'));
  });

  it('ignores node ids of another organisation instead of moving them', async () => {
    await dbHelper.pool.query(
      `INSERT INTO users (id, username, email, password_hash, role, organization_id)
       VALUES ('usr-cmp-foreign', 'cmpforeign', 'cmpforeign@example.test', 'x', 'user', $1) ON CONFLICT (id) DO NOTHING`,
      [OTHER_ORG]
    );
    await dbHelper.pool.query(
      `INSERT INTO nodes (id, organization_id, user_id, name, overlay_ipv4, overlay_ipv6, public_key, role, is_healthy, is_quarantined)
       VALUES ('node-iso-foreign', $1, 'usr-cmp-foreign', 'Foreign', '10.250.0.9', 'fd00:9999::9', $2, 'CLIENT_ORIGIN', TRUE, FALSE)
       ON CONFLICT (id) DO NOTHING`,
      [OTHER_ORG, 'ForeignKey'.padEnd(44, 'x')]
    );
    const lab = await createCompartment('Lab');
    const moved = await moveInto(lab, [{ id: 'node-iso-foreign' }, alpha]);
    assert.deepStrictEqual(moved, [alpha.id]);
    const row = await dbHelper.pool.query("SELECT compartment_id FROM nodes WHERE id = 'node-iso-foreign'");
    assert.strictEqual(row.rows[0].compartment_id, null);
  });
});
