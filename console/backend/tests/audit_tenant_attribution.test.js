const { describe, it, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const { setupTestDatabase } = require('./helpers/db');
const { issueConsoleTestToken } = require('./helpers/consoleSession');
const { createApp } = require('../server');
const { AuditChainService } = require('../services/AuditChainService');
const { settleAuditWrites } = require('../utils/audit');

// organizationId is trusted internal append context, never a public request field.
// A historical actor's current membership is not evidence of an event's tenant.
describe('Audit tenant attribution through HTTP and PostgreSQL', () => {
  const orgA = 'org-audit-attribution-a';
  const orgB = 'org-audit-attribution-b';
  const users = {
    auditorA: { id: 'audit-attribution-auditor-a', org: orgA, role: 'auditor' },
    auditorB: { id: 'audit-attribution-auditor-b', org: orgB, role: 'auditor' },
    member: { id: 'audit-attribution-member', org: orgA, role: 'member' },
    otherA: { id: 'audit-attribution-other-a', org: orgA, role: 'member' },
    otherB: { id: 'audit-attribution-other-b', org: orgB, role: 'member' }
  };
  const listingPaths = ['/api/audit', '/api/stats'].flatMap((prefix) =>
    ['/audit-logs', '/events', '/logs'].map((suffix) => prefix + suffix)
  );
  let db, app, tokens, events;

  async function tokenFor(id) {
    const user = (await db.pool.query('SELECT * FROM users WHERE id=$1', [id])).rows[0];
    return issueConsoleTestToken(user, { expiresIn: '1h' });
  }

  before(async () => {
    db = await setupTestDatabase();
    assert.match(db.dbName, /^neronet_t_/);
    const postgres = (await db.pool.query("SELECT current_setting('server_version') AS version")).rows[0].version;
    console.info(`Audit attribution baseline runtime: Node ${process.version}; PostgreSQL ${postgres}`);
    app = createApp();
    for (const id of [orgA, orgB]) {
      await db.pool.query('INSERT INTO organizations(id,name,slug) VALUES($1,$1,$1)', [id]);
    }
    tokens = {};
    for (const [name, user] of Object.entries(users)) {
      await db.pool.query(
        `INSERT INTO users(id,username,email,password_hash,role,organization_id)
         VALUES($1,$1,$2,'fixture-password-hash','user',$3)`,
        [user.id, `${user.id}@audit.test`, user.org]
      );
      await db.pool.query('INSERT INTO memberships(id,user_id,organization_id,role) VALUES($1,$2,$3,$4)', [
        `mem-${user.id}`,
        user.id,
        user.org,
        user.role
      ]);
      tokens[name] = await tokenFor(user.id);
    }
    tokens.platform = await tokenFor('usr-admin');
  });

  async function append(targetId, actor, organizationId) {
    return AuditChainService.appendEvent({
      eventType: 'AUDIT_TENANT_ATTRIBUTION_PROBE',
      actorUserId: actor.id,
      actorUsername: actor.id,
      targetId,
      targetType: 'tenant-attribution-fixture',
      message: `Audit attribution probe ${targetId}`,
      // The metadata deliberately cannot stand in for authenticated attribution.
      metadata: { fixture: 'audit-tenant-attribution', organization_id: orgA },
      ...(organizationId === undefined ? {} : { organizationId })
    });
  }

  beforeEach(async () => {
    assert.equal((await db.pool.query('SELECT current_database() AS name')).rows[0].name, db.dbName);
    await settleAuditWrites();
    await db.pool.query('DELETE FROM audit_checkpoints');
    await db.pool.query('DELETE FROM audit_events');
    // Each transfer test starts from the same real membership state.
    await db.pool.query('DELETE FROM memberships WHERE user_id=$1', [users.member.id]);
    await db.pool.query('UPDATE users SET organization_id=$1 WHERE id=$2', [orgA, users.member.id]);
    await db.pool.query("INSERT INTO memberships(id,user_id,organization_id,role) VALUES($1,$2,$3,'member')", [
      `mem-${users.member.id}`,
      users.member.id,
      orgA
    ]);
    tokens.member = await tokenFor(users.member.id);
    events = {};
    for (const [target, actor, org] of [
      ['auditor-a-own', users.auditorA, orgA],
      ['auditor-b-own', users.auditorB, orgB],
      ['member-own-a', users.member, orgA],
      ['other-a', users.otherA, orgA],
      ['other-b', users.otherB, orgB],
      ['member-other-tenant', users.member, orgB],
      ['auditor-other-tenant', users.auditorA, orgB],
      ['member-unattributed', users.member, undefined],
      ['auditor-unattributed', users.auditorA, undefined]
    ]) {
      events[target] = await append(target, actor, org);
    }
  });

  after(async () => {
    if (db) await db.cleanup();
  });

  async function list(path, token, query = {}) {
    const response = await request(app)
      .get(path)
      .query({ limit: 1000, ...query })
      .auth(token, { type: 'bearer' });
    assert.equal(response.status, 200, 'listing must reach the real handler');
    assert.ok(Array.isArray(response.body.audit_logs));
    return response.body.audit_logs;
  }

  function targets(logs) {
    return logs.map((event) => event.resource).sort();
  }

  it('persists trusted internal organization context on a successfully appended row', async () => {
    const row = (await db.pool.query('SELECT * FROM audit_events WHERE id=$1', [events['member-own-a'].id])).rows[0];
    assert.ok(row, 'the append must reach PostgreSQL before attribution is checked');
    assert.equal(row.organization_id, orgA, 'the event needs immutable tenant attribution');
  });

  it('keeps the real global cryptographic chain valid for attributed and unattributed appends', async () => {
    const response = await request(app).get('/api/audit/verify').auth(tokens.platform, { type: 'bearer' });
    assert.equal(response.status, 200);
    assert.equal(response.body.verification.valid, true);
    assert.equal(response.body.verification.events_count, 9);
  });

  for (const path of listingPaths) {
    it(`${path}: platform super-admin sees both tenants and unattributed history`, async () => {
      assert.deepEqual(targets(await list(path, tokens.platform)), Object.keys(events).sort());
    });

    it(`${path}: member can read their own event attributed to the current tenant`, async () => {
      assert.ok(targets(await list(path, tokens.member)).includes('member-own-a'));
    });

    it(`${path}: auditor A can read other actors in A without widening member visibility`, async () => {
      assert.deepEqual(targets(await list(path, tokens.auditorA)), ['auditor-a-own', 'member-own-a', 'other-a']);
    });

    it(`${path}: auditor B can read other actors in B`, async () => {
      assert.deepEqual(targets(await list(path, tokens.auditorB)), [
        'auditor-b-own',
        'auditor-other-tenant',
        'member-other-tenant',
        'other-b'
      ]);
    });

    it(`${path}: member still cannot read another actor in the same tenant`, async () => {
      const visible = targets(await list(path, tokens.member));
      assert.ok(visible.includes('member-own-a'));
      assert.ok(!visible.includes('other-a'));
      assert.ok(!visible.includes('auditor-a-own'));
    });

    it(`${path}: member cannot read their own event attributed to a different tenant`, async () => {
      assert.ok(!targets(await list(path, tokens.member)).includes('member-other-tenant'));
    });

    it(`${path}: auditor cannot read their own event attributed to a different tenant`, async () => {
      assert.ok(!targets(await list(path, tokens.auditorA)).includes('auditor-other-tenant'));
    });

    it(`${path}: unattributed history is platform only even when actor and metadata match A`, async () => {
      const member = await list(path, tokens.member);
      const auditor = await list(path, tokens.auditorA);
      assert.deepEqual(
        {
          member: targets(member).includes('member-unattributed'),
          auditor: targets(auditor).includes('auditor-unattributed')
        },
        { member: false, auditor: false }
      );
    });

    it(`${path}: query parameters cannot select another tenant or actor`, async () => {
      const logs = await list(path, tokens.member, {
        org_id: orgB,
        organization_id: orgB,
        actor_user_id: users.otherB.id
      });
      assert.deepEqual(targets(logs), ['member-own-a']);
    });
  }

  for (const role of ['auditorA', 'auditorB', 'member']) {
    it(`${role}: global verification, checkpoints and export require platform super-admin`, async () => {
      for (const prefix of ['/api/audit', '/api/stats']) {
        for (const suffix of ['/verify', '/checkpoints', '/export?format=json', '/export?format=csv']) {
          const response = await request(app).get(`${prefix}${suffix}`).auth(tokens[role], { type: 'bearer' });
          assert.equal(response.status, 403, `${prefix}${suffix} must stay platform only`);
        }
        const response = await request(app)
          .post(`${prefix}/checkpoints`)
          .auth(tokens[role], { type: 'bearer' })
          .send({});
        assert.equal(response.status, 403);
      }
    });
  }

  it('platform super-admin can checkpoint and export the same complete global ledger', async () => {
    const checkpoint = await request(app)
      .post('/api/audit/checkpoints')
      .auth(tokens.platform, { type: 'bearer' })
      .send({});
    assert.equal(checkpoint.status, 201);
    for (const prefix of ['/api/audit', '/api/stats']) {
      const response = await request(app).get(`${prefix}/export?format=json`).auth(tokens.platform, { type: 'bearer' });
      assert.equal(response.status, 200);
      assert.equal(response.body.chain_verification.valid, true);
      assert.deepEqual(response.body.events.map((event) => event.target_id).sort(), Object.keys(events).sort());
      const csv = await request(app).get(`${prefix}/export?format=csv`).auth(tokens.platform, { type: 'bearer' });
      assert.equal(csv.status, 200);
      assert.match(csv.headers['content-type'], /text\/csv/);
      for (const target of Object.keys(events)) assert.ok(csv.text.includes(`"${target}"`));
    }
  });

  async function moveMemberToB() {
    const oldEpoch = BigInt(
      (await db.pool.query('SELECT console_auth_epoch FROM users WHERE id=$1', [users.member.id])).rows[0]
        .console_auth_epoch
    );
    const oldFamily = jwt.decode(tokens.member).sid;
    await db.pool.query('DELETE FROM memberships WHERE user_id=$1', [users.member.id]);
    await db.pool.query('UPDATE users SET organization_id=$1 WHERE id=$2', [orgB, users.member.id]);
    await db.pool.query("INSERT INTO memberships(id,user_id,organization_id,role) VALUES($1,$2,$3,'member')", [
      `mem-${users.member.id}`,
      users.member.id,
      orgB
    ]);
    const newEpoch = BigInt(
      (await db.pool.query('SELECT console_auth_epoch FROM users WHERE id=$1', [users.member.id])).rows[0]
        .console_auth_epoch
    );
    assert.ok(newEpoch > oldEpoch, 'the transfer must advance the durable MFA authorization epoch');
    // Mint a fresh real family after the transfer, so an old challenge or token
    // cannot accidentally supply the test's tenant context.
    const token = await tokenFor(users.member.id);
    const claims = jwt.decode(token);
    assert.notEqual(claims.sid, oldFamily);
    assert.equal(claims.organization_id, orgB);
    const family = (
      await db.pool.query('SELECT issued_organization_id FROM console_sessions WHERE id=$1', [claims.sid])
    ).rows[0];
    assert.equal(family.issued_organization_id, orgB);
    await append('member-new-b', users.member, orgB);
    return token;
  }

  for (const path of listingPaths) {
    it(`${path}: after A to B transfer a fresh member family sees only own events attributed to B`, async () => {
      const token = await moveMemberToB();
      assert.deepEqual(targets(await list(path, token)), ['member-new-b', 'member-other-tenant']);
    });

    it(`${path}: moving an actor does not remove their historical attributed events from auditor A`, async () => {
      await moveMemberToB();
      const visible = targets(await list(path, tokens.auditorA));
      assert.ok(visible.includes('member-own-a'));
      assert.ok(!visible.includes('member-new-b'));
    });

    it(`${path}: auditor B never receives old A events through the moved actor's current membership`, async () => {
      await moveMemberToB();
      const visible = targets(await list(path, tokens.auditorB));
      assert.ok(visible.includes('auditor-b-own'));
      assert.ok(!visible.includes('member-own-a'));
      assert.ok(!visible.includes('member-unattributed'));
    });
  }
});
