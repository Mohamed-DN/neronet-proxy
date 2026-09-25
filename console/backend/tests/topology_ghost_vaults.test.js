const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const config = require('../config/env');
const { setupTestDatabase } = require('./helpers/db');
const { createApp } = require('../server');

describe('WP-406: Topology & Ghost Vaults Dynamic Unlock / Plausible Deniability', () => {
  let dbHelper;
  let pool;
  let app;

  let orgId = 'org-sovereign-vault';
  let userId = 'usr-vault-operator';
  let standardToken;
  let rootHash;
  let stealthWipeHash;

  let standardCompId = 'cmp-standard-l2';
  let ghostCompId = 'cmp-ghost-secret';

  let standardNodeId = 'node-std-01';
  let ghostNodeId = 'node-ghost-01';

  before(async () => {
    dbHelper = await setupTestDatabase();
    pool = dbHelper.pool;
    app = createApp();

    const pwdStd = await bcrypt.hash('StandardPass123!', 8);
    rootHash = await bcrypt.hash('RootVaultSecret456!', 8);
    stealthWipeHash = await bcrypt.hash('DuressWipeEmergency789!', 8);

    // 1. Create Organization
    await pool.query(`
      INSERT INTO organizations (id, name, slug, default_policy)
      VALUES ('${orgId}', 'Sovereign Vault Org', 'sovereign-vault-org', 'open')
      ON CONFLICT (id) DO NOTHING;
    `);

    // 2. Create User with Standard, Root, and Stealth Wipe passwords
    await pool.query(`
      INSERT INTO users (id, username, email, password_hash, password_hash_root, password_hash_stealth_wipe, role, organization_id)
      VALUES ('${userId}', 'vaultadmin', 'vaultadmin@sovereign.local', '${pwdStd}', '${rootHash}', '${stealthWipeHash}', 'user', '${orgId}')
      ON CONFLICT (id) DO NOTHING;
    `);

    await pool.query(`
      INSERT INTO memberships (id, user_id, organization_id, role)
      VALUES ('mem-vault-1', '${userId}', '${orgId}', 'owner')
      ON CONFLICT (user_id, organization_id) DO NOTHING;
    `);

    standardToken = jwt.sign(
      {
        sub: userId,
        id: userId,
        username: 'vaultadmin',
        role: 'user',
        organization_id: orgId,
        compartment_access: 'standard'
      },
      config.JWT_SECRET
    );

    // 3. Create Standard Compartment and Ghost Compartment
    await pool.query(`
      INSERT INTO compartments (id, organization_id, name, slug, subnet_cidr, is_hidden, created_at, updated_at)
      VALUES
        ('${standardCompId}', '${orgId}', 'Corporate Ops', 'corporate-ops', '100.64.1.0/24', FALSE, NOW(), NOW()),
        ('${ghostCompId}', '${orgId}', 'Black Ops Vault', 'black-ops-vault', '100.64.99.0/24', TRUE, NOW(), NOW())
      ON CONFLICT (id) DO NOTHING;
    `);

    // 4. Create Standard Node and Ghost Vault Node
    await pool.query(`
      INSERT INTO nodes (id, organization_id, user_id, compartment_id, name, overlay_ipv4, overlay_ipv6, public_key, role, is_healthy, is_quarantined, latency_ms)
      VALUES
        ('${standardNodeId}', '${orgId}', '${userId}', '${standardCompId}', 'Rome Edge Standard', '10.200.1.1', 'fd00:beef::1', 'StdPubKey1111111111111111111111111111111111=', 'RELAY', TRUE, FALSE, 12.5),
        ('${ghostNodeId}', '${orgId}', '${userId}', '${ghostCompId}', 'Ghost Stealth Ingress', '10.200.99.1', 'fd00:beef::99', 'GhostPubKey2222222222222222222222222222222222=', 'HYBRID', TRUE, FALSE, 8.2)
      ON CONFLICT (id) DO NOTHING;
    `);
  });

  after(async () => {
    if (dbHelper) await dbHelper.cleanup();
  });

  let elevatedToken;

  it('1. Standard tier: GET /api/stats/topology strictly omits ghost vault nodes (plausible deniability)', async () => {
    const res = await request(app).get('/api/stats/topology').set('Authorization', `Bearer ${standardToken}`);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.total_nodes, 1);
    assert.strictEqual(res.body.nodes.length, 1);
    assert.strictEqual(res.body.nodes[0].id, standardNodeId);
    assert.strictEqual(res.body.nodes[0].is_ghost_vault, false);
    assert.strictEqual(res.body.nodes[0].compartment_id, standardCompId);
  });

  it('2. POST /api/compartments/unlock fails with wrong password', async () => {
    const res = await request(app)
      .post('/api/compartments/unlock')
      .set('Authorization', `Bearer ${standardToken}`)
      .send({ password: 'WrongPassword999!' });

    assert.strictEqual(res.status, 401);
    assert.strictEqual(res.body.error, 'Invalid vault password');
  });

  it('3. POST /api/compartments/unlock with valid root password elevates session to root tier', async () => {
    const res = await request(app)
      .post('/api/compartments/unlock')
      .set('Authorization', `Bearer ${standardToken}`)
      .send({ password: 'RootVaultSecret456!' });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.compartment_access, 'root');
    assert.ok(res.body.token);
    elevatedToken = res.body.token;

    // Verify token payload
    const decoded = jwt.verify(elevatedToken, config.JWT_SECRET);
    assert.strictEqual(decoded.compartment_access, 'root');
  });

  it('4. Elevated tier: GET /api/stats/topology returns both standard and ghost vault nodes', async () => {
    const res = await request(app).get('/api/stats/topology').set('Authorization', `Bearer ${elevatedToken}`);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.total_nodes, 2);
    assert.strictEqual(res.body.nodes.length, 2);

    const ghostNode = res.body.nodes.find((n) => n.id === ghostNodeId);
    assert.ok(ghostNode, 'Ghost vault node must be present in elevated tier');
    assert.strictEqual(ghostNode.is_ghost_vault, true);
    assert.strictEqual(ghostNode.compartment_name, 'Black Ops Vault');

    const stdNode = res.body.nodes.find((n) => n.id === standardNodeId);
    assert.ok(stdNode, 'Standard node must be present');
    assert.strictEqual(stdNode.is_ghost_vault, false);
  });

  it('5. POST /api/compartments/lock reverts session back to standard tier', async () => {
    const res = await request(app).post('/api/compartments/lock').set('Authorization', `Bearer ${elevatedToken}`);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.compartment_access, 'standard');
    assert.ok(res.body.token);

    const lockedToken = res.body.token;
    const decoded = jwt.verify(lockedToken, config.JWT_SECRET);
    assert.strictEqual(decoded.compartment_access, 'standard');

    // Verify topology with locked token omits ghost vault
    const topoRes = await request(app).get('/api/stats/topology').set('Authorization', `Bearer ${lockedToken}`);

    assert.strictEqual(topoRes.status, 200);
    assert.strictEqual(topoRes.body.total_nodes, 1);
    assert.strictEqual(topoRes.body.nodes[0].id, standardNodeId);
  });

  it('6. Duress protocol: POST /api/compartments/unlock with duress password executes stealth wipe and returns 401', async () => {
    const res = await request(app)
      .post('/api/compartments/unlock')
      .set('Authorization', `Bearer ${standardToken}`)
      .send({ password: 'DuressWipeEmergency789!' });

    assert.strictEqual(res.status, 401);
    assert.strictEqual(res.body.error, 'Invalid vault password');

    // Check DB: Black Ops Vault compartment and ghost node must be completely deleted
    const compCheck = await pool.query(`SELECT * FROM compartments WHERE id = '${ghostCompId}'`);
    assert.strictEqual(compCheck.rows.length, 0, 'Ghost compartment must be wiped from database');

    const nodeCheck = await pool.query(`SELECT * FROM nodes WHERE id = '${ghostNodeId}'`);
    assert.strictEqual(nodeCheck.rows.length, 0, 'Ghost node must be wiped from database');

    // Standard compartment and node remain intact
    const stdCompCheck = await pool.query(`SELECT * FROM compartments WHERE id = '${standardCompId}'`);
    assert.strictEqual(stdCompCheck.rows.length, 1, 'Standard compartment must remain intact');
  });
});
