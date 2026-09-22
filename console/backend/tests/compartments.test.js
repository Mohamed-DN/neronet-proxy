const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const config = require('../config/env');
const { setupTestDatabase } = require('./helpers/db');
const { createApp } = require('../server');

describe('Compartments & Ghost Vaults (L2 Logical Segregation & Plausible Deniability)', () => {
  let dbHelper;
  let pool;
  let app;

  let orgId;
  let standardUserToken;
  let standardUserId;
  let rootUserToken;
  let rootUserId;

  before(async () => {
    dbHelper = await setupTestDatabase();
    pool = dbHelper.pool;
    app = createApp();

    // 1. Create Organization
    orgId = 'org-acme-cloud';
    await pool.query(`
      INSERT INTO organizations (id, name, slug, default_policy)
      VALUES ('${orgId}', 'Acme Cloud', 'acme-cloud', 'open')
      ON CONFLICT (id) DO NOTHING;
    `);

    // 2. Standard User (Owner, access_tier = standard)
    standardUserId = 'usr-acme-owner';
    await pool.query(`
      INSERT INTO users (id, username, email, password_hash, role, organization_id)
      VALUES ('${standardUserId}', 'acmeowner', 'owner@acme.local', 'hash', 'user', '${orgId}')
      ON CONFLICT (id) DO NOTHING;
    `);
    await pool.query(`
      INSERT INTO memberships (id, user_id, organization_id, role)
      VALUES ('mem-acme-1', '${standardUserId}', '${orgId}', 'owner')
      ON CONFLICT (user_id, organization_id) DO NOTHING;
    `);
    standardUserToken = jwt.sign(
      {
        sub: standardUserId,
        id: standardUserId,
        username: 'acmeowner',
        role: 'user',
        organization_id: orgId,
        compartment_access: 'standard'
      },
      config.JWT_SECRET
    );

    // 3. Root User (Owner with root access tier, unlocked via pwd_root)
    rootUserId = 'usr-acme-root';
    await pool.query(`
      INSERT INTO users (id, username, email, password_hash, password_hash_root, role, organization_id)
      VALUES ('${rootUserId}', 'acmeroot', 'root@acme.local', 'hash', 'root_hash', 'user', '${orgId}')
      ON CONFLICT (id) DO NOTHING;
    `);
    await pool.query(`
      INSERT INTO memberships (id, user_id, organization_id, role)
      VALUES ('mem-acme-2', '${rootUserId}', '${orgId}', 'owner')
      ON CONFLICT (user_id, organization_id) DO NOTHING;
    `);
    rootUserToken = jwt.sign(
      {
        sub: rootUserId,
        id: rootUserId,
        username: 'acmeroot',
        role: 'user',
        organization_id: orgId,
        compartment_access: 'root'
      },
      config.JWT_SECRET
    );
  });

  after(async () => {
    if (dbHelper) await dbHelper.cleanup();
  });

  let prodCompId;
  let devCompId;
  let ghostComp1Id;
  let ghostComp2Id;

  it('lists the seeded default compartment', async () => {
    const res = await request(app).get('/api/compartments').set('Authorization', `Bearer ${standardUserToken}`);

    assert.strictEqual(res.status, 200);
    assert.ok(Array.isArray(res.body.compartments));
    assert.ok(res.body.compartments.length >= 1);
    assert.strictEqual(res.body.compartments[0].slug, 'default');
  });

  it('creates multiple isolated standard compartments within the organization', async () => {
    // 1. Production compartment
    const prodRes = await request(app)
      .post('/api/compartments')
      .set('Authorization', `Bearer ${standardUserToken}`)
      .send({
        name: 'Production Mesh',
        slug: 'prod-mesh',
        subnet_cidr: '100.64.10.0/24',
        is_hidden: false
      });

    assert.strictEqual(prodRes.status, 201);
    assert.strictEqual(prodRes.body.compartment.name, 'Production Mesh');
    assert.strictEqual(prodRes.body.compartment.subnet_cidr, '100.64.10.0/24');
    assert.strictEqual(prodRes.body.compartment.is_hidden, false);
    prodCompId = prodRes.body.compartment.id;

    // 2. Development compartment
    const devRes = await request(app)
      .post('/api/compartments')
      .set('Authorization', `Bearer ${standardUserToken}`)
      .send({
        name: 'Development Mesh',
        slug: 'dev-mesh',
        subnet_cidr: '100.64.20.0/24',
        is_hidden: false
      });

    assert.strictEqual(devRes.status, 201);
    assert.strictEqual(devRes.body.compartment.name, 'Development Mesh');
    assert.strictEqual(devRes.body.compartment.subnet_cidr, '100.64.20.0/24');
    devCompId = devRes.body.compartment.id;
  });

  it('rejects creating a hidden compartment when caller is in standard access tier', async () => {
    const res = await request(app).post('/api/compartments').set('Authorization', `Bearer ${standardUserToken}`).send({
      name: 'Unauthorized Vault',
      slug: 'unauthorized-vault',
      is_hidden: true
    });

    assert.strictEqual(res.status, 403);
    assert.ok(res.body.error.includes('Forbidden: root access tier required'));
  });

  it('allows creating multiple hidden ghost compartments when in root access tier', async () => {
    // 1. Ghost Vault Alpha
    const ghost1 = await request(app).post('/api/compartments').set('Authorization', `Bearer ${rootUserToken}`).send({
      name: 'Ghost Vault Alpha',
      slug: 'ghost-alpha',
      subnet_cidr: '100.64.91.0/24',
      is_hidden: true
    });

    assert.strictEqual(ghost1.status, 201);
    assert.strictEqual(ghost1.body.compartment.is_hidden, true);
    ghostComp1Id = ghost1.body.compartment.id;

    // 2. Ghost Vault BlackOps
    const ghost2 = await request(app).post('/api/compartments').set('Authorization', `Bearer ${rootUserToken}`).send({
      name: 'Ghost Vault BlackOps',
      slug: 'ghost-blackops',
      subnet_cidr: '100.64.92.0/24',
      is_hidden: true
    });

    assert.strictEqual(ghost2.status, 201);
    assert.strictEqual(ghost2.body.compartment.is_hidden, true);
    ghostComp2Id = ghost2.body.compartment.id;
  });

  it('hides all ghost compartments from standard user listing (zero enumeration)', async () => {
    const res = await request(app).get('/api/compartments').set('Authorization', `Bearer ${standardUserToken}`);

    assert.strictEqual(res.status, 200);
    const names = res.body.compartments.map((c) => c.name);
    assert.ok(names.includes('Production Mesh'));
    assert.ok(names.includes('Development Mesh'));
    // Ghost compartments must NOT exist in the response
    assert.ok(!names.includes('Ghost Vault Alpha'), 'Ghost Vault Alpha must not be visible to standard user');
    assert.ok(!names.includes('Ghost Vault BlackOps'), 'Ghost Vault BlackOps must not be visible to standard user');
  });

  it('returns 404 when standard user directly requests a hidden compartment by ID', async () => {
    const res = await request(app)
      .get(`/api/compartments/${ghostComp1Id}`)
      .set('Authorization', `Bearer ${standardUserToken}`);

    assert.strictEqual(res.status, 404);
    assert.strictEqual(res.body.error, 'Compartment not found');
  });

  it('reveals all compartments including ghost vaults to root user', async () => {
    const res = await request(app).get('/api/compartments').set('Authorization', `Bearer ${rootUserToken}`);

    assert.strictEqual(res.status, 200);
    const names = res.body.compartments.map((c) => c.name);
    assert.ok(names.includes('Production Mesh'));
    assert.ok(names.includes('Development Mesh'));
    assert.ok(names.includes('Ghost Vault Alpha'));
    assert.ok(names.includes('Ghost Vault BlackOps'));
  });

  it('creates a mesh peering rule between Production and Development compartments', async () => {
    const res = await request(app)
      .post('/api/compartments/peerings/create')
      .set('Authorization', `Bearer ${standardUserToken}`)
      .send({
        src_compartment_id: devCompId,
        dst_compartment_id: prodCompId,
        policy: 'allow'
      });

    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.peering.src_compartment_id, devCompId);
    assert.strictEqual(res.body.peering.dst_compartment_id, prodCompId);
  });

  it('lists active compartment peerings', async () => {
    const res = await request(app)
      .get('/api/compartments/peerings/list')
      .set('Authorization', `Bearer ${standardUserToken}`);

    assert.strictEqual(res.status, 200);
    assert.ok(Array.isArray(res.body.peerings));
    assert.ok(res.body.peerings.length >= 1);
    const peer = res.body.peerings.find((p) => p.src_compartment_id === devCompId);
    assert.ok(peer);
    assert.strictEqual(peer.src_name, 'Development Mesh');
    assert.strictEqual(peer.dst_name, 'Production Mesh');
  });

  it('renders ghost compartment nodes in topology and stats ONLY when authenticated with root token', async () => {
    // 1. Add a standard node in Production Mesh
    await pool.query(`
      INSERT INTO nodes (id, user_id, organization_id, compartment_id, name, public_key, overlay_ipv4, overlay_ipv6)
      VALUES ('node-prod-1', '${standardUserId}', '${orgId}', '${prodCompId}', 'Prod Gateway', 'pk-prod-1111', '100.64.10.1', 'fd7a:115c:a1e0::10:1')
      ON CONFLICT (id) DO NOTHING;
    `);

    // 2. Add a secret node inside ghost compartment 1
    await pool.query(`
      INSERT INTO nodes (id, user_id, organization_id, compartment_id, name, public_key, overlay_ipv4, overlay_ipv6)
      VALUES ('node-ghost-agent', '${rootUserId}', '${orgId}', '${ghostComp1Id}', 'Ghost Server', 'pk-ghost-1111', '100.64.91.5', 'fd7a:115c:a1e0::91:5')
      ON CONFLICT (id) DO NOTHING;
    `);

    // A. Standard user checks topology: Ghost Server MUST NOT appear!
    const stdTopo = await request(app).get('/api/stats/topology').set('Authorization', `Bearer ${standardUserToken}`);

    assert.strictEqual(stdTopo.status, 200);
    const stdNodeIds = stdTopo.body.nodes.map((n) => n.id);
    assert.ok(stdNodeIds.includes('node-prod-1'), 'Prod node should be in standard topology');
    assert.ok(!stdNodeIds.includes('node-ghost-agent'), 'Ghost node must NOT be in standard topology');

    // B. Root user checks topology: Ghost Server MUST appear in topology!
    const rootTopo = await request(app).get('/api/stats/topology').set('Authorization', `Bearer ${rootUserToken}`);

    assert.strictEqual(rootTopo.status, 200);
    const rootNodeIds = rootTopo.body.nodes.map((n) => n.id);
    assert.ok(rootNodeIds.includes('node-prod-1'), 'Prod node should be in root topology');
    assert.ok(rootNodeIds.includes('node-ghost-agent'), 'Ghost node MUST be in root topology graph');

    // C. Standard user checks GET /api/nodes/:id on ghost node: must return 404 (zero existence oracle)
    const stdGetGhost = await request(app)
      .get('/api/nodes/node-ghost-agent')
      .set('Authorization', `Bearer ${standardUserToken}`);
    assert.strictEqual(stdGetGhost.status, 404);

    // D. Root user checks GET /api/nodes/:id on ghost node: must return 200
    const rootGetGhost = await request(app)
      .get('/api/nodes/node-ghost-agent')
      .set('Authorization', `Bearer ${rootUserToken}`);
    assert.strictEqual(rootGetGhost.status, 200);
    assert.strictEqual(rootGetGhost.body.node.id, 'node-ghost-agent');
    assert.strictEqual(rootGetGhost.body.node.compartment_id, ghostComp1Id);

    // E. Overview node count check: standard user does NOT count ghost node
    const stdOverview = await request(app)
      .get('/api/stats/overview')
      .set('Authorization', `Bearer ${standardUserToken}`);
    assert.strictEqual(stdOverview.status, 200);

    const rootOverview = await request(app).get('/api/stats/overview').set('Authorization', `Bearer ${rootUserToken}`);
    assert.strictEqual(rootOverview.status, 200);

    // Root overview total_nodes must be strictly greater by at least 1 (the ghost node)
    assert.strictEqual(rootOverview.body.total_nodes, stdOverview.body.total_nodes + 1);
  });

  it('demonstrates duress stealth wipe: completely destroys all ghost compartments', async () => {
    // 1. Add a secret node inside ghost compartment 1
    await pool.query(`
      INSERT INTO nodes (id, user_id, organization_id, compartment_id, name, public_key, overlay_ipv4, overlay_ipv6)
      VALUES ('node-ghost-agent', '${rootUserId}', '${orgId}', '${ghostComp1Id}', 'Ghost Server', 'pk-ghost-1111', '100.64.91.5', 'fd7a:115c:a1e0::91:5')
      ON CONFLICT (id) DO NOTHING;
    `);

    // 2. Execute stealth wipe duress protocol
    await pool.query('DELETE FROM nodes WHERE compartment_id IN (SELECT id FROM compartments WHERE is_hidden = TRUE)');
    await pool.query('DELETE FROM compartments WHERE is_hidden = TRUE');

    // 3. Verify ghost compartments and nodes are gone even from root view!
    const res = await request(app).get('/api/compartments').set('Authorization', `Bearer ${rootUserToken}`);

    assert.strictEqual(res.status, 200);
    const names = res.body.compartments.map((c) => c.name);
    assert.ok(!names.includes('Ghost Vault Alpha'), 'Ghost Vault Alpha must be wiped');
    assert.ok(!names.includes('Ghost Vault BlackOps'), 'Ghost Vault BlackOps must be wiped');

    const nodeCheck = await pool.query("SELECT * FROM nodes WHERE id = 'node-ghost-agent'");
    assert.strictEqual(nodeCheck.rows.length, 0, 'Ghost node must be completely deleted');
  });
});
