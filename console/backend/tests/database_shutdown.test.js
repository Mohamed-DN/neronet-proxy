const { it } = require('node:test');
const assert = require('node:assert/strict');
const { setupTestDatabase } = require('./helpers/db');
const { getDistributedLeaderService } = require('../services/DistributedLeaderService');

it('drains the database while the application leader owns a pooled connection', async () => {
  const database = await setupTestDatabase();
  const leader = getDistributedLeaderService();
  let cleanup;
  let timer;
  try {
    await leader.start();
    assert.equal(leader.isLeader, true);
    cleanup = database.cleanup();
    await Promise.race([
      cleanup,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('database cleanup retained the leader connection')), 2000);
      })
    ]);
    assert.equal(leader.isLeader, false);
  } finally {
    clearTimeout(timer);
    // Also release the connection on regression, so the failing test can exit.
    await leader.stop();
    await (cleanup || database.cleanup());
  }
});
