const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { setupTestDatabase } = require('./helpers/db');
const ModuleLoader = require('../services/ModuleLoader');
const { DistributedLeaderService, getDistributedLeaderService } = require('../services/DistributedLeaderService');

// A module's periodic job (NeroNuke's dead man's switch and scheduled destruction
// check) must run once for the fleet. The leader election service existed but was
// never started and nothing consulted it, so every control plane instance ran it.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('Scheduled module jobs run on the elected leader only', () => {
  let dbHelper;
  let other;
  let timer;
  let runs = 0;

  before(async () => {
    dbHelper = await setupTestDatabase();
    const core = ModuleLoader.createCoreInterface('leader-test');
    timer = core.scheduler.every(20, async () => {
      runs++;
    });
  });

  after(async () => {
    clearInterval(timer);
    await getDistributedLeaderService().stop();
    if (other) await other.stop();
    if (dbHelper) await dbHelper.cleanup();
  });

  it('does not run where no leader election has started', async () => {
    await sleep(120);
    assert.strictEqual(runs, 0);
  });

  it('does not run on a standby while another instance leads', async () => {
    other = new DistributedLeaderService({ pool: dbHelper.pool, instanceId: 'cp-other' });
    await other.start({ heartbeatIntervalMs: 20 });
    assert.strictEqual(other.isLeader, true);

    const self = getDistributedLeaderService({ pool: dbHelper.pool, instanceId: 'cp-self' });
    await self.start({ heartbeatIntervalMs: 20 });
    assert.strictEqual(self.isLeader, false);

    await sleep(120);
    assert.strictEqual(runs, 0, 'the standby must not run the job');
  });

  it('runs once this instance takes over', async () => {
    await other.stop();
    other = null;

    const self = getDistributedLeaderService();
    const deadline = Date.now() + 2000;
    while (!self.isLeader && Date.now() < deadline) await sleep(10);
    assert.strictEqual(self.isLeader, true);

    await sleep(120);
    assert.ok(runs > 0, 'the leader runs the job');
  });
});
