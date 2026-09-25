const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const BACKEND_DIR = path.resolve(__dirname, '..');

/**
 * The node control API was metered by address as a whole. Behind the console's nginx
 * every node arrives from the proxy's address, so the fleet shared one bucket of 60
 * requests a minute: a dozen nodes beating every 15 s plus their netmap fetches
 * exhausted it, heartbeats were refused with 429, endpoints were never recorded, and the
 * overlay never formed. Enrolment is now metered by address and node traffic by
 * credential.
 */
describe('Node control API limits', () => {
  function probe(scenario) {
    const res = spawnSync(
      process.execPath,
      [path.join(BACKEND_DIR, 'tests', 'helpers', 'nodeControlLimitProbe.js'), scenario],
      {
        cwd: BACKEND_DIR,
        env: {
          ...process.env,
          SOVEREIGN_RATE_LIMIT_DISABLED: 'false',
          SOVEREIGN_VALKEY_NAMESPACE: `ncl-${process.pid}-${scenario}`
        },
        encoding: 'utf8',
        timeout: 60_000
      }
    );
    assert.strictEqual(res.status, 0, `probe '${scenario}' failed: ${res.stderr}`);
    const line = String(res.stdout)
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.startsWith('PROBE_RESULT '));
    assert.ok(line, `probe '${scenario}' printed no result`);
    return JSON.parse(line.slice('PROBE_RESULT '.length));
  }

  it('lets a fleet behind one address heartbeat, each node on its own credential', () => {
    const { codes } = probe('fleet');
    assert.deepStrictEqual(codes, { 200: 160 }, `a fleet of 20 nodes x 8 beats was refused: ${JSON.stringify(codes)}`);
  });

  it('still meters enrolment by address', () => {
    const { firstRefusal } = probe('enrolment');
    assert.strictEqual(firstRefusal, 61);
  });

  it('refuses one credential that exceeds its budget', () => {
    const { firstRefusal } = probe('oneNode');
    assert.strictEqual(firstRefusal, 121);
  });
});
