const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { setupTestDatabase } = require('./helpers/db');
const { CryptoShreddingService: service } = require('../services/CryptoShreddingService');
const NodeCredentialService = require('../services/NodeCredentialService');
const AclEngine = require('../services/AclEngine');

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// Only scheduling is intercepted: every accepted execution still runs the real
// shred against PostgreSQL. A rejected competing operation must never reach it.
function pauseExecution(method) {
  const original = service[method];
  const entered = deferred();
  const repeated = deferred();
  const released = deferred();
  let calls = 0;
  service[method] = async function (...args) {
    calls += 1;
    (calls === 1 ? entered : repeated).resolve();
    await released.promise;
    return original.apply(this, args);
  };
  return {
    entered: entered.promise,
    repeated: repeated.promise,
    release: released.resolve,
    get calls() {
      return calls;
    },
    restore() {
      released.resolve();
      service[method] = original;
    }
  };
}

describe('Destruction governance serializes competing database operations', { timeout: 30000 }, () => {
  let db;
  let pool;
  let sequence = 0;

  before(async () => {
    db = await setupTestDatabase();
    pool = db.pool;
    assert.match(db.dbName, /^neronet_t_/);
    assert.equal((await pool.query('SELECT current_database() AS name')).rows[0].name, db.dbName);
  });
  after(async () => {
    if (db) await db.cleanup();
  });

  async function fixture({ platform = false, global = false } = {}) {
    await pool.query('UPDATE organization_legal_holds SET active = FALSE');
    const prefix = `race-${++sequence}`;
    const org = `${prefix}-org`;
    const initiator = `${prefix}-initiator`;
    const approver = `${prefix}-approver`;
    await pool.query('INSERT INTO organizations (id, name, slug) VALUES ($1,$1,$1)', [org]);
    for (const [id, role] of [
      [initiator, 'owner'],
      [approver, 'admin']
    ]) {
      await pool.query(
        "INSERT INTO users (id,username,email,password_hash,role,organization_id) VALUES ($1,$1,$2,'fixture',$3,$4)",
        [id, `${id}@test.invalid`, platform ? 'super-admin' : 'user', org]
      );
      if (!platform)
        await pool.query('INSERT INTO memberships (id,user_id,organization_id,role) VALUES ($1,$2,$3,$4)', [
          `mem-${id}`,
          id,
          org,
          role
        ]);
    }
    const node = `${prefix}-node`;
    const key = crypto.generateKeyPairSync('x25519').publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
    await pool.query(
      'INSERT INTO nodes (id,user_id,name,public_key,overlay_ipv4,overlay_ipv6,organization_id) VALUES ($1,$2,$1,$3,$4,$5,$6)',
      [node, initiator, key.toString('base64'), `100.97.0.${sequence}`, `fd97::${sequence}`, org]
    );
    await service.getOrCreateOrgDEK(org);
    const credential = await NodeCredentialService.mintCredential(node);
    const authorization = await service.requestDestruction({
      targetType: global ? 'global' : 'organization',
      targetId: global ? 'global' : org,
      initiatorUserId: initiator
    });
    return { org, initiator, approver, node, credential, authorization, keyHex: key.toString('hex') };
  }

  async function waitForGovernanceLock() {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const result = await pool.query(
        `SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()
          AND wait_event_type='Lock'
          AND query ~ '(organizations|nuke_authorizations|memberships|users|pg_advisory_xact_lock)'`
      );
      if (result.rowCount) return 'blocked';
      await delay(10);
    }
    throw new Error('Competing governance operation never waited on a database lock');
  }

  async function assertIntact(f) {
    assert.equal(
      (await pool.query('SELECT status FROM organization_keys WHERE organization_id=$1', [f.org])).rows[0].status,
      'active'
    );
    assert.equal((await pool.query('SELECT id FROM nodes WHERE id=$1', [f.node])).rowCount, 1);
    assert.equal(
      (await pool.query('SELECT destroyed_at FROM organizations WHERE id=$1', [f.org])).rows[0].destroyed_at,
      null
    );
    assert.equal(
      (await pool.query('SELECT revoked_at FROM node_credentials WHERE id=$1', [f.credential.credentialId])).rows[0]
        .revoked_at,
      null
    );
    assert.equal((await pool.query('SELECT 1 FROM revoked_keys WHERE public_key_hex=$1', [f.keyHex])).rowCount, 0);
    assert.equal(
      (await pool.query('SELECT status FROM nuke_authorizations WHERE id=$1', [f.authorization.id])).rows[0].status,
      'pending'
    );
  }

  for (const global of [false, true]) {
    it(`executes a ${global ? 'global' : 'tenant'} authorization once when two approvals overlap`, async () => {
      const f = await fixture({ platform: global, global });
      const pause = pauseExecution(global ? 'executeGlobalShred' : 'executeOrgShred');
      const first = service.approveAndExecuteDestruction(f.authorization.id, f.approver);
      let second;
      try {
        await pause.entered;
        second = service.approveAndExecuteDestruction(f.authorization.id, f.approver);
        second.catch(() => {});
        assert.equal(
          await Promise.race([pause.repeated.then(() => 'executed twice'), waitForGovernanceLock()]),
          'blocked'
        );
        pause.release();
        assert.equal((await first).success, true);
        await assert.rejects(second);
        assert.equal(pause.calls, 1);
        assert.equal(
          (await pool.query('SELECT status FROM nuke_authorizations WHERE id=$1', [f.authorization.id])).rows[0].status,
          'executed'
        );
      } finally {
        pause.restore();
        await Promise.allSettled([first, second]);
      }
    });
  }

  it('serializes rejection behind an approval that already owns the target', async () => {
    const f = await fixture({ platform: true });
    const pause = pauseExecution('executeOrgShred');
    const approval = service.approveAndExecuteDestruction(f.authorization.id, f.approver);
    let rejection;
    try {
      await pause.entered;
      rejection = service.rejectDestruction(f.authorization.id, f.initiator);
      assert.equal(
        await Promise.race([rejection.then(() => 'rejected during execution'), waitForGovernanceLock()]),
        'blocked'
      );
      pause.release();
      assert.equal((await approval).success, true);
      assert.equal(await rejection, null);
      assert.equal(
        (await pool.query('SELECT status FROM nuke_authorizations WHERE id=$1', [f.authorization.id])).rows[0].status,
        'executed'
      );
    } finally {
      pause.restore();
      await Promise.allSettled([approval, rejection]);
    }
  });

  for (const global of [false, true]) {
    it(`orders a new legal hold after a ${global ? 'global' : 'tenant'} execution already in progress`, async () => {
      const f = await fixture({ platform: true, global });
      const pause = pauseExecution(global ? 'executeGlobalShred' : 'executeOrgShred');
      const approval = service.approveAndExecuteDestruction(f.authorization.id, f.approver);
      let hold;
      try {
        await pause.entered;
        hold = service.imposeLegalHold(f.org, 'Concurrent preservation order', f.initiator);
        hold.catch(() => {});
        assert.equal(
          await Promise.race([
            hold.then(
              () => 'hold committed before shred',
              () => 'hold failed before serialization'
            ),
            waitForGovernanceLock()
          ]),
          'blocked'
        );
        pause.release();
        assert.equal((await approval).success, true);
        if (global) assert.equal((await hold).active, true);
        else await assert.rejects(hold, /destroyed|not found/i);
      } finally {
        pause.restore();
        await Promise.allSettled([approval, hold]);
      }
    });
  }

  for (const mutation of ['membership', 'account']) {
    it(`locks current ${mutation} authority until its accepted execution commits`, async () => {
      const f = await fixture();
      const pause = pauseExecution('executeOrgShred');
      const approval = service.approveAndExecuteDestruction(f.authorization.id, f.approver);
      let revocation;
      try {
        await pause.entered;
        revocation = pool.query(
          mutation === 'membership'
            ? 'DELETE FROM memberships WHERE user_id=$1'
            : "UPDATE users SET status='revoked' WHERE id=$1",
          [f.approver]
        );
        assert.equal(
          await Promise.race([revocation.then(() => 'authority changed during execution'), waitForGovernanceLock()]),
          'blocked'
        );
        pause.release();
        assert.equal((await approval).success, true);
        await revocation;
      } finally {
        pause.restore();
        await Promise.allSettled([approval, revocation]);
      }
    });
  }

  for (const global of [false, true]) {
    it(`rolls back the real ${global ? 'global' : 'tenant'} shred and node revocations together when execution fails`, async () => {
      const f = await fixture({ platform: global, global });
      const epochsBefore = (await pool.query('SELECT name, epoch FROM mesh_epochs ORDER BY name')).rows;
      const auditParams = [global ? 'GLOBAL_CRYPTO_SHREDDED' : 'ORG_CRYPTO_SHREDDED', global ? 'global' : f.org];
      const auditBefore = (
        await pool.query('SELECT 1 FROM audit_events WHERE event_type=$1 AND target_id=$2', auditParams)
      ).rowCount;
      const method = global ? 'executeGlobalShred' : 'executeOrgShred';
      const original = service[method];
      service[method] = async function (...args) {
        await original.apply(this, args);
        throw new Error('Injected failure before authorization commit');
      };
      try {
        await assert.rejects(service.approveAndExecuteDestruction(f.authorization.id, f.approver), /Injected failure/);
        await assertIntact(f);
        assert.deepEqual((await pool.query('SELECT name, epoch FROM mesh_epochs ORDER BY name')).rows, epochsBefore);
        assert.equal(
          (await pool.query('SELECT 1 FROM audit_events WHERE event_type=$1 AND target_id=$2', auditParams)).rowCount,
          auditBefore
        );
      } finally {
        service[method] = original;
      }
    });
  }

  it('publishes no effects to another connection or notifier before authorization commit', async () => {
    const f = await fixture();
    const originalShred = service.executeOrgShred;
    const originalNotify = AclEngine.bumpNetmap;
    const entered = deferred();
    const released = deferred();
    let notifications = 0;
    AclEngine.bumpNetmap = async (...args) => {
      notifications += 1;
      return originalNotify(...args);
    };
    service.executeOrgShred = async function (...args) {
      const result = await originalShred.apply(this, args);
      entered.resolve();
      await released.promise;
      return result;
    };
    const approval = service.approveAndExecuteDestruction(f.authorization.id, f.approver);
    try {
      await entered.promise;
      await assertIntact(f);
      assert.equal(notifications, 0);
      assert.equal(
        (
          await pool.query("SELECT 1 FROM audit_events WHERE event_type='ORG_CRYPTO_SHREDDED' AND target_id=$1", [
            f.org
          ])
        ).rowCount,
        0
      );
      released.resolve();
      assert.equal((await approval).success, true);
      assert.equal(notifications, 1);
      assert.equal(
        (await pool.query('SELECT status FROM nuke_authorizations WHERE id=$1', [f.authorization.id])).rows[0].status,
        'executed'
      );
    } finally {
      released.resolve();
      await Promise.allSettled([approval]);
      service.executeOrgShred = originalShred;
      AclEngine.bumpNetmap = originalNotify;
    }
  });

  for (const global of [false, true]) {
    it(`honors a hold that wins serialization before a ${global ? 'global' : 'tenant'} approval`, async () => {
      const f = await fixture({ platform: true, global });
      const pause = pauseExecution('authorizeGovernanceTarget');
      const hold = service.imposeLegalHold(f.org, 'Preserve before destruction', f.initiator);
      let approval;
      try {
        await pause.entered;
        approval = service.approveAndExecuteDestruction(f.authorization.id, f.approver);
        approval.catch(() => {});
        assert.equal(
          await Promise.race([
            approval.then(
              () => 'executed',
              () => 'failed before hold committed'
            ),
            waitForGovernanceLock()
          ]),
          'blocked'
        );
        pause.release();
        assert.equal((await hold).active, true);
        await assert.rejects(approval, /legal hold/i);
        await assertIntact(f);
      } finally {
        pause.restore();
        await Promise.allSettled([hold, approval]);
      }
    });
  }

  for (const actor of ['initiator', 'approver']) {
    for (const mutation of ['membership', 'account']) {
      it(`rechecks ${actor} ${mutation} authority after an earlier revocation commits`, async () => {
        const f = await fixture();
        const competitor = await pool.connect();
        let approval;
        try {
          await competitor.query('BEGIN');
          const competingPid = (await competitor.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
          await competitor.query(
            mutation === 'membership'
              ? 'DELETE FROM memberships WHERE user_id=$1'
              : "UPDATE users SET status='revoked' WHERE id=$1",
            [f[actor]]
          );
          approval = service.approveAndExecuteDestruction(f.authorization.id, f.approver);
          approval.catch(() => {});
          assert.equal(
            await Promise.race([
              approval.then(
                () => 'executed',
                () => 'failed before revocation committed'
              ),
              waitForGovernanceLock()
            ]),
            'blocked'
          );
          const waiters = await pool.query('SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))', [
            competingPid
          ]);
          assert.ok(waiters.rowCount > 0, 'approval must be blocked by the independent revocation connection');
          await competitor.query('COMMIT');
          await assert.rejects(approval, /authorized|governance|account/i);
          await assertIntact(f);
        } finally {
          await competitor.query('ROLLBACK');
          competitor.release();
          await Promise.allSettled([approval]);
        }
      });
    }
  }

  it('honors a rejection that owns the request before approval starts', async () => {
    const f = await fixture({ platform: true });
    const pause = pauseExecution('authorizeGovernanceTarget');
    const rejection = service.rejectDestruction(f.authorization.id, f.initiator);
    let approval;
    try {
      await pause.entered;
      approval = service.approveAndExecuteDestruction(f.authorization.id, f.approver);
      approval.catch(() => {});
      assert.equal(
        await Promise.race([
          approval.then(
            () => 'executed',
            () => 'failed before rejection committed'
          ),
          waitForGovernanceLock()
        ]),
        'blocked'
      );
      pause.release();
      assert.equal((await rejection).status, 'rejected');
      await assert.rejects(approval, /not pending/);
      assert.equal(
        (await pool.query('SELECT status FROM organization_keys WHERE organization_id=$1', [f.org])).rows[0].status,
        'active'
      );
    } finally {
      pause.restore();
      await Promise.allSettled([rejection, approval]);
    }
  });

  it('keeps an executed authorization durable when a post-commit notification fails', async () => {
    const f = await fixture();
    const original = AclEngine.bumpNetmap;
    AclEngine.bumpNetmap = async () => {
      throw new Error('Injected notification outage');
    };
    try {
      assert.equal((await service.approveAndExecuteDestruction(f.authorization.id, f.approver)).success, true);
      assert.equal(
        (await pool.query('SELECT status FROM nuke_authorizations WHERE id=$1', [f.authorization.id])).rows[0].status,
        'executed'
      );
      assert.equal((await pool.query('SELECT id FROM nodes WHERE id=$1', [f.node])).rowCount, 0);
    } finally {
      AclEngine.bumpNetmap = original;
    }
  });
});
