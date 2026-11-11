// ADR 0028 pair 1: policy tests checked on every ACL save, and before/after audit.
//
// A stored assertion ("100.64.20.1 reaches 100.64.20.2 on TCP 22") is a promise the
// administrator made about the network. A save that would break it must be refused
// before any node sees the new rules, and nothing about the refused save may linger:
// not the rule, not the epoch, not an audit row claiming the change happened.
const { issueConsoleTestToken } = require('./helpers/consoleSession');
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { setupTestDatabase } = require('./helpers/db');
const { settleAuditWrites } = require('../utils/audit');
const { createApp } = require('../server');
const AclEngine = require('../services/AclEngine');

describe('ADR 0028 pair 1: policy guard on ACL saves', () => {
  let dbHelper;
  let pool;
  let app;
  let rootToken;
  let adminToken;
  let otherAdminToken;

  const orgA = 'org-guard-a';
  const orgB = 'org-guard-b';
  const SSH = { source_ip: '100.64.20.1', destination_ip: '100.64.20.2', protocol: 'TCP', port: 22 };

  const auth = (t) => ({ Authorization: `Bearer ${t}` });
  const aclEpoch = async () =>
    Number((await pool.query("SELECT epoch FROM mesh_epochs WHERE name='acl'")).rows[0].epoch);
  const ruleCount = async () => Number((await pool.query('SELECT COUNT(*) AS n FROM acl_rules')).rows[0].n);
  const auditCount = async () => {
    await settleAuditWrites();
    return Number((await pool.query('SELECT COUNT(*) AS n FROM audit_events')).rows[0].n);
  };
  const snapshot = async () => ({ epoch: await aclEpoch(), rules: await ruleCount(), audit: await auditCount() });

  before(async () => {
    dbHelper = await setupTestDatabase();
    pool = dbHelper.pool;
    app = createApp();

    await pool.query(
      `INSERT INTO organizations (id, name, slug, default_policy) VALUES
         ($1, 'Guard A', 'guard-a', 'deny'), ($2, 'Guard B', 'guard-b', 'deny')
       ON CONFLICT (id) DO NOTHING`,
      [orgA, orgB]
    );
    await pool.query(
      `INSERT INTO users (id, username, email, password_hash, role, organization_id) VALUES
         ('usr-guard-root', 'guardroot', 'root@guard.local', 'x', 'super-admin', $1),
         ('usr-guard-admin', 'guardadmin', 'admin@guard.local', 'x', 'admin', $1),
         ('usr-guard-badmin', 'guardbadmin', 'badmin@guard.local', 'x', 'admin', $2)
       ON CONFLICT (id) DO NOTHING`,
      [orgA, orgB]
    );
    // Reading the policy and its tests needs an organisation role, not just a user row.
    await pool.query(
      `INSERT INTO memberships (id, user_id, organization_id, role) VALUES
         ('mem-guard-admin', 'usr-guard-admin', $1, 'admin'),
         ('mem-guard-badmin', 'usr-guard-badmin', $2, 'admin')
       ON CONFLICT (id) DO NOTHING`,
      [orgA, orgB]
    );
    await pool.query(
      `INSERT INTO nodes (id, organization_id, user_id, name, overlay_ipv4, overlay_ipv6, public_key, role, is_healthy, is_quarantined) VALUES
         ('node-guard-1', $1, 'usr-guard-admin', 'g1', '100.64.20.1', 'fd00:20::1', 'GuardKey1111111111111111111111111111111111=', 'CLIENT_ORIGIN', TRUE, FALSE),
         ('node-guard-2', $1, 'usr-guard-admin', 'g2', '100.64.20.2', 'fd00:20::2', 'GuardKey2222222222222222222222222222222222=', 'CLIENT_ORIGIN', TRUE, FALSE)
       ON CONFLICT (id) DO NOTHING`,
      [orgA]
    );

    const token = (id, username, role, org) =>
      issueConsoleTestToken({ sub: id, id, username, role, organization_id: org });
    rootToken = await token('usr-guard-root', 'guardroot', 'super-admin', orgB);
    adminToken = await token('usr-guard-admin', 'guardadmin', 'admin', orgA);
    otherAdminToken = await token('usr-guard-badmin', 'guardbadmin', 'admin', orgB);
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM acl_policy_tests');
    await pool.query('DELETE FROM acl_rules');
    await pool.query("UPDATE organizations SET default_policy = 'deny' WHERE id IN ($1, $2)", [orgA, orgB]);
  });

  after(async () => {
    if (dbHelper) await dbHelper.cleanup();
  });

  const addRule = (token, rule) => request(app).post('/api/acl/rules').set(auth(token)).send(rule);
  const allowSsh = {
    priority: 10,
    source_cidr: '100.64.20.0/24',
    destination_cidr: '100.64.20.0/24',
    protocol: 'TCP',
    port_start: 22,
    port_end: 22,
    action: 'ACCEPT'
  };
  const dropSsh = {
    priority: 5,
    source_cidr: '100.64.20.1/32',
    destination_cidr: '100.64.20.2/32',
    protocol: 'TCP',
    port_start: 22,
    port_end: 22,
    action: 'DROP'
  };

  it('evaluates a candidate rule set without reading the stored rules', async () => {
    assert.strictEqual((await addRule(adminToken, allowSsh)).status, 201);
    const candidate = [{ id: 'cand', enabled: true, ...dropSsh }];
    const result = await AclEngine.simulatePacket({
      ...SSH,
      defaultPolicy: 'deny',
      organizationId: orgA,
      accessTier: 'root',
      rules: candidate
    });
    assert.strictEqual(result.verdict, 'DROP');
    assert.strictEqual(result.matched_rule.id, 'cand');
  });

  it('refuses a test the current policy already fails', async () => {
    const res = await request(app)
      .post('/api/acl/tests')
      .set(auth(adminToken))
      .send({ ...SSH, expect: 'ACCEPT' });
    assert.strictEqual(res.status, 409);
    assert.strictEqual(res.body.error, 'policy_tests_failed');
    assert.strictEqual(res.body.failures.length, 1);
    assert.strictEqual(res.body.failures[0].got, 'DROP');
  });

  it('stores a passing test and lists it for the organisation only', async () => {
    assert.strictEqual((await addRule(adminToken, allowSsh)).status, 201);
    const created = await request(app)
      .post('/api/acl/tests')
      .set(auth(adminToken))
      .send({ ...SSH, expect: 'ACCEPT', description: 'ops SSH' });
    assert.strictEqual(created.status, 201);
    assert.ok(created.body.test.id);

    const mine = await request(app).get('/api/acl/tests').set(auth(adminToken));
    assert.strictEqual(mine.status, 200);
    assert.strictEqual(mine.body.tests.length, 1);
    const theirs = await request(app).get('/api/acl/tests').set(auth(otherAdminToken));
    assert.strictEqual(theirs.body.tests.length, 0);
  });

  it('refuses a rule that breaks a stored test and leaves rules, epoch and audit untouched', async () => {
    assert.strictEqual((await addRule(adminToken, allowSsh)).status, 201);
    assert.strictEqual(
      (
        await request(app)
          .post('/api/acl/tests')
          .set(auth(adminToken))
          .send({ ...SSH, expect: 'ACCEPT' })
      ).status,
      201
    );

    const before = await snapshot();
    const res = await addRule(adminToken, dropSsh);
    assert.strictEqual(res.status, 409);
    assert.strictEqual(res.body.error, 'policy_tests_failed');
    assert.strictEqual(res.body.failures[0].organization_id, orgA);
    assert.strictEqual(res.body.failures[0].got, 'DROP');
    assert.deepStrictEqual(await snapshot(), before);
  });

  it('guards updates, including disabling the rule a test relies on', async () => {
    const rule = (await addRule(adminToken, allowSsh)).body.rule;
    assert.strictEqual(
      (
        await request(app)
          .post('/api/acl/tests')
          .set(auth(adminToken))
          .send({ ...SSH, expect: 'ACCEPT' })
      ).status,
      201
    );

    const before = await snapshot();
    const res = await request(app).put(`/api/acl/rules/${rule.id}`).set(auth(adminToken)).send({ enabled: false });
    assert.strictEqual(res.status, 409);
    assert.deepStrictEqual(await snapshot(), before);
  });

  it('guards deletes', async () => {
    const rule = (await addRule(adminToken, allowSsh)).body.rule;
    assert.strictEqual(
      (
        await request(app)
          .post('/api/acl/tests')
          .set(auth(adminToken))
          .send({ ...SSH, expect: 'ACCEPT' })
      ).status,
      201
    );

    const res = await request(app).delete(`/api/acl/rules/${rule.id}`).set(auth(adminToken));
    assert.strictEqual(res.status, 409);
    assert.strictEqual(await ruleCount(), 1);
  });

  it('guards the default policy: deny to open may let forbidden traffic through', async () => {
    assert.strictEqual(
      (
        await request(app)
          .post('/api/acl/tests')
          .set(auth(adminToken))
          .send({ ...SSH, expect: 'DROP' })
      ).status,
      201
    );
    const res = await request(app)
      .put('/api/acl/default-policy')
      .set(auth(adminToken))
      .send({ default_policy: 'open' });
    assert.strictEqual(res.status, 409);
    const row = await pool.query('SELECT default_policy FROM organizations WHERE id = $1', [orgA]);
    assert.strictEqual(row.rows[0].default_policy, 'deny');
  });

  it("refuses a platform rule that breaks another organisation's test and names it", async () => {
    assert.strictEqual((await addRule(adminToken, allowSsh)).status, 201);
    assert.strictEqual(
      (
        await request(app)
          .post('/api/acl/tests')
          .set(auth(adminToken))
          .send({ ...SSH, expect: 'ACCEPT' })
      ).status,
      201
    );
    // The super-admin belongs to org B; the platform rule still reaches org A's nodes.
    const res = await addRule(rootToken, { ...dropSsh, organization_id: null });
    assert.strictEqual(res.status, 409);
    assert.strictEqual(res.body.failures[0].organization_id, orgA);
  });

  it('serialises concurrent saves so two individually safe saves cannot break a test together', async () => {
    // DROP default: the test needs at least one of the two ACCEPT rules to survive.
    const r1 = (await addRule(adminToken, allowSsh)).body.rule;
    const r2 = (await addRule(adminToken, { ...allowSsh, priority: 20 })).body.rule;
    assert.strictEqual(
      (
        await request(app)
          .post('/api/acl/tests')
          .set(auth(adminToken))
          .send({ ...SSH, expect: 'ACCEPT' })
      ).status,
      201
    );

    const [a, b] = await Promise.all([
      request(app).delete(`/api/acl/rules/${r1.id}`).set(auth(adminToken)),
      request(app).delete(`/api/acl/rules/${r2.id}`).set(auth(adminToken))
    ]);
    assert.deepStrictEqual([a.status, b.status].sort(), [200, 409]);
    assert.strictEqual(await ruleCount(), 1);
  });

  it('runs the stored tests on demand', async () => {
    assert.strictEqual((await addRule(adminToken, allowSsh)).status, 201);
    assert.strictEqual(
      (
        await request(app)
          .post('/api/acl/tests')
          .set(auth(adminToken))
          .send({ ...SSH, expect: 'ACCEPT' })
      ).status,
      201
    );
    const res = await request(app).post('/api/acl/tests/run').set(auth(adminToken));
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.total, 1);
    assert.deepStrictEqual(res.body.failures, []);
  });

  it('deletes a test only within its organisation', async () => {
    assert.strictEqual((await addRule(adminToken, allowSsh)).status, 201);
    const id = (
      await request(app)
        .post('/api/acl/tests')
        .set(auth(adminToken))
        .send({ ...SSH, expect: 'ACCEPT' })
    ).body.test.id;
    assert.strictEqual((await request(app).delete(`/api/acl/tests/${id}`).set(auth(otherAdminToken))).status, 404);
    assert.strictEqual((await request(app).delete(`/api/acl/tests/${id}`).set(auth(adminToken))).status, 200);
  });

  it('records the rule before and after an update in the audit row', async () => {
    const rule = (await addRule(adminToken, allowSsh)).body.rule;
    const res = await request(app).put(`/api/acl/rules/${rule.id}`).set(auth(adminToken)).send({ port_end: 23 });
    assert.strictEqual(res.status, 200);
    await settleAuditWrites();
    const row = await pool.query(
      "SELECT metadata_json FROM audit_events WHERE event_type = 'ACL_RULE_UPDATED' AND target_id = $1 ORDER BY sequence_num DESC LIMIT 1",
      [rule.id]
    );
    const meta =
      typeof row.rows[0].metadata_json === 'string' ? JSON.parse(row.rows[0].metadata_json) : row.rows[0].metadata_json;
    assert.strictEqual(Number(meta.before.port_end), 22);
    assert.strictEqual(Number(meta.after.port_end), 23);
  });
});
