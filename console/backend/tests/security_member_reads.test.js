// M3: a plain member does not read the member list or the access policy of the
// organisation. The console shows those pages to owner/admin/network_admin/auditor only.
// A member still reads the compiled policy of a node of their own.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const request = require('supertest');
const { setupTestDatabase } = require('./helpers/db');
const { createOrgFixture } = require('./helpers/orgFixture');
const { createApp } = require('../server');

describe('M3: organisation reads by role', () => {
  let dbHelper;
  let pool;
  let app;
  let fx;
  const auth = (name) => ({ Authorization: `Bearer ${fx.tokens[name]}` });
  const READERS = ['ownerA', 'adminA', 'netAdminA', 'auditorA', 'superAdmin'];

  const reads = () => [
    ['GET', '/api/acl/rules'],
    ['GET', '/api/acl/default-policy'],
    ['GET', '/api/acl/tests'],
    ['POST', '/api/acl/tests/run'],
    ['POST', '/api/acl/simulate', { source_ip: '100.64.1.1', destination_ip: '100.64.1.2' }],
    ['GET', `/api/organizations/${fx.orgs.A}/members`]
  ];
  const call = (who, [method, path, body]) => {
    const r = request(app)[method.toLowerCase()](path).set(auth(who));
    return body ? r.send(body) : method === 'POST' ? r.send({}) : r;
  };

  before(async () => {
    dbHelper = await setupTestDatabase();
    pool = dbHelper.pool;
    app = createApp();
    fx = await createOrgFixture(pool);
    for (const [id, owner, n] of [
      ['node-sec-own', fx.ids.memberA, 1],
      ['node-sec-other', fx.ids.member2A, 2]
    ]) {
      await pool.query(
        `INSERT INTO nodes (id, organization_id, user_id, name, overlay_ipv4, overlay_ipv6, public_key, role,
                            is_healthy, is_quarantined)
         VALUES ($1, $2, $3, $1, $4, $5, $6, 'CLIENT_ORIGIN', TRUE, FALSE)`,
        [id, fx.orgs.A, owner, `100.64.55.${n}`, `fd00:55::${n}`, crypto.randomBytes(32).toString('hex')]
      );
    }
  });

  after(async () => {
    if (dbHelper) await dbHelper.cleanup();
  });

  it('refuses a plain member the member list and every ACL read', async () => {
    for (const r of reads()) {
      const res = await call('memberA', r);
      assert.strictEqual(res.status, 403, `${r[0]} ${r[1]} answered ${res.status}`);
      assert.ok(!JSON.stringify(res.body).includes('@sec.local'), 'member emails leaked');
    }
  });

  it('keeps the reads for owner, admin, network_admin, auditor and super-admin', async () => {
    for (const who of READERS) {
      for (const r of reads()) {
        const res = await call(who, r);
        assert.strictEqual(res.status, 200, `${who} ${r[0]} ${r[1]} answered ${res.status}`);
      }
    }
  });

  it("lets a member read the compiled policy of their own node and not of a colleague's", async () => {
    assert.strictEqual((await request(app).get('/api/acl/compiled/node-sec-own').set(auth('memberA'))).status, 200);
    assert.strictEqual((await request(app).get('/api/acl/compiled/node-sec-other').set(auth('memberA'))).status, 404);
  });
});
