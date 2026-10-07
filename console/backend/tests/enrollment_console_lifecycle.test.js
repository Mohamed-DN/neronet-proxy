const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { setTimeout: delay } = require('node:timers/promises');
const { setupTestDatabase } = require('./helpers/db');
const { createApp } = require('../server');
const { signToken } = require('../middleware/auth');
const { CryptoShreddingService: governance } = require('../services/CryptoShreddingService');

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('Console enrollment follows current organization and account authority', { timeout: 30000 }, () => {
  let db;
  let pool;
  let app;
  let sequence = 0;

  before(async () => {
    db = await setupTestDatabase();
    pool = db.pool;
    app = createApp();
    assert.match(db.dbName, /^neronet_t_/);
    assert.equal((await pool.query('SELECT current_database() AS name')).rows[0].name, db.dbName);
  });
  after(async () => {
    if (db) await db.cleanup();
  });

  async function fixture({ legacy = false } = {}) {
    const prefix = `console-enroll-${++sequence}`;
    const org = legacy ? 'org-default' : `${prefix}-org`;
    if (!legacy) await pool.query('INSERT INTO organizations (id,name,slug) VALUES ($1,$1,$1)', [org]);
    const member = `${prefix}-member`;
    const initiator = `${prefix}-owner`;
    const approver = `${prefix}-admin`;
    for (const [id, role] of [
      [member, 'member'],
      [initiator, 'owner'],
      [approver, 'admin']
    ]) {
      await pool.query(
        "INSERT INTO users (id,username,email,password_hash,role,organization_id) VALUES ($1,$1,$2,'fixture','user',$3)",
        [id, `${id}@test.invalid`, legacy ? null : org]
      );
      if (!legacy)
        await pool.query('INSERT INTO memberships (id,user_id,organization_id,role) VALUES ($1,$2,$3,$4)', [
          `mem-${id}`,
          id,
          org,
          role
        ]);
    }
    const token = signToken({ id: member, username: member, role: 'user', organization_id: legacy ? undefined : org });
    return { prefix, org, member, initiator, approver, token, name: `${prefix}-new-node` };
  }

  async function authorizeShred(f) {
    await governance.getOrCreateOrgDEK(f.org);
    return governance.requestDestruction({
      targetType: 'organization',
      targetId: f.org,
      initiatorUserId: f.initiator
    });
  }

  function enroll(endpoint, f) {
    return request(app)
      .post(endpoint)
      .set('Authorization', `Bearer ${f.token}`)
      .send({ name: f.name, role: 'CLIENT_ORIGIN' })
      .then((res) => res);
  }

  async function nodeCount(f) {
    return (await pool.query('SELECT id FROM nodes WHERE name=$1', [f.name])).rowCount;
  }

  // Pause only scheduling before the real INSERT. Both autocommit pool queries
  // and an explicitly checked-out transaction client keep their real SQL results.
  // Nothing in the route, middleware, shred, or authority checks is stubbed.
  function pauseInsert(f) {
    const originalPoolQuery = pool.query;
    const originalConnect = pool.connect;
    const clients = new Map();
    const entered = deferred();
    const released = deferred();
    let paused = false;
    function wrapQuery(owner, original) {
      return function (...args) {
        const sql = typeof args[0] === 'string' ? args[0] : args[0]?.text;
        const values = Array.isArray(args[1]) ? args[1] : args[0]?.values;
        if (!paused && /INSERT\s+INTO\s+nodes\b/i.test(sql || '') && values?.includes(f.name)) {
          paused = true;
          entered.resolve();
          return released.promise.then(() => original.apply(owner, args));
        }
        return original.apply(owner, args);
      };
    }
    pool.query = wrapQuery(pool, originalPoolQuery);
    pool.connect = function (...args) {
      // pg.Pool.query uses the callback form internally. Its query is already
      // intercepted above; promise clients are intercepted below.
      if (typeof args.at(-1) === 'function') return originalConnect.apply(this, args);
      return originalConnect.apply(this, args).then((client) => {
        if (!clients.has(client)) {
          clients.set(client, client.query);
          client.query = wrapQuery(client, client.query);
        }
        return client;
      });
    };
    return {
      entered: entered.promise,
      release: released.resolve,
      restore() {
        released.resolve();
        pool.query = originalPoolQuery;
        pool.connect = originalConnect;
        for (const [client, original] of clients) client.query = original;
      }
    };
  }

  async function waitForInsert(pause, registration) {
    await Promise.race([
      pause.entered,
      registration.then((res) => {
        throw new Error(`Enrollment completed before the INSERT gate: HTTP ${res.status}`);
      })
    ]);
  }

  async function firstCompletionOrLock(operation, operationPid) {
    let completed = false;
    let error;
    operation.then(
      () => {
        completed = true;
      },
      (err) => {
        error = err;
        completed = true;
      }
    );
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (completed) {
        if (error) throw error;
        return 'authority change committed before INSERT resumed';
      }
      const blocked = await pool.query(
        `SELECT pid, pg_blocking_pids(pid) AS blockers, query FROM pg_stat_activity
         WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock'
           AND ($1::int IS NULL OR pid=$1)
           AND query ~ '(pg_advisory_xact_lock|organizations|memberships|users)'`,
        [operationPid || null]
      );
      if (blocked.rowCount && blocked.rows.some((row) => row.blockers.length)) {
        return 'authority change waited for enrollment to commit';
      }
      await delay(10);
    }
    throw new Error('Neither authority commit nor a PostgreSQL serialization wait was observed');
  }

  for (const [endpoint, successStatus] of [
    ['/api/nodes', 201],
    ['/api/configs/generate', 200]
  ]) {
    it(`${endpoint} creates a node for an active member`, async () => {
      const f = await fixture();
      const res = await enroll(endpoint, f);
      assert.equal(res.status, successStatus, JSON.stringify(res.body));
      assert.equal(await nodeCount(f), 1);
      assert.equal(
        (await pool.query('SELECT organization_id FROM nodes WHERE name=$1', [f.name])).rows[0].organization_id,
        f.org
      );
    });

    it(`${endpoint} preserves legacy org-default enrollment without a membership row`, async () => {
      const f = await fixture({ legacy: true });
      const res = await enroll(endpoint, f);
      assert.equal(res.status, successStatus, JSON.stringify(res.body));
      assert.equal(
        (await pool.query('SELECT organization_id FROM nodes WHERE name=$1', [f.name])).rows[0].organization_id,
        'org-default'
      );
    });

    it(`${endpoint} refuses a JWT issued before its tenant was shredded`, async (t) => {
      const f = await fixture();
      const authorization = await authorizeShred(f);
      assert.equal((await governance.approveAndExecuteDestruction(authorization.id, f.approver)).success, true);
      assert.equal((await pool.query('SELECT status FROM users WHERE id=$1', [f.member])).rows[0].status, 'revoked');
      assert.ok((await pool.query('SELECT destroyed_at FROM organizations WHERE id=$1', [f.org])).rows[0].destroyed_at);
      const res = await enroll(endpoint, f);
      const count = await nodeCount(f);
      t.diagnostic(JSON.stringify({ endpoint, registration_status: res.status, surviving_nodes: count }));
      assert.ok(res.status >= 400 && res.status < 500, `a pre-shred JWT still created a node: HTTP ${res.status}`);
      assert.equal(count, 0, 'a destroyed organization acquired a new node');
    });

    for (const authority of ['account revocation', 'membership demotion', 'organization transfer']) {
      it(`${endpoint} refuses a JWT after a completed ${authority} in an active organization`, async (t) => {
        const f = await fixture();
        if (authority === 'account revocation')
          await pool.query("UPDATE users SET status='revoked' WHERE id=$1", [f.member]);
        else if (authority === 'membership demotion')
          await pool.query("UPDATE memberships SET role='auditor' WHERE user_id=$1 AND organization_id=$2", [
            f.member,
            f.org
          ]);
        else {
          const nextOrg = `${f.prefix}-destination`;
          await pool.query('INSERT INTO organizations (id,name,slug) VALUES ($1,$1,$1)', [nextOrg]);
          await pool.query('UPDATE users SET organization_id=$1 WHERE id=$2', [nextOrg, f.member]);
        }
        assert.equal(
          (await pool.query('SELECT destroyed_at FROM organizations WHERE id=$1', [f.org])).rows[0].destroyed_at,
          null
        );
        const res = await enroll(endpoint, f);
        const count = await nodeCount(f);
        t.diagnostic(JSON.stringify({ endpoint, authority, registration_status: res.status, surviving_nodes: count }));
        assert.ok(res.status >= 400 && res.status < 500, `a stale JWT authorized ${authority}: HTTP ${res.status}`);
        assert.equal(count, 0, 'a request without current authority created a node');
      });
    }

    it(`${endpoint} refuses a still-active super-admin creating a node in a destroyed organization`, async (t) => {
      const f = await fixture();
      await pool.query("UPDATE users SET role='super-admin' WHERE id=$1", [f.member]);
      f.token = signToken({ id: f.member, username: f.member, role: 'super-admin', organization_id: f.org });
      const authorization = await authorizeShred(f);
      assert.equal((await governance.approveAndExecuteDestruction(authorization.id, f.approver)).success, true);
      assert.equal((await pool.query('SELECT status FROM users WHERE id=$1', [f.member])).rows[0].status, 'active');
      assert.ok((await pool.query('SELECT destroyed_at FROM organizations WHERE id=$1', [f.org])).rows[0].destroyed_at);
      const res = await enroll(endpoint, f);
      const count = await nodeCount(f);
      t.diagnostic(
        JSON.stringify({ endpoint, account_status: 'active', registration_status: res.status, surviving_nodes: count })
      );
      assert.ok(
        res.status >= 400 && res.status < 500,
        `a super-admin recreated a node in a destroyed organization: HTTP ${res.status}`
      );
      assert.equal(count, 0);
    });

    it(`${endpoint} leaves no node surviving a shred concurrent with its INSERT`, async (t) => {
      const f = await fixture();
      const authorization = await authorizeShred(f);
      const pause = pauseInsert(f);
      const registration = enroll(endpoint, f);
      let destruction;
      try {
        await waitForInsert(pause, registration);
        destruction = governance.approveAndExecuteDestruction(authorization.id, f.approver);
        const order = await firstCompletionOrLock(destruction);
        pause.release();
        const [res, shredded] = await Promise.all([registration, destruction]);
        assert.equal(shredded.success, true);
        const count = await nodeCount(f);
        t.diagnostic(JSON.stringify({ endpoint, order, registration_status: res.status, surviving_nodes: count }));
        assert.ok(res.status === successStatus || (res.status >= 400 && res.status < 500), JSON.stringify(res.body));
        assert.equal(count, 0, 'the in-flight console enrollment resurrected a node after the committed shred');
      } finally {
        pause.release();
        await Promise.allSettled([registration, destruction]);
        pause.restore();
      }
    });

    it(`${endpoint} serializes an auditor insertion into a missing-membership legacy account`, async (t) => {
      const f = await fixture({ legacy: true });
      assert.equal(
        (await pool.query('SELECT id FROM memberships WHERE user_id=$1 AND organization_id=$2', [f.member, f.org]))
          .rowCount,
        0
      );
      const competitor = await pool.connect();
      const competitorPid = (await competitor.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const pause = pauseInsert(f);
      const registration = enroll(endpoint, f);
      let change;
      try {
        await waitForInsert(pause, registration);
        change = competitor.query(
          "INSERT INTO memberships (id,user_id,organization_id,role) VALUES ($1,$2,$3,'auditor')",
          [`mem-${f.member}`, f.member, f.org]
        );
        const order = await firstCompletionOrLock(change, competitorPid);
        pause.release();
        const [res] = await Promise.all([registration, change]);
        const count = await nodeCount(f);
        assert.equal(
          (await pool.query('SELECT role FROM memberships WHERE user_id=$1 AND organization_id=$2', [f.member, f.org]))
            .rows[0].role,
          'auditor'
        );
        t.diagnostic(
          JSON.stringify({
            endpoint,
            authority: 'new auditor membership',
            order,
            registration_status: res.status,
            surviving_nodes: count
          })
        );
        if (order === 'authority change committed before INSERT resumed') {
          assert.ok(
            res.status >= 400 && res.status < 500,
            `a newly restricted auditor still created a node: HTTP ${res.status}`
          );
          assert.equal(count, 0, 'creation ignored the auditor membership inserted before its node');
        } else {
          assert.equal(res.status, successStatus, JSON.stringify(res.body));
          assert.equal(count, 1, 'enrollment must commit before its previously absent membership can become read-only');
        }
      } finally {
        pause.release();
        await Promise.allSettled([registration, change]);
        pause.restore();
        competitor.release();
      }
    });

    for (const authority of ['membership demotion', 'account revocation', 'organization transfer']) {
      it(`${endpoint} serializes its INSERT with a concurrent ${authority}`, async (t) => {
        const f = await fixture();
        const nextOrg = `${f.prefix}-destination`;
        if (authority === 'organization transfer')
          await pool.query('INSERT INTO organizations (id,name,slug) VALUES ($1,$1,$1)', [nextOrg]);
        const competitor = await pool.connect();
        const competitorPid = (await competitor.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        const pause = pauseInsert(f);
        const registration = enroll(endpoint, f);
        let change;
        try {
          await waitForInsert(pause, registration);
          if (authority === 'membership demotion')
            change = competitor.query("UPDATE memberships SET role='auditor' WHERE user_id=$1 AND organization_id=$2", [
              f.member,
              f.org
            ]);
          else if (authority === 'account revocation')
            change = competitor.query("UPDATE users SET status='revoked' WHERE id=$1", [f.member]);
          else change = competitor.query('UPDATE users SET organization_id=$1 WHERE id=$2', [nextOrg, f.member]);
          const order = await firstCompletionOrLock(change, competitorPid);
          pause.release();
          const [res] = await Promise.all([registration, change]);
          const count = await nodeCount(f);
          t.diagnostic(
            JSON.stringify({ endpoint, authority, order, registration_status: res.status, surviving_nodes: count })
          );
          if (order === 'authority change committed before INSERT resumed') {
            assert.ok(res.status >= 400 && res.status < 500, `stale ${authority} authorized HTTP ${res.status}`);
            assert.equal(count, 0, 'a node was created after its current authority was removed');
          } else {
            assert.equal(res.status, successStatus, JSON.stringify(res.body));
            assert.equal(count, 1, 'an enrollment that held current authority failed to commit before its revocation');
          }
        } finally {
          pause.release();
          await Promise.allSettled([registration, change]);
          pause.restore();
          competitor.release();
        }
      });
    }
  }
});
