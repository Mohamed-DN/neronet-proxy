// The network map draws profile devices (ADR 0029), the profile gateway and switched-off
// devices, so GET /api/stats/topology must say which node is which and when it was last seen.
const { issueConsoleTestToken } = require('./helpers/consoleSession');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const request = require('supertest');
const { setupTestDatabase } = require('./helpers/db');
const { createApp } = require('../server');

const key = () => crypto.randomBytes(32).toString('base64');

describe('topology payload: device kind, profile gateway and last seen', () => {
  let dbHelper;
  let pool;
  let app;
  let adminA;
  let memberA;
  let adminB;
  const auth = (t) => ({ Authorization: `Bearer ${t}` });
  const PSK = key();

  before(async () => {
    dbHelper = await setupTestDatabase();
    pool = dbHelper.pool;
    app = createApp();
    for (const [o, slug] of [
      ['org-topo-a', 'topo-a'],
      ['org-topo-b', 'topo-b']
    ]) {
      await pool.query(
        `INSERT INTO organizations (id, name, slug, default_policy) VALUES ($1, $2, $2, 'deny') ON CONFLICT (id) DO NOTHING`,
        [o, slug]
      );
    }
    await pool.query(
      `INSERT INTO users (id, username, email, password_hash, role, organization_id) VALUES
         ('usr-topo-a', 'topoa', 'a@topo.local', 'x', 'admin', 'org-topo-a'),
         ('usr-topo-m', 'topom', 'm@topo.local', 'x', 'user', 'org-topo-a'),
         ('usr-topo-b', 'topob', 'b@topo.local', 'x', 'admin', 'org-topo-b')
       ON CONFLICT (id) DO NOTHING`
    );
    await pool.query(
      `INSERT INTO memberships (id, user_id, organization_id, role) VALUES
         ('mem-topo-a', 'usr-topo-a', 'org-topo-a', 'admin'),
         ('mem-topo-m', 'usr-topo-m', 'org-topo-a', 'member'),
         ('mem-topo-b', 'usr-topo-b', 'org-topo-b', 'admin')
       ON CONFLICT (id) DO NOTHING`
    );
    let seq = 0;
    const ins = (id, org, user, n, ip, kind, endpoint, seen) =>
      pool.query(
        `INSERT INTO nodes (id, organization_id, user_id, name, overlay_ipv4, overlay_ipv6, public_key, preshared_key,
                            role, is_healthy, is_quarantined, device_kind, profile_gateway_endpoint, last_heartbeat)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'CLIENT_ORIGIN',TRUE,FALSE,$9,$10,$11)`,
        [id, org, user, n, ip, `fd00:41::${++seq}`, key(), kind === 'profile' ? PSK : null, kind, endpoint, seen]
      );
    await ins(
      'topo-gw-a',
      'org-topo-a',
      'usr-topo-a',
      'gw-a',
      '100.64.41.1',
      'mesh',
      '203.0.113.9:51820',
      new Date('2026-11-10T10:00:00Z')
    );
    await ins('topo-mesh-a', 'org-topo-a', 'usr-topo-a', 'mesh-a', '100.64.41.2', 'mesh', null, null);
    await ins(
      'topo-phone-a',
      'org-topo-a',
      'usr-topo-a',
      'phone-a',
      '100.64.41.3',
      'profile',
      null,
      new Date('2026-11-11T08:00:00Z')
    );
    await ins('topo-phone-m', 'org-topo-a', 'usr-topo-m', 'phone-m', '100.64.41.4', 'profile', null, null);
    await ins(
      'topo-phone-b',
      'org-topo-b',
      'usr-topo-b',
      'phone-b',
      '100.64.42.3',
      'profile',
      null,
      new Date('2026-11-11T09:00:00Z')
    );
    const tok = (id, username, role) =>
      issueConsoleTestToken({
        sub: id,
        id,
        username,
        role,
        organization_id: id.endsWith('b') ? 'org-topo-b' : 'org-topo-a'
      });
    adminA = await tok('usr-topo-a', 'topoa', 'admin');
    memberA = await tok('usr-topo-m', 'topom', 'user');
    adminB = await tok('usr-topo-b', 'topob', 'admin');
  });

  after(async () => {
    if (dbHelper) await dbHelper.cleanup();
  });

  it('reports device_kind, is_profile_gateway and last_seen_at, and never a key or endpoint', async () => {
    const res = await request(app).get('/api/stats/topology').set(auth(adminA));
    assert.strictEqual(res.status, 200);
    const by = Object.fromEntries(res.body.nodes.map((n) => [n.id, n]));
    assert.strictEqual(by['topo-phone-a'].device_kind, 'profile');
    assert.strictEqual(by['topo-mesh-a'].device_kind, 'mesh');
    assert.strictEqual(by['topo-gw-a'].is_profile_gateway, true);
    assert.strictEqual(by['topo-mesh-a'].is_profile_gateway, false);
    assert.strictEqual(by['topo-phone-a'].is_profile_gateway, false);
    assert.strictEqual(by['topo-gw-a'].last_seen_at, '2026-11-10T10:00:00.000Z');
    assert.strictEqual(by['topo-phone-a'].last_seen_at, '2026-11-11T08:00:00.000Z');
    assert.strictEqual(by['topo-mesh-a'].last_seen_at, null);
    const raw = JSON.stringify(res.body);
    assert.ok(!raw.includes(PSK) && !/preshared|public_key|203\.0\.113\.9/.test(raw));
    // Nothing measures these per pair, so they stay absent and the UI shows a dash.
    for (const l of res.body.links) {
      assert.ok(!('transport' in l) && !('last_handshake_at' in l));
    }
  });

  it('keeps tenant isolation: another org profile devices never appear', async () => {
    const a = await request(app).get('/api/stats/topology').set(auth(adminA));
    assert.ok(!a.body.nodes.some((n) => n.id === 'topo-phone-b'));
    const b = await request(app).get('/api/stats/topology').set(auth(adminB));
    assert.deepStrictEqual(
      b.body.nodes.map((n) => n.id),
      ['topo-phone-b']
    );
    assert.strictEqual(b.body.nodes[0].device_kind, 'profile');
  });

  it('a plain member sees only their own profile device', async () => {
    const res = await request(app).get('/api/stats/topology').set(auth(memberA));
    assert.deepStrictEqual(
      res.body.nodes.map((n) => n.id),
      ['topo-phone-m']
    );
    assert.strictEqual(res.body.nodes[0].device_kind, 'profile');
  });
});
