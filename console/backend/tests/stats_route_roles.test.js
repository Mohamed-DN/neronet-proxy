const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const config = require('../config/env');
const { setupTestDatabase } = require('./helpers/db');
const { createApp } = require('../server');

// The audit ledger is platform wide, and these routes checked nothing beyond a
// valid session: any user could export every tenant's audit trail, add a SIEM sink
// that would receive every future event, clear every isolation rule on the platform,
// or cut traffic between two nodes of another organisation.

describe('Audit and topology routes check the caller', () => {
  let dbHelper;
  let pool;
  let app;
  let superAdmin;
  let memberA;
  let netAdminA;

  function token(id, role, orgId) {
    return jwt.sign({ sub: id, id, username: id, role, organization_id: orgId }, config.JWT_SECRET);
  }

  async function addUser(id, orgId, orgRole, platformRole = 'user') {
    await pool.query(
      `INSERT INTO users (id, username, email, password_hash, role, organization_id)
       VALUES ($1, $1, $2, 'hash', $3, $4)`,
      [id, `${id}@roles.test`, platformRole, orgId]
    );
    if (orgRole) {
      await pool.query(`INSERT INTO memberships (id, user_id, organization_id, role) VALUES ($1, $2, $3, $4)`, [
        `mem-${id}`,
        id,
        orgId,
        orgRole
      ]);
    }
    return token(id, platformRole, orgId);
  }

  async function addNode(id, userId, orgId, ip) {
    await pool.query(
      `INSERT INTO nodes (id, user_id, organization_id, name, public_key, overlay_ipv4, overlay_ipv6)
       VALUES ($1, $2, $3, $1, $4, $5, $6)`,
      [id, userId, orgId, `pk-${id}`, `100.64.88.${ip}`, `fd7a:115c:a1e0::88:${ip}`]
    );
  }

  async function count(sql, params = []) {
    return Number((await pool.query(sql, params)).rows[0].n);
  }

  before(async () => {
    dbHelper = await setupTestDatabase();
    pool = dbHelper.pool;
    app = createApp();

    for (const org of ['org-roles-a', 'org-roles-b']) {
      await pool.query(`INSERT INTO organizations (id, name, slug) VALUES ($1, $1, $1)`, [org]);
    }
    superAdmin = await addUser('usr-roles-super', 'org-default', null, 'super-admin');
    memberA = await addUser('usr-roles-member-a', 'org-roles-a', 'member');
    netAdminA = await addUser('usr-roles-netadmin-a', 'org-roles-a', 'network_admin');
    await addUser('usr-roles-owner-b', 'org-roles-b', 'owner');

    await addNode('node-roles-a1', 'usr-roles-netadmin-a', 'org-roles-a', 11);
    await addNode('node-roles-a2', 'usr-roles-netadmin-a', 'org-roles-a', 12);
    await addNode('node-roles-b1', 'usr-roles-owner-b', 'org-roles-b', 21);
    await addNode('node-roles-b2', 'usr-roles-owner-b', 'org-roles-b', 22);
  });

  after(async () => {
    if (dbHelper) await dbHelper.cleanup();
  });

  it('refuses the audit ledger export to anyone but the platform super-admin', async () => {
    const member = await request(app).get('/api/audit/export').set('Authorization', `Bearer ${memberA}`);
    assert.strictEqual(member.status, 403);
    assert.strictEqual(member.body.events, undefined);

    const admin = await request(app).get('/api/audit/export').set('Authorization', `Bearer ${superAdmin}`);
    assert.strictEqual(admin.status, 200);
  });

  it('refuses to let an ordinary user add or read SIEM sinks', async () => {
    const add = await request(app)
      .post('/api/audit/siem')
      .set('Authorization', `Bearer ${netAdminA}`)
      .send({ name: 'exfil', protocol: 'udp', endpoint: '203.0.113.9:514' });
    assert.strictEqual(add.status, 403);
    assert.strictEqual(await count('SELECT count(*) AS n FROM audit_siem_destinations'), 0);

    const list = await request(app).get('/api/audit/siem').set('Authorization', `Bearer ${memberA}`);
    assert.strictEqual(list.status, 403);
  });

  it('refuses a platform-wide reconnect to anyone but the platform super-admin', async () => {
    await pool.query(
      `INSERT INTO acl_rules (id, priority, source_cidr, destination_cidr, protocol, port_start, port_end, action, description, enabled, organization_id)
       VALUES ('acl-roles-iso', 5, '100.64.88.21/32', '100.64.88.22/32', 'ALL', 0, 65535, 'DROP', 'Node explicit isolation', TRUE, 'org-roles-b')`
    );

    const res = await request(app)
      .post('/api/stats/topology/reconnect-all')
      .set('Authorization', `Bearer ${netAdminA}`);
    assert.strictEqual(res.status, 403);
    assert.strictEqual(await count("SELECT count(*) AS n FROM acl_rules WHERE id = 'acl-roles-iso'"), 1);
  });

  it("refuses to cut a link between another organisation's nodes", async () => {
    const before = await count("SELECT count(*) AS n FROM acl_rules WHERE description = 'Node explicit isolation'");

    const res = await request(app)
      .post('/api/stats/topology/link')
      .set('Authorization', `Bearer ${netAdminA}`)
      .send({ source_node_id: 'node-roles-b1', target_node_id: 'node-roles-b2', is_visible: false });

    assert.strictEqual(res.status, 404);
    assert.strictEqual(
      await count("SELECT count(*) AS n FROM acl_rules WHERE description = 'Node explicit isolation'"),
      before
    );
  });

  it('refuses a plain member, and lets a network admin isolate their own nodes', async () => {
    const member = await request(app)
      .post('/api/stats/topology/link')
      .set('Authorization', `Bearer ${memberA}`)
      .send({ source_node_id: 'node-roles-a1', target_node_id: 'node-roles-a2', is_visible: false });
    assert.strictEqual(member.status, 403);

    const netAdmin = await request(app)
      .post('/api/stats/topology/link')
      .set('Authorization', `Bearer ${netAdminA}`)
      .send({ source_node_id: 'node-roles-a1', target_node_id: 'node-roles-a2', is_visible: false });
    assert.strictEqual(netAdmin.status, 200);
    assert.strictEqual(
      await count(
        `SELECT count(*) AS n FROM acl_rules
          WHERE description = 'Node explicit isolation' AND organization_id = 'org-roles-a'
            AND source_cidr IN ('100.64.88.11/32', '100.64.88.12/32')`
      ),
      2
    );
  });

  it("lists only the caller's own organisation's links", async () => {
    await pool.query(
      `INSERT INTO mesh_link_configs (id, source_node_id, target_node_id, mode, is_visible)
       VALUES ('lnk-roles-b', 'node-roles-b1', 'node-roles-b2', 'direct', TRUE)`
    );

    const res = await request(app).get('/api/stats/topology/links').set('Authorization', `Bearer ${memberA}`);
    assert.strictEqual(res.status, 200);
    assert.ok(!res.body.links.some((l) => l.id === 'lnk-roles-b'), 'another organisation’s link must not be listed');
  });
});
