// ==============================================================================
// NeroNet Sovereign Mesh - High Availability & Distributed Leadership Tests (WP-307)
// Verifies ADR 0001: PostgreSQL Advisory Lock Leader Election for N Control Planes
// ==============================================================================

const { test, describe, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const config = require('../config/env');
const { setupTestDatabase } = require('./helpers/db');
const {
  DistributedLeaderService,
  LOCK_CLASS_ID,
  LOCK_OBJ_ID
} = require('../services/DistributedLeaderService');
const { createApp } = require('../server');

describe('WP-307: High Availability & Distributed Leadership (ADR 0001)', () => {
  let dbSetup;
  let pool;
  let app;
  let adminToken;
  const activeInstances = [];

  before(async () => {
    dbSetup = await setupTestDatabase();
    pool = dbSetup.pool;
    app = createApp();

    // Create super-admin user and token for API tests
    await pool.query(
      `INSERT INTO users (id, username, email, password_hash, role)
       VALUES ('ha-admin-uuid', 'ha_admin', 'ha_admin@neronet.internal', 'hash', 'super-admin')
       ON CONFLICT (id) DO NOTHING`
    );

    adminToken = jwt.sign(
      { id: 'ha-admin-uuid', username: 'ha_admin', role: 'super-admin' },
      config.JWT_SECRET,
      { expiresIn: '1h' }
    );
  });

  afterEach(async () => {
    // Ensure all instances started in a test are properly stopped
    while (activeInstances.length > 0) {
      const inst = activeInstances.pop();
      try {
        await inst.stop();
      } catch (_) {}
    }
  });

  after(async () => {
    try {
      await pool.query('SELECT pg_advisory_unlock_all()');
    } catch (_) {}
    if (dbSetup?.cleanup) {
      await dbSetup.cleanup();
    }
  });

  function createTrackedInstance(instanceId) {
    const inst = new DistributedLeaderService({ pool, instanceId });
    activeInstances.push(inst);
    return inst;
  }

  test('1. Single instance successfully acquires leadership when lock is available', async () => {
    const leader1 = createTrackedInstance('node-alpha');

    assert.equal(leader1.isLeader, false);
    await leader1.start({ heartbeatIntervalMs: 200 });

    assert.equal(leader1.isLeader, true);
    assert.equal(leader1.getInstanceId(), 'node-alpha');

    const status = leader1.getStatus();
    assert.equal(status.isLeader, true);
    assert.equal(status.instanceId, 'node-alpha');
    assert.ok(status.leadershipAcquiredAt);

    await leader1.stop();
    assert.equal(leader1.isLeader, false);
  });

  test('2. Competing instances: exactly ONE acquires leadership, standby does not', async () => {
    const instanceA = createTrackedInstance('cp-node-A');
    const instanceB = createTrackedInstance('cp-node-B');

    await instanceA.start({ heartbeatIntervalMs: 100 });
    await instanceB.start({ heartbeatIntervalMs: 100 });

    assert.equal(instanceA.isLeader, true, 'Instance A should be the elected leader');
    assert.equal(instanceB.isLeader, false, 'Instance B must remain in standby mode');

    await instanceA.stop();
    await instanceB.stop();
  });

  test('3. Single execution guarantee: only leader executes periodic scheduled tasks', async () => {
    const leader = createTrackedInstance('leader-worker');
    const standby = createTrackedInstance('standby-worker');

    await leader.start({ heartbeatIntervalMs: 100 });
    await standby.start({ heartbeatIntervalMs: 100 });

    let executionCount = 0;
    const task = async () => {
      executionCount++;
      return 'task-completed';
    };

    // Attempt execution on leader
    const resLeader = await leader.executeAsLeader('heartbeat-flush', task);
    assert.equal(resLeader.executed, true);
    assert.equal(resLeader.result, 'task-completed');
    assert.equal(executionCount, 1);

    // Attempt execution on standby
    const resStandby = await standby.executeAsLeader('heartbeat-flush', task);
    assert.equal(resStandby.executed, false);
    assert.equal(resStandby.reason, 'NOT_LEADER');
    assert.equal(executionCount, 1, 'Standby must NOT execute the task');

    await leader.stop();
    await standby.stop();
  });

  test('4. Automatic failover: when active leader steps down, standby claims leadership', async () => {
    const instance1 = createTrackedInstance('instance-primary');
    const instance2 = createTrackedInstance('instance-standby');

    await instance1.start({ heartbeatIntervalMs: 100 });
    await instance2.start({ heartbeatIntervalMs: 100 });

    assert.equal(instance1.isLeader, true);
    assert.equal(instance2.isLeader, false);

    // Primary steps down with pause on re-election so standby acquires
    await instance1.stepDown({ pauseReelectionMs: 5000 });
    assert.equal(instance1.isLeader, false);

    // Wait for instance2's next election loop
    await new Promise((resolve) => setTimeout(resolve, 300));

    assert.equal(instance2.isLeader, true, 'Standby must be promoted to leader');

    await instance1.stop();
    await instance2.stop();
  });

  test('5. Fail-closed: handles client connection failure gracefully', async () => {
    const service = createTrackedInstance('unstable-node');
    await service.start({ heartbeatIntervalMs: 100 });

    assert.equal(service.isLeader, true);

    // Simulate unexpected client crash
    service._handleClientFailure();
    assert.equal(service.isLeader, false, 'Must immediately demote on connection drop');

    await service.stop();
  });

  test('6. API: GET /api/stats/ha-leader reports current leadership status to authenticated user', async () => {
    const res = await request(app)
      .get('/api/stats/ha-leader')
      .set('Authorization', `Bearer ${adminToken}`);

    assert.equal(res.status, 200);
    assert.ok(res.body.leader);
    assert.ok(typeof res.body.leader.isLeader === 'boolean');
    assert.ok(res.body.leader.instanceId);
  });
});
