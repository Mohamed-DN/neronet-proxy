const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const request = require('supertest');

const testDbPath = path.resolve(__dirname, '../../data/test_hardening.db');
process.env.SOVEREIGN_DB_PATH = testDbPath;

const { getDatabase, closeDatabase } = require('../db/index');
const { runMigrations } = require('../db/migrator');
const { seedDatabase } = require('../db/seed');
const { createApp } = require('../server');

const BACKEND_DIR = path.resolve(__dirname, '..');

describe('Security headers', () => {
  let app;

  before(() => {
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
    const db = getDatabase(testDbPath);
    runMigrations(db);
    seedDatabase(db);
    app = createApp();
  });

  after(() => {
    closeDatabase();
    for (const suffix of ['', '-wal', '-shm']) {
      const f = `${testDbPath}${suffix}`;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  });

  it('refuses to be framed', async () => {
    const res = await request(app).get('/api/health');

    // The console arms a dead man's switch and triggers NeroNuke. A page a hostile
    // site can frame is a page where a stolen click schedules a wipe.
    assert.match(res.headers['content-security-policy'], /frame-ancestors 'none'/);
    assert.strictEqual(res.headers['x-frame-options'], 'DENY');
  });

  it('sets a content security policy that blocks inline and remote scripts', async () => {
    const csp = (await request(app).get('/api/health')).headers['content-security-policy'];

    assert.match(csp, /script-src 'self'/);
    assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/);
    assert.doesNotMatch(csp, /script-src[^;]*unsafe-eval/);
    assert.match(csp, /object-src 'none'/);
    assert.match(csp, /default-src 'self'/);
  });

  it('disables MIME sniffing and leaks no referrer cross-origin', async () => {
    const res = await request(app).get('/api/health');

    assert.strictEqual(res.headers['x-content-type-options'], 'nosniff');
    assert.strictEqual(res.headers['referrer-policy'], 'strict-origin-when-cross-origin');
  });

  it('does not advertise the server implementation', async () => {
    const res = await request(app).get('/api/health');
    assert.strictEqual(res.headers['x-powered-by'], undefined);
  });

  it('withholds HSTS outside production', async () => {
    const res = await request(app).get('/api/health');

    // Sending HSTS from a plain-HTTP development origin pins localhost to HTTPS in
    // the developer's browser, which is a hard problem to diagnose later.
    assert.strictEqual(res.headers['strict-transport-security'], undefined);
  });
});

describe('Rate limiting', () => {
  // Run out of process: the limiter reads its disable switch once at module load,
  // and this suite runs with that switch on so the auth fuzzing tests can hammer
  // the endpoints. Making the switch runtime-mutable would be the wrong fix -- a
  // limiter that can be turned off by assigning to a variable is one assignment
  // away from being off in production.
  function probe(scenario) {
    const res = spawnSync(
      process.execPath,
      [path.join(BACKEND_DIR, 'tests', 'helpers', 'rateLimitProbe.js'), scenario],
      {
        cwd: BACKEND_DIR,
        env: { ...process.env, SOVEREIGN_RATE_LIMIT_DISABLED: 'false' },
        encoding: 'utf8'
      }
    );

    assert.strictEqual(res.status, 0, `probe '${scenario}' failed: ${res.stderr}`);

    const lastLine = String(res.stdout).trim().split('\n').pop();
    return JSON.parse(lastLine);
  }

  it('allows traffic up to the limit and refuses past it', () => {
    assert.deepStrictEqual(probe('ceiling').codes, [200, 200, 200, 429, 429]);
  });

  it('reports the budget so a client can back off', () => {
    const r = probe('headers');

    assert.strictEqual(r.limit, '2');
    assert.strictEqual(r.remaining, '1');
    assert.strictEqual(r.blockedStatus, 429);
    assert.ok(r.retryAfter > 0, 'Retry-After must tell the client when to return');
  });

  it('meters callers separately', () => {
    const r = probe('isolation');

    assert.strictEqual(r.aFirst, 200);
    assert.strictEqual(r.aSecond, 429);
    // One caller exhausting their budget must not affect anyone else.
    assert.strictEqual(r.bFirst, 200);
  });

  it('refuses a request it cannot attribute', () => {
    // Letting unattributable requests share one bucket means one attacker locks out
    // everybody; letting them through unmetered means the limiter can be bypassed.
    assert.strictEqual(probe('unattributable').status, 400);
  });
});

// The disable switch exists for test suites that must hammer the auth endpoints.
// An escape hatch a stray environment variable can turn into an open door is not an
// escape hatch, so production must ignore it outright.
describe('The rate limit disable switch cannot reach production', () => {
  function limitingDisabledIn(env) {
    const res = spawnSync(
      process.execPath,
      ['-e', "console.log(require('./middleware/rateLimit').LIMITING_DISABLED);"],
      {
        cwd: BACKEND_DIR,
        env: {
          ...process.env,
          SOVEREIGN_JWT_SECRET: 'test-secret-value',
          SOVEREIGN_REFRESH_SECRET: 'test-refresh-value',
          SOVEREIGN_ADMIN_PASS: 'test-admin-value',
          ...env
        },
        encoding: 'utf8'
      }
    );
    return `${res.stdout || ''}`.trim();
  }

  it('honours the switch outside production', () => {
    assert.strictEqual(
      limitingDisabledIn({ NODE_ENV: 'development', SOVEREIGN_RATE_LIMIT_DISABLED: 'true' }),
      'true'
    );
  });

  it('ignores the switch under NODE_ENV=production', () => {
    assert.strictEqual(
      limitingDisabledIn({ NODE_ENV: 'production', SOVEREIGN_RATE_LIMIT_DISABLED: 'true' }),
      'false'
    );
  });
});
