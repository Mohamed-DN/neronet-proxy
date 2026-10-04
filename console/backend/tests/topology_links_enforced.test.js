const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const config = require('../config/env');
const { setupTestDatabase } = require('./helpers/db');
const { createApp } = require('../server');
const AclEngine = require('../services/AclEngine');

/**
 * The topology the console draws has to be the one the nodes enforce. These tests write
 * rules through the engine the API uses, ask GET /api/stats/topology over HTTP, and
 * check each pair against what the compiled policy lets through.
 *
 * The case that went wrong: an open organisation with only DROP rules. The engine
 * compiles the open default after the DROPs, so a cut pair carries a DROP entry and
 * then an ACCEPT entry. Reading "is there an ACCEPT" drew that pair as connected while
 * every node refused it.
 */

const ORG = 'org-topo-links';
const USER = 'usr-topo-links';

const A = { id: 'node-topo-a', vip: '10.210.0.1' };
const B = { id: 'node-topo-b', vip: '10.210.0.2' };
const C = { id: 'node-topo-c', vip: '10.210.0.3' };

function pairKey(link) {
  return [link.source, link.target].sort().join('|');
}

function linksByPair(body) {
  const map = new Map();
  for (const link of body.links) map.set(pairKey(link), link);
  return map;
}

const AB = [A.id, B.id].sort().join('|');
const AC = [A.id, C.id].sort().join('|');
const BC = [B.id, C.id].sort().join('|');

describe('Topology links follow the enforced policy', () => {
  let dbHelper;
  let app;
  let token;

  before(async () => {
    dbHelper = await setupTestDatabase();
    const { pool } = dbHelper;
    app = createApp();

    await pool.query(
      `INSERT INTO organizations (id, name, slug, default_policy) VALUES ($1, 'Topology links', 'topology-links', 'open')
       ON CONFLICT (id) DO NOTHING`,
      [ORG]
    );
    await pool.query(
      `INSERT INTO users (id, username, email, password_hash, role, organization_id)
       VALUES ($1, 'topolinks', 'topolinks@example.test', 'x', 'user', $2) ON CONFLICT (id) DO NOTHING`,
      [USER, ORG]
    );
    await pool.query(
      `INSERT INTO memberships (id, user_id, organization_id, role) VALUES ('mem-topo-links', $1, $2, 'owner')
       ON CONFLICT (user_id, organization_id) DO NOTHING`,
      [USER, ORG]
    );
    for (const [i, n] of [A, B, C].entries()) {
      await pool.query(
        `INSERT INTO nodes (id, organization_id, user_id, name, overlay_ipv4, overlay_ipv6, public_key, role, is_healthy, is_quarantined)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'CLIENT_ORIGIN', TRUE, FALSE)`,
        [n.id, ORG, USER, `Topo ${i}`, n.vip, `fd00:7070::${i + 1}`, `TopoKey${i}`.padEnd(44, 'x')]
      );
    }

    token = jwt.sign(
      { sub: USER, id: USER, username: 'topolinks', role: 'user', organization_id: ORG },
      config.JWT_SECRET
    );
  });

  after(async () => {
    if (dbHelper) await dbHelper.cleanup();
  });

  beforeEach(async () => {
    for (const rule of await AclEngine.listRules()) {
      await AclEngine.deleteRule(rule.id);
    }
  });

  async function topology() {
    const res = await request(app).get('/api/stats/topology').set('Authorization', `Bearer ${token}`);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    return res.body;
  }

  it('draws the full mesh live while no rule exists', async () => {
    const body = await topology();
    const links = linksByPair(body);
    assert.strictEqual(body.policy_is_open, true);
    assert.deepStrictEqual([...links.keys()].sort(), [AB, AC, BC].sort());
    for (const link of links.values()) assert.strictEqual(link.is_visible, true);
  });

  it('draws a cut pair as cut and keeps the open mesh around it', async () => {
    // What the canvas writes for "cut connection".
    await AclEngine.createRule(
      { priority: 50, source_cidr: `${A.vip}/32`, destination_cidr: `${B.vip}/32`, action: 'DROP' },
      { organizationId: ORG }
    );
    await AclEngine.createRule(
      { priority: 50, source_cidr: `${B.vip}/32`, destination_cidr: `${A.vip}/32`, action: 'DROP' },
      { organizationId: ORG }
    );

    const body = await topology();
    const links = linksByPair(body);
    assert.strictEqual(body.policy_is_open, true, 'DROP rules alone leave the open default in force');
    assert.strictEqual(links.get(AB)?.is_visible, false, 'the cut pair must not be drawn as connected');
    assert.strictEqual(links.get(AC)?.is_visible, true);
    assert.strictEqual(links.get(BC)?.is_visible, true);
  });

  it('leaves out pairs an allow-list never granted rather than drawing them as cut', async () => {
    await AclEngine.createRule(
      { priority: 100, source_cidr: `${A.vip}/32`, destination_cidr: `${C.vip}/32`, action: 'ACCEPT' },
      { organizationId: ORG }
    );

    const body = await topology();
    const links = linksByPair(body);
    assert.strictEqual(body.policy_is_open, false);
    assert.deepStrictEqual([...links.keys()], [AC]);
    assert.strictEqual(links.get(AC).is_visible, true);
  });
});
