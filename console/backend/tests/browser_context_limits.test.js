const { it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

it('meters browser context creation separately from bound reads and account registration', { timeout: 60000 }, () => {
  const child = spawnSync(process.execPath, [path.join(__dirname, 'helpers/browserContextLimitsProbe.js')], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, SOVEREIGN_RATE_LIMIT_DISABLED: 'false' },
    encoding: 'utf8',
    timeout: 55000
  });
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout.trim().split('\n').pop());
  assert.deepEqual(result.creates, [...Array(10).fill(200), 429]);
  assert.deepEqual(result.reads, Array(12).fill(200), 'valid bound context reads must not consume the creation budget');
  assert.notEqual(result.registrationStatus, 429, 'browser context traffic must not consume the account signup budget');
  assert.equal(result.forgedStatus, 401);
  assert.equal(
    result.createdWithForgedBinding,
    0,
    'a supplied cookie cannot bypass admission to create an unknown context'
  );
});
