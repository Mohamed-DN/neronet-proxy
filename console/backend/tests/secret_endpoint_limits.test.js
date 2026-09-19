const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const BACKEND_DIR = path.resolve(__dirname, '..');

/**
 * The endpoints that verify a secret shared only the general API budget: 600
 * requests per minute per address. That is not a limit on guessing a dead man's
 * switch passphrase or a custom domain's gateway secret, it is a limit on traffic.
 *
 * Each probe runs in its own process because the limiter reads its disable switch
 * once at module load, and this suite runs with the switch on.
 */
describe('Limits on the endpoints that verify a secret', () => {
  // Each probe starts a process that loads express, the database and the app. These
  // assertions are about behaviour, not speed, so they get headroom rather than a
  // default timeout that turns CPU contention into a failed security test.
  const PROBE_TIMEOUT_MS = 60_000;

  function probe(scenario) {
    const res = spawnSync(
      process.execPath,
      [path.join(BACKEND_DIR, 'tests', 'helpers', 'secretEndpointProbe.js'), scenario],
      {
        cwd: BACKEND_DIR,
        env: { ...process.env, SOVEREIGN_RATE_LIMIT_DISABLED: 'false' },
        encoding: 'utf8'
      }
    );

    assert.strictEqual(res.status, 0, `probe '${scenario}' failed: ${res.stderr}`);

    // The application logs to stdout as it starts and stops, so the result is
    // picked out by its marker rather than by position.
    const line = String(res.stdout)
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.startsWith('PROBE_RESULT '));

    assert.ok(line, `probe '${scenario}' printed no result:\n${res.stdout}`);
    return JSON.parse(line.slice('PROBE_RESULT '.length));
  }

  describe('Personal dead man switch unlock', () => {
    it('refuses the sixth attempt in the window, correct passphrase included', { timeout: PROBE_TIMEOUT_MS }, () => {
      const r = probe('dmsUnlock');

      assert.strictEqual(r.setupStatus, 200, 'the probe could not arm a switch to unlock');
      // Every one of these carries the right passphrase. A limiter that only counts
      // failures is a limiter an attacker steps around by being right once.
      assert.deepStrictEqual(r.codes, [200, 200, 200, 200, 200, 429]);
    });

    it('meters the account rather than the address', { timeout: PROBE_TIMEOUT_MS }, () => {
      const r = probe('dmsUnlock');

      // Moving to another address must not hand the same account a fresh budget.
      assert.strictEqual(r.fromAnotherAddress, 429);
    });

    it('counts the unlock, access and auth paths against one budget', { timeout: PROBE_TIMEOUT_MS }, () => {
      const r = probe('dmsUnlockAliases');

      // Three routes, one verification. Budgeting them separately would triple the
      // real limit.
      assert.deepStrictEqual(r.codes, [200, 200, 200, 200, 200, 429]);
    });

    it('leaves another account its own budget', { timeout: PROBE_TIMEOUT_MS }, () => {
      const r = probe('dmsUnlockPerUser');

      assert.strictEqual(r.exhausted[5], 429);
      // 404: no switch configured for that account. Anything but 429 proves the
      // second account was not locked out by the first.
      assert.notStrictEqual(r.otherAccount, 429);
    });

    it('refuses even when the counters are in-process because Valkey is down', { timeout: PROBE_TIMEOUT_MS }, () => {
      const r = probe('dmsUnlock');

      // The probe never connects to Valkey, so this run is the cache-outage case.
      // Losing the cache must cost accuracy across instances, never the control.
      assert.strictEqual(r.backing, 'in-process');
      assert.strictEqual(r.codes[5], 429);
    });
  });

  describe('Custom domain gateway', () => {
    it('refuses the eleventh attempt for one domain from one address', { timeout: PROBE_TIMEOUT_MS }, () => {
      const r = probe('gatewayAuth');

      // The domain does not exist: an unauthenticated caller must be metered on the
      // attempts that fail, which is all of an enumeration.
      assert.deepStrictEqual(r.codes.slice(0, 10), Array(10).fill(404));
      assert.strictEqual(r.codes[10], 429);
    });

    it('meters each domain and address pair separately', { timeout: PROBE_TIMEOUT_MS }, () => {
      const r = probe('gatewayIsolation');

      assert.strictEqual(r.exhausted, 429);
      assert.notStrictEqual(r.otherDomain, 429);
      assert.notStrictEqual(r.otherAddress, 429);
    });

    it('caps one domain at a hundred attempts an hour across every address', { timeout: PROBE_TIMEOUT_MS }, () => {
      const r = probe('gatewayPerDomain');

      // Without the per-domain budget a caller with eleven addresses has an
      // unlimited one.
      assert.notStrictEqual(r.lastAllowed, 429);
      assert.strictEqual(r.refused, 429);
    });

    it('refuses even when the counters are in-process because Valkey is down', { timeout: PROBE_TIMEOUT_MS }, () => {
      const r = probe('gatewayAuth');

      assert.strictEqual(r.backing, 'in-process');
      assert.strictEqual(r.codes[10], 429);
    });
  });
});
