const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const crypto = require('node:crypto');
const { setupTestDatabase } = require('./helpers/db');
const { createApp } = require('../server');
const config = require('../config/env');
const { CryptoShreddingService } = require('../services/CryptoShreddingService');

describe('Destruction governance confines each actor to their effective tenant and role', () => {
  let db;
  let pool;
  let app;
  let sequence = 0;
  const api = (method, path, actor, body) =>
    request(app)[method](`/api/nuke${path}`).set('Authorization', `Bearer ${actor.token}`).send(body);

  before(async () => {
    db = await setupTestDatabase();
    pool = db.pool;
    assert.match(db.dbName, /^neronet_t_/, 'destructive tests require their own temporary database');
    assert.equal((await pool.query('SELECT current_database() AS name')).rows[0].name, db.dbName);
    app = createApp();
  });
  after(async () => {
    if (db) await db.cleanup();
  });

  async function fixture(representation = 'legacy') {
    // Each case owns fresh tenants. Holds from earlier cases must not accidentally
    // mask missing global-role checks with an unrelated LEGAL_HOLD_ACTIVE response.
    await pool.query('UPDATE organization_legal_holds SET active = FALSE');
    const prefix = `gov-${++sequence}`;
    const orgA = `${prefix}-a`;
    const orgB = `${prefix}-b`;
    await pool.query('INSERT INTO organizations (id, name, slug) VALUES ($1, $1, $1), ($2, $2, $2)', [orgA, orgB]);
    async function actor(name, org, role, platform = false) {
      const id = `${prefix}-${name}`;
      const storedRole = platform ? 'super-admin' : representation === 'membership' ? 'user' : role;
      await pool.query(
        `INSERT INTO users (id, username, email, password_hash, role, organization_id)
         VALUES ($1, $1, $2, 'fixture', $3, $4)`,
        [id, `${id}@test.invalid`, storedRole, org]
      );
      // Legacy fixtures model accounts after migration 033. The upgrade test
      // separately executes the real migration on accounts without memberships.
      if (!platform) {
        await pool.query('INSERT INTO memberships (id, user_id, organization_id, role) VALUES ($1, $2, $3, $4)', [
          `mem-${id}`,
          id,
          org,
          role
        ]);
      }
      const claims = { id, username: id, role: storedRole, organization_id: org };
      return { id, org, role, claims, token: jwt.sign(claims, config.JWT_SECRET, { expiresIn: '1h' }) };
    }
    const owner = await actor('owner-a', orgA, 'owner');
    const admin = await actor('admin-a', orgA, 'admin');
    const foreignOwner = await actor('owner-b', orgB, 'owner');
    const foreignAdmin = await actor('admin-b', orgB, 'admin');
    const platform = await actor('platform', orgA, 'super-admin', true);
    const platform2 = await actor('platform2', orgA, 'super-admin', true);
    const nodes = [];
    for (const [index, org, user] of [
      [1, orgA, owner],
      [2, orgB, foreignOwner]
    ]) {
      const id = `${prefix}-node-${index}`;
      nodes.push(id);
      await pool.query(
        `INSERT INTO nodes (id, user_id, name, public_key, overlay_ipv4, overlay_ipv6, organization_id)
         VALUES ($1, $2, $1, $3, $4, $5, $6)`,
        [
          id,
          user.id,
          crypto
            .generateKeyPairSync('x25519')
            .publicKey.export({ type: 'spki', format: 'der' })
            .subarray(-32)
            .toString('base64'),
          `100.99.${sequence}.${index}`,
          `fd99::${sequence}:${index}`,
          org
        ]
      );
      await CryptoShreddingService.getOrCreateOrgDEK(org);
    }
    return { prefix, orgA, orgB, owner, admin, foreignOwner, foreignAdmin, platform, platform2, nodes, actor };
  }

  async function authorization(f, target = f.orgB, initiator = f.foreignOwner, type = 'organization') {
    const id = `${f.prefix}-auth-${target}`;
    await pool.query(
      `INSERT INTO nuke_authorizations (id, target_type, target_id, initiator_user_id, expires_at)
       VALUES ($1, $2, $3, $4, NOW() + INTERVAL '1 hour')`,
      [id, type, target, initiator.id]
    );
    return id;
  }

  async function hold(f, org = f.orgB) {
    const id = `${f.prefix}-hold-${org}`;
    await pool.query(
      `INSERT INTO organization_legal_holds (id, organization_id, reason, imposed_by_user_id)
       VALUES ($1, $2, 'Confidential preservation order', $3)`,
      [id, org, f.foreignOwner.id]
    );
    return id;
  }

  async function assertIntact(f, org = f.orgB) {
    assert.equal(
      (await pool.query('SELECT status FROM organization_keys WHERE organization_id = $1', [org])).rows[0].status,
      'active'
    );
    assert.equal(
      (await pool.query('SELECT COUNT(*)::int AS n FROM nodes WHERE organization_id = $1', [org])).rows[0].n,
      1
    );
    assert.equal(
      (await pool.query('SELECT destroyed_at FROM organizations WHERE id = $1', [org])).rows[0].destroyed_at,
      null
    );
  }

  for (const representation of ['legacy', 'membership']) {
    for (const [path, field, kind] of [
      ['/legal-hold', 'legal_holds', 'hold'],
      ['/dual-auth', 'authorizations', 'authorization'],
      ['/status', 'pendingApprovals', 'authorization']
    ]) {
      it(`${representation}: ${path} exposes only the current tenant`, async () => {
        const f = await fixture(representation);
        const own = await authorization(f, f.orgA, f.owner);
        const foreign = await authorization(f);
        const global = await authorization(f, 'all', f.platform, 'global');
        const ownHold = await hold(f, f.orgA);
        const foreignHold = await hold(f);
        const res = await api('get', path, f.owner);
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.deepEqual(
          res.body[field].map((row) => row.id),
          [kind === 'hold' ? ownHold : own]
        );
        for (const secret of [foreign, global, foreignHold, f.orgB]) {
          assert.ok(!JSON.stringify(res.body).includes(secret), `foreign metadata leaked from ${path}`);
        }
      });
    }

    it(`${representation}: cannot impose a foreign legal hold`, async () => {
      const f = await fixture(representation);
      const res = await api('post', '/legal-hold', f.owner, { organization_id: f.orgB, reason: 'Foreign hold' });
      assert.equal(res.status, 404, JSON.stringify(res.body));
      assert.equal(
        (await pool.query('SELECT * FROM organization_legal_holds WHERE organization_id = $1', [f.orgB])).rowCount,
        0
      );
    });

    it(`${representation}: cannot release a foreign legal hold`, async () => {
      const f = await fixture(representation);
      const id = await hold(f);
      const res = await api('delete', `/legal-hold/${id}`, f.owner);
      assert.equal(res.status, 404, JSON.stringify(res.body));
      assert.equal(
        (await pool.query('SELECT active FROM organization_legal_holds WHERE id = $1', [id])).rows[0].active,
        true
      );
    });

    it(`${representation}: cannot request foreign organization destruction`, async () => {
      const f = await fixture(representation);
      const res = await api('post', '/dual-auth/request', f.admin, { target_type: 'organization', target_id: f.orgB });
      assert.equal(res.status, 404, JSON.stringify(res.body));
      assert.equal((await pool.query('SELECT * FROM nuke_authorizations WHERE target_id = $1', [f.orgB])).rowCount, 0);
      await assertIntact(f);
    });

    it(`${representation}: cannot approve or execute foreign destruction`, async () => {
      const f = await fixture(representation);
      const id = await authorization(f);
      const res = await api('post', `/dual-auth/approve/${id}`, f.admin, {});
      assert.equal(res.status, 404, JSON.stringify(res.body));
      await assertIntact(f);
      assert.equal(
        (await pool.query('SELECT status FROM nuke_authorizations WHERE id = $1', [id])).rows[0].status,
        'pending'
      );
    });

    it(`${representation}: cannot reject a foreign request`, async () => {
      const f = await fixture(representation);
      const id = await authorization(f);
      const res = await api('post', `/dual-auth/reject/${id}`, f.owner, {});
      assert.equal(res.status, 404, JSON.stringify(res.body));
      assert.equal(
        (await pool.query('SELECT status FROM nuke_authorizations WHERE id = $1', [id])).rows[0].status,
        'pending'
      );
    });

    for (const operation of ['release', 'approve', 'reject']) {
      it(`${representation}: ${operation} conceals whether a foreign resource exists`, async () => {
        const f = await fixture(representation);
        const id = operation === 'release' ? await hold(f) : await authorization(f);
        const path = operation === 'release' ? '/legal-hold/' : `/dual-auth/${operation}/`;
        const method = operation === 'release' ? 'delete' : 'post';
        const unknown = await api(method, `${path}unknown-governance-resource`, f.owner, {});
        const foreign = await api(method, `${path}${id}`, f.owner, {});
        assert.equal(unknown.status, 404, JSON.stringify(unknown.body));
        assert.equal(foreign.status, 404, JSON.stringify(foreign.body));
        assert.deepEqual(foreign.body, unknown.body);
        await assertIntact(f);
      });
    }

    it(`${representation}: organization owner cannot request global destruction`, async () => {
      const f = await fixture(representation);
      const res = await api('post', '/dual-auth/request', f.owner, { target_type: 'global', target_id: 'all' });
      assert.equal(res.status, 403, JSON.stringify(res.body));
      assert.equal(
        (await pool.query('SELECT * FROM nuke_authorizations WHERE initiator_user_id = $1', [f.owner.id])).rowCount,
        0
      );
    });

    it(`${representation}: organization admin cannot approve global destruction`, async () => {
      const f = await fixture(representation);
      const id = await authorization(f, 'all', f.platform, 'global');
      const res = await api('post', `/dual-auth/approve/${id}`, f.admin, {});
      assert.equal(res.status, 403, JSON.stringify(res.body));
      await assertIntact(f, f.orgA);
      await assertIntact(f);
    });

    it(`${representation}: organization owner cannot reject global destruction`, async () => {
      const f = await fixture(representation);
      const id = await authorization(f, 'all', f.platform, 'global');
      const res = await api('post', `/dual-auth/reject/${id}`, f.owner, {});
      assert.equal(res.status, 403, JSON.stringify(res.body));
      assert.equal(
        (await pool.query('SELECT status FROM nuke_authorizations WHERE id = $1', [id])).rows[0].status,
        'pending'
      );
    });

    it(`${representation}: foreign holds do not disclose preservation details`, async () => {
      const f = await fixture(representation);
      await hold(f);
      const unknown = await api('post', '/dual-auth/request', f.owner, {
        target_type: 'organization',
        target_id: 'unknown-governance-org'
      });
      const foreign = await api('post', '/dual-auth/request', f.owner, {
        target_type: 'organization',
        target_id: f.orgB
      });
      assert.equal(foreign.status, 404, JSON.stringify(foreign.body));
      assert.equal(unknown.status, 404, JSON.stringify(unknown.body));
      assert.deepEqual(foreign.body, unknown.body);
      assert.ok(!JSON.stringify(foreign.body).includes('Confidential preservation order'));
    });

    it(`${representation}: own legal hold, owner release and rejection remain authorized`, async () => {
      const f = await fixture(representation);
      const created = await api('post', '/legal-hold', f.admin, {
        organization_id: f.orgA,
        reason: 'Own preservation'
      });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      const id = created.body.hold.id;
      assert.equal((await api('delete', `/legal-hold/${id}`, f.admin)).status, 403);
      assert.equal((await api('delete', `/legal-hold/${id}`, f.owner)).status, 200);
      const pending = await api('post', '/dual-auth/request', f.owner, {
        target_type: 'organization',
        target_id: f.orgA
      });
      assert.equal(pending.status, 201, JSON.stringify(pending.body));
      const rejected = await api('post', `/dual-auth/reject/${pending.body.authorization.id}`, f.admin, {});
      assert.equal(rejected.status, 200, JSON.stringify(rejected.body));
      assert.equal(rejected.body.authorization.status, 'rejected');
      await assertIntact(f, f.orgA);
      await assertIntact(f);
    });

    it(`${representation}: two own administrators destroy only their organization`, async () => {
      const f = await fixture(representation);
      const pending = await api('post', '/dual-auth/request', f.owner, {
        target_type: 'organization',
        target_id: f.orgA
      });
      assert.equal(pending.status, 201, JSON.stringify(pending.body));
      const id = pending.body.authorization.id;
      assert.equal((await api('post', `/dual-auth/approve/${id}`, f.owner, {})).status, 403);
      const approved = await api('post', `/dual-auth/approve/${id}`, f.admin, {});
      assert.equal(approved.status, 200, JSON.stringify(approved.body));
      assert.equal(
        (await pool.query('SELECT status FROM organization_keys WHERE organization_id = $1', [f.orgA])).rows[0].status,
        'destroyed'
      );
      assert.equal((await pool.query('SELECT * FROM nodes WHERE organization_id = $1', [f.orgA])).rowCount, 0);
      await assertIntact(f);
    });

    it(`${representation}: own member and auditor cannot mutate governance`, async () => {
      const f = await fixture(representation);
      for (const role of ['member', 'auditor']) {
        const actor = await f.actor(role, f.orgA, role);
        const res = await api('post', '/legal-hold', actor, { organization_id: f.orgA, reason: 'Unauthorized' });
        assert.equal(res.status, 403, JSON.stringify(res.body));
      }
    });
  }

  it('membership demotion overrides a legacy owner role and stale JWT', async () => {
    const f = await fixture();
    await pool.query("UPDATE memberships SET role = 'auditor' WHERE user_id = $1", [f.owner.id]);
    const res = await api('post', '/legal-hold', f.owner, { organization_id: f.orgA, reason: 'Stale owner privilege' });
    assert.equal(res.status, 403, JSON.stringify(res.body));
  });

  it('a stale platform JWT does not grant global authority after demotion', async () => {
    const f = await fixture();
    await pool.query("UPDATE users SET role = 'owner' WHERE id = $1", [f.platform.id]);
    const res = await api('post', '/dual-auth/request', f.platform, { target_type: 'global', target_id: 'all' });
    assert.equal(res.status, 403, JSON.stringify(res.body));
  });

  it('a stale tenant JWT cannot select a foreign tenant for governance', async () => {
    const f = await fixture();
    f.owner.token = jwt.sign({ ...f.owner.claims, organization_id: f.orgB }, config.JWT_SECRET, { expiresIn: '1h' });
    const res = await api('post', '/legal-hold', f.owner, { organization_id: f.orgB, reason: 'Stale tenant claim' });
    assert.equal(res.status, 404, JSON.stringify(res.body));
  });

  it('a pending request with a foreign initiator cannot be legitimized by the target owner', async () => {
    const f = await fixture();
    const id = await authorization(f, f.orgB, f.owner);
    const res = await api('post', `/dual-auth/approve/${id}`, f.foreignOwner, {});
    assert.equal(res.status, 403, JSON.stringify(res.body));
    await assertIntact(f);
  });

  it('global execution requires the initiator as well as the approver to be platform administrators', async () => {
    const f = await fixture();
    const id = await authorization(f, 'all', f.owner, 'global');
    const res = await api('post', `/dual-auth/approve/${id}`, f.platform, {});
    assert.equal(res.status, 403, JSON.stringify(res.body));
    await assertIntact(f);
  });

  for (const change of [
    'demoted initiator',
    'removed initiator membership',
    'moved initiator',
    'demoted approver',
    'removed approver membership',
    'revoked approver'
  ]) {
    it(`a pending API request cannot execute after a ${change}`, async () => {
      const f = await fixture('membership');
      const pending = await api('post', '/dual-auth/request', f.owner, {
        target_type: 'organization',
        target_id: f.orgA
      });
      assert.equal(pending.status, 201, JSON.stringify(pending.body));
      const id = pending.body.authorization.id;
      if (change === 'demoted initiator')
        await pool.query("UPDATE memberships SET role = 'member' WHERE user_id = $1", [f.owner.id]);
      if (change === 'removed initiator membership')
        await pool.query('DELETE FROM memberships WHERE user_id = $1', [f.owner.id]);
      if (change === 'moved initiator')
        await pool.query('UPDATE users SET organization_id = $1 WHERE id = $2', [f.orgB, f.owner.id]);
      if (change === 'demoted approver')
        await pool.query("UPDATE memberships SET role = 'auditor' WHERE user_id = $1", [f.admin.id]);
      if (change === 'removed approver membership')
        await pool.query('DELETE FROM memberships WHERE user_id = $1', [f.admin.id]);
      if (change === 'revoked approver')
        await pool.query("UPDATE users SET status = 'revoked' WHERE id = $1", [f.admin.id]);
      const res = await api('post', `/dual-auth/approve/${id}`, f.admin, {});
      assert.equal(res.status, 403, JSON.stringify(res.body));
      assert.equal(
        (await pool.query('SELECT status FROM nuke_authorizations WHERE id = $1', [id])).rows[0].status,
        'pending'
      );
      await assertIntact(f, f.orgA);
      await assertIntact(f);
    });
  }

  it('the core service enforces tenant scope independently of HTTP middleware', async () => {
    const f = await fixture('membership');
    await assert.rejects(CryptoShreddingService.imposeLegalHold(f.orgB, 'Foreign direct hold', f.owner.id), {
      status: 404
    });
    await assert.rejects(
      CryptoShreddingService.requestDestruction({
        targetType: 'organization',
        targetId: f.orgB,
        initiatorUserId: f.owner.id
      }),
      { status: 404 }
    );
    const id = await authorization(f);
    await assert.rejects(CryptoShreddingService.approveAndExecuteDestruction(id, f.admin.id), { status: 404 });
    await assert.rejects(CryptoShreddingService.rejectDestruction(id, f.admin.id), { status: 404 });
    await assertIntact(f);
  });

  it('platform administrators retain cross-tenant holds, visibility and two-person global destruction', async () => {
    const f = await fixture('membership');
    // Prior tests retain holds. Global destruction is deliberately executed last in
    // this file's isolated neronet_t_* database, never against an application stack.
    await pool.query('UPDATE organization_legal_holds SET active = FALSE');
    const imposed = await api('post', '/legal-hold', f.platform, {
      organization_id: f.orgB,
      reason: 'Platform preservation'
    });
    assert.equal(imposed.status, 201, JSON.stringify(imposed.body));
    const listed = await api('get', '/legal-hold', f.platform);
    assert.ok(listed.body.legal_holds.some((row) => row.id === imposed.body.hold.id));
    const held = await api('post', '/dual-auth/request', f.platform, { target_type: 'global', target_id: 'all' });
    assert.equal(held.status, 403);
    assert.equal(held.body.code, 'LEGAL_HOLD_ACTIVE');
    assert.equal((await api('delete', `/legal-hold/${imposed.body.hold.id}`, f.platform2)).status, 200);
    const pending = await api('post', '/dual-auth/request', f.platform, { target_type: 'global', target_id: 'all' });
    assert.equal(pending.status, 201, JSON.stringify(pending.body));
    const id = pending.body.authorization.id;
    const visible = await api('get', '/dual-auth', f.platform2);
    assert.ok(visible.body.authorizations.some((row) => row.id === id));
    assert.equal((await api('post', `/dual-auth/approve/${id}`, f.platform, {})).status, 403);
    const approved = await api('post', `/dual-auth/approve/${id}`, f.platform2, {});
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.equal((await pool.query('SELECT * FROM nodes')).rowCount, 0);
    assert.equal((await pool.query("SELECT * FROM organization_keys WHERE status != 'destroyed'")).rowCount, 0);
  });
});
