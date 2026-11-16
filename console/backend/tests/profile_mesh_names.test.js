// ADR 0034: the gateway's netmap carries a mesh name for every profile device, computed by
// the console with the same slug + organisation search domain a mesh peer gets.
const { issueConsoleTestToken } = require('./helpers/consoleSession');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const request = require('supertest');
const { setupTestDatabase } = require('./helpers/db');
const { nodeKey, register: enrolNode } = require('./helpers/nodeEnrolment');
const { createApp } = require('../server');
const NetmapService = require('../services/NetmapService');

const ORG = 'org-pmn';
const key = () => crypto.randomBytes(32).toString('base64');
const auth = (t) => ({ Authorization: `Bearer ${t}` });

describe('profile device mesh names (ADR 0034)', () => {
  let db;
  let pool;
  let app;
  let admin;
  let gateway;

  before(async () => {
    db = await setupTestDatabase();
    pool = db.pool;
    app = createApp();
    await pool.query(
      `INSERT INTO organizations (id, name, slug, search_domain, default_policy)
       VALUES ($1, 'PMN', 'pmn', 'pmn.example.com', 'deny')`,
      [ORG]
    );
    await pool.query(
      `INSERT INTO users (id, username, email, password_hash, role, organization_id)
       VALUES ('usr-pmn-admin', 'pmnadmin', 'a@pmn.local', 'x', 'admin', $1)`,
      [ORG]
    );
    await pool.query(
      `INSERT INTO memberships (id, user_id, organization_id, role) VALUES ('mem-pmn-admin', 'usr-pmn-admin', $1, 'admin')`,
      [ORG]
    );
    admin = await issueConsoleTestToken({
      sub: 'usr-pmn-admin',
      id: 'usr-pmn-admin',
      username: 'pmnadmin',
      role: 'admin',
      organization_id: ORG
    });
    const res = await enrolNode(app, { public_key_hex: nodeKey(), role: 'CLIENT_ORIGIN', endpoints: [] });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    gateway = res.body.assigned_node_id;
    await pool.query('UPDATE nodes SET organization_id = $1, name = $2 WHERE id = $3', [ORG, 'office', gateway]);
    const gw = await request(app)
      .put('/api/devices/gateway')
      .set(auth(admin))
      .send({ node_id: gateway, endpoint: 'office.example.com:51820' });
    assert.equal(gw.status, 200, JSON.stringify(gw.body));
  });

  after(async () => {
    if (db) await db.cleanup();
  });

  const register = (name) =>
    request(app).post('/api/devices/profile').set(auth(admin)).send({ name, public_key: key(), preshared_key: key() });

  it('lists each profile device under its slugged name and the organisation search domain', async () => {
    const phone = await register('My Phone');
    assert.equal(phone.status, 201, JSON.stringify(phone.body));
    const netmap = await NetmapService.buildNetmap(gateway);
    const entry = netmap.peers.find((p) => p.node_id === phone.body.device_id);
    assert.ok(entry && entry.profile);
    assert.equal(entry.name, 'My Phone');
    assert.equal(entry.dns_name, 'my-phone.pmn.example.com');
  });

  it('an explicit dns_name on the row wins over the computed one', async () => {
    const tablet = await register('tablet');
    await pool.query('UPDATE nodes SET dns_name = $1 WHERE id = $2', ['ipad.pmn.example.com', tablet.body.device_id]);
    const netmap = await NetmapService.buildNetmap(gateway);
    assert.equal(netmap.peers.find((p) => p.node_id === tablet.body.device_id).dns_name, 'ipad.pmn.example.com');
  });
});
