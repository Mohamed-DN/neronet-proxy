const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { setupTestDatabase } = require('./helpers/db');
const { DistributedLeaderService, LOCK_CLASS_ID, LOCK_OBJ_ID } = require('../services/DistributedLeaderService');

describe('Distributed leader shutdown with PostgreSQL operations in flight', () => {
  let database;
  let gateId = 186900;

  before(async () => {
    database = await setupTestDatabase();
  });

  after(async () => {
    await database?.cleanup();
  });

  function createLeader(instanceId, gate = null) {
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 1,
      connectionTimeoutMillis: 5000
    });
    const operations = { connections: 0, releases: 0, discards: 0, pid: null, client: null };
    const connect = pool.connect.bind(pool);
    pool.connect = async () => {
      const client = await connect();
      operations.connections++;
      operations.pid = client.processID;
      operations.client = client;
      const query = client.query;
      const release = client.release;
      client.query = (text, values) => {
        if (gate && text === gate.query) {
          // The server, rather than a mocked promise, holds the actual leader
          // query in flight until this test releases a separate advisory lock.
          return query.call(
            client,
            `${text} FROM (SELECT pg_advisory_xact_lock($${(values?.length || 0) + 1})) AS gate`,
            [...(values || []), gate.id]
          );
        }
        return query.call(client, text, values);
      };
      client.release = (discard) => {
        operations.releases++;
        if (discard) operations.discards++;
        client.query = query;
        release(discard);
      };
      return client;
    };
    return { pool, leader: new DistributedLeaderService({ pool, instanceId }), operations };
  }

  async function createGate(query) {
    const blocker = await database.pool.connect();
    const id = ++gateId;
    await blocker.query('SELECT pg_advisory_lock($1)', [id]);
    let open = false;
    return {
      id,
      query,
      async open() {
        if (open) return;
        open = true;
        await blocker.query('SELECT pg_advisory_unlock($1)', [id]);
        blocker.release();
      }
    };
  }

  async function waitFor(check, message) {
    const deadline = Date.now() + 5000;
    while (!(await check())) {
      assert.ok(Date.now() < deadline, message);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  async function waitForBlocked(operations) {
    await waitFor(async () => {
      const res = await database.pool.query(
        `SELECT 1 FROM pg_stat_activity WHERE pid = $1
         AND wait_event_type = 'Lock' AND wait_event = 'advisory'`,
        [operations.pid]
      );
      return res.rowCount === 1;
    }, 'the real PostgreSQL leader query never blocked on the test gate');
  }

  async function assertStopped(leader, pool, pid) {
    const locks = await database.pool.query(
      `SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND pid = $1
       AND classid = $2 AND objid = $3 AND granted`,
      [pid, LOCK_CLASS_ID, LOCK_OBJ_ID]
    );
    assert.equal(locks.rowCount, 0, 'the stopped service retained its PostgreSQL advisory lock');
    assert.equal(leader.isLeader, false);
    assert.equal(leader._running, false);
    assert.equal(leader._client, null);
    assert.equal(leader._timer, null, 'a completed start installed a timer after stop');
    assert.equal(pool.idleCount, pool.totalCount, 'the stopped service retained a checked-out client');
  }

  it('drains an election waiting for the only pooled connection before stop resolves', async () => {
    const { pool, leader } = createLeader('queued-connection-stop');
    let blocker = await pool.connect();
    const pid = blocker.processID;
    let starting;
    let stopping;
    let stopped = false;
    let promotions = 0;
    leader.on('promoted', () => promotions++);
    try {
      starting = leader.start({ heartbeatIntervalMs: 20 });
      assert.equal(pool.waitingCount, 1, 'the real PostgreSQL pool must be saturated');
      stopping = leader.stop().then(() => {
        stopped = true;
      });
      await new Promise((resolve) => setImmediate(resolve));
      const stoppedWhileQueued = stopped;
      blocker.release();
      blocker = null;
      await Promise.all([starting, stopping]);

      await assertStopped(leader, pool, pid);
      assert.equal(stoppedWhileQueued, false, 'stop resolved before the queued election drained');
      assert.equal(promotions, 0, 'the cancelled election published leadership');
    } finally {
      if (blocker) blocker.release();
      await starting;
      await stopping;
      await leader.stop();
      await pool.end();
    }
  });

  it('drains a lock query and unlocks its result without publishing leadership', async () => {
    const gate = await createGate('SELECT pg_try_advisory_lock($1, $2) AS acquired');
    const { pool, leader, operations } = createLeader('blocked-lock-stop', gate);
    let starting;
    let stopping;
    let stopped = false;
    let promotions = 0;
    leader.on('promoted', () => promotions++);
    try {
      starting = leader.start({ heartbeatIntervalMs: 10 });
      await waitForBlocked(operations);
      stopping = leader.stop().then(() => {
        stopped = true;
      });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(stopped, false, 'stop resolved with a real lock query still blocked');
      await gate.open();
      await Promise.all([starting, stopping]);
      await assertStopped(leader, pool, operations.pid);
      assert.equal(promotions, 0);
      assert.equal(operations.releases, 1, 'the acquired client must be released exactly once');
      assert.equal(operations.discards, 0);
    } finally {
      await gate.open();
      await Promise.allSettled([starting, stopping]);
      await leader.stop();
      await pool.end();
    }
  });

  it('coalesces concurrent starts and election cycles on one PostgreSQL session', async () => {
    const gate = await createGate('SELECT pg_try_advisory_lock($1, $2) AS acquired');
    const { pool, leader, operations } = createLeader('concurrent-starts', gate);
    const pending = [];
    let startsCompleted = 0;
    let promotions = 0;
    leader.on('promoted', () => promotions++);
    try {
      pending.push(leader.start({ heartbeatIntervalMs: 10000 }));
      await waitForBlocked(operations);
      for (let i = 0; i < 4; i++) {
        pending.push(
          leader.start().then(() => {
            startsCompleted++;
          })
        );
        pending.push(leader._electionCycle());
      }
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(startsCompleted, 0, 'a concurrent start resolved before election initialization');
      assert.equal(pool.waitingCount, 0, 'overlapping cycles queued extra clients');
      assert.equal(operations.connections, 1);
      await gate.open();
      await Promise.all(pending);
      assert.equal(leader.isLeader, true);
      assert.equal(promotions, 1);
      await leader.stop();
      await assertStopped(leader, pool, operations.pid);
      assert.equal(operations.releases, 1);
    } finally {
      await gate.open();
      await Promise.allSettled(pending);
      await leader.stop();
      await pool.end();
    }
  });

  it('drains an in-flight heartbeat without emitting a late heartbeat or releasing twice', async () => {
    const gate = await createGate('SELECT 1 as alive');
    const { pool, leader, operations } = createLeader('blocked-heartbeat-stop', gate);
    const pending = [];
    let heartbeats = 0;
    let demotions = 0;
    leader.on('heartbeat', () => heartbeats++);
    leader.on('demoted', () => demotions++);
    try {
      await leader.start({ heartbeatIntervalMs: 10000 });
      pending.push(leader._electionCycle());
      await waitForBlocked(operations);
      pending.push(leader.stop(), leader.stop(), leader.stepDown());
      assert.equal(leader.isLeader, false);
      assert.equal(operations.releases, 0, 'the client was returned while its heartbeat was still running');
      await gate.open();
      await Promise.all(pending);
      await assertStopped(leader, pool, operations.pid);
      assert.equal(heartbeats, 0);
      assert.equal(demotions, 1);
      assert.equal(operations.releases, 1);
    } finally {
      await gate.open();
      await Promise.allSettled(pending);
      await leader.stop();
      await pool.end();
    }
  });

  it('waits for concurrent shutdowns before starting one fresh election', async () => {
    const gate = await createGate('SELECT pg_advisory_unlock($1, $2)');
    const { pool, leader, operations } = createLeader('restart-during-stop', gate);
    const pending = [];
    let promotions = 0;
    let demotions = 0;
    leader.on('promoted', () => promotions++);
    leader.on('demoted', () => demotions++);
    try {
      await leader.start({ heartbeatIntervalMs: 10000 });
      pending.push(leader.stop(), leader.stop());
      await waitForBlocked(operations);
      pending.push(leader.start({ heartbeatIntervalMs: 10000 }), leader.start());
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(operations.connections, 1, 'restart borrowed a session before shutdown drained');
      assert.equal(operations.releases, 0);
      await gate.open();
      await Promise.all(pending);
      assert.equal(leader.isLeader, true);
      assert.equal(promotions, 2);
      assert.equal(demotions, 1);
      assert.equal(operations.connections, 2);
      assert.equal(operations.releases, 1);
      assert.ok(leader._timer);
      await leader.stop();
      await assertStopped(leader, pool, operations.pid);
      assert.equal(operations.releases, 2);
    } finally {
      await gate.open();
      await Promise.allSettled(pending);
      await leader.stop();
      await pool.end();
    }
  });

  it('cancels a restart queued behind shutdown when a later stop arrives', async () => {
    const gate = await createGate('SELECT pg_advisory_unlock($1, $2)');
    const { pool, leader, operations } = createLeader('cancel-queued-restart', gate);
    const pending = [];
    let promotions = 0;
    leader.on('promoted', () => promotions++);
    try {
      await leader.start({ heartbeatIntervalMs: 10000 });
      pending.push(leader.stop());
      await waitForBlocked(operations);
      pending.push(leader.start(), leader.stop(), leader.stop());
      await gate.open();
      await Promise.all(pending);
      await assertStopped(leader, pool, operations.pid);
      assert.equal(promotions, 1, 'the cancelled restart published new leadership');
      assert.equal(operations.connections, 1);
      assert.equal(operations.releases, 1);
    } finally {
      await gate.open();
      await Promise.allSettled(pending);
      await leader.stop();
      await pool.end();
    }
  });

  it('invalidates a pending acquisition on stepDown and keeps the election loop available', async () => {
    const gate = await createGate('SELECT pg_try_advisory_lock($1, $2) AS acquired');
    const { pool, leader, operations } = createLeader('stepdown-during-start', gate);
    const pending = [];
    let promotions = 0;
    leader.on('promoted', () => promotions++);
    try {
      pending.push(leader.start({ heartbeatIntervalMs: 10000 }));
      await waitForBlocked(operations);
      pending.push(leader.stepDown());
      await gate.open();
      await Promise.all(pending);
      assert.equal(leader.isLeader, false);
      assert.equal(promotions, 0);
      assert.ok(leader._timer, 'stepDown during startup lost the background loop');
      await leader._electionCycle();
      assert.equal(leader.isLeader, true);
      await leader.stop();
      await assertStopped(leader, pool, operations.pid);
      assert.equal(operations.releases, 2);
    } finally {
      await gate.open();
      await Promise.allSettled(pending);
      await leader.stop();
      await pool.end();
    }
  });

  it('discards a session when PostgreSQL terminates it during advisory unlock', async () => {
    const gate = await createGate('SELECT pg_advisory_unlock($1, $2)');
    const { pool, leader, operations } = createLeader('failed-unlock', gate);
    let stopping;
    try {
      await leader.start({ heartbeatIntervalMs: 10000 });
      stopping = leader.stop();
      await waitForBlocked(operations);
      const terminated = await database.pool.query('SELECT pg_terminate_backend($1) AS terminated', [operations.pid]);
      assert.equal(terminated.rows[0].terminated, true);
      await stopping;
      await waitFor(async () => {
        const res = await database.pool.query('SELECT 1 FROM pg_stat_activity WHERE pid = $1', [operations.pid]);
        return res.rowCount === 0;
      }, 'the terminated leader session did not leave PostgreSQL');
      await assertStopped(leader, pool, operations.pid);
      assert.equal(pool.totalCount, 0, 'a failed unlock returned a broken session to the idle pool');
      assert.equal(operations.discards, 1);
      assert.equal(operations.releases, 1);
    } finally {
      await gate.open();
      await stopping;
      await leader.stop();
      await pool.end();
    }
  });

  it('removes lease error listeners when standby cycles return a reusable client', async () => {
    const holder = await database.pool.connect();
    const { pool, leader, operations } = createLeader('standby-listeners');
    try {
      await holder.query('SELECT pg_advisory_lock($1, $2)', [LOCK_CLASS_ID, LOCK_OBJ_ID]);
      await leader.start({ heartbeatIntervalMs: 10000 });
      for (let i = 0; i < 15; i++) {
        await leader._electionCycle();
        assert.equal(leader.isLeader, false);
        assert.equal(operations.client.listenerCount('error'), 1, 'released clients accumulated leader listeners');
      }
      await leader.stop();
      await assertStopped(leader, pool, operations.pid);
      assert.equal(operations.connections, operations.releases);
    } finally {
      await holder.query('SELECT pg_advisory_unlock($1, $2)', [LOCK_CLASS_ID, LOCK_OBJ_ID]);
      holder.release();
      await leader.stop();
      await pool.end();
    }
  });

  it('drains client termination outside an election cycle before stop resolves', async () => {
    const { pool, leader, operations } = createLeader('failure-between-cycles');
    let finishEnd;
    const endCompletion = new Promise((resolve) => {
      finishEnd = resolve;
    });
    let stopping;
    let end;
    let stopped = false;
    let physicallyClosed = false;
    let closing;
    try {
      await leader.start({ heartbeatIntervalMs: 10000 });
      const client = operations.client;
      end = client.end.bind(client);
      client.end = (callback) => {
        if (!closing) {
          // Close the real socket, then hold completion to expose whether stop
          // drains the client's end operation or only drops its own reference.
          closing = end().then(async () => {
            physicallyClosed = true;
            await endCompletion;
          });
        }
        if (callback) {
          closing.then(callback);
          return;
        }
        return closing;
      };

      await database.pool.query('SELECT pg_terminate_backend($1)', [operations.pid]);
      await waitFor(() => Boolean(closing), 'the terminated client never started closing');
      stopping = leader.stop().then(() => {
        stopped = true;
      });
      await waitFor(async () => {
        const res = await database.pool.query('SELECT 1 FROM pg_stat_activity WHERE pid = $1', [operations.pid]);
        return physicallyClosed && res.rowCount === 0;
      }, 'the real socket and PostgreSQL session did not close');
      const stoppedBeforeEndCompleted = stopped;
      finishEnd();
      await stopping;

      assert.equal(stoppedBeforeEndCompleted, false, 'stop resolved before the client end operation completed');
      await assertStopped(leader, pool, operations.pid);
      assert.equal(operations.releases, 1);
      assert.equal(operations.discards, 1);
      assert.equal(pool.totalCount, 0);
    } finally {
      finishEnd();
      if (end) operations.client.end = end;
      await closing;
      await stopping;
      await leader.stop();
      await pool.end();
    }
  });
});
