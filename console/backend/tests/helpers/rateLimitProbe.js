/**
 * Exercises the rate limiter in a process of its own and prints the result as JSON.
 *
 * The limiter reads its disable switch once, at module load, so a suite that runs
 * with SOVEREIGN_RATE_LIMIT_DISABLED=true cannot test the limiter in-process. The
 * switch is deliberately not made runtime-mutable: a limiter that can be turned off
 * by assigning to a variable is one assignment away from being off in production.
 *
 * Usage: node tests/helpers/rateLimitProbe.js <scenario>
 */

const express = require('express');
const request = require('supertest');
const { rateLimit } = require('../../middleware/rateLimit');

function appWith(options, handler) {
  const app = express();
  app.use('/probe', rateLimit(options));
  app.get('/probe', handler || ((req, res) => res.json({ ok: true })));
  return app;
}

const scenarios = {
  // Three allowed, then refused.
  async ceiling() {
    const app = appWith({
      name: `probe-${process.pid}`,
      limit: 3,
      windowMs: 60_000,
      keyFn: () => 'fixed-caller'
    });

    const codes = [];
    for (let i = 0; i < 5; i++) {
      codes.push((await request(app).get('/probe')).status);
    }
    return { codes };
  },

  // The client must be told its budget and when to come back.
  async headers() {
    const app = appWith({
      name: `hdr-${process.pid}`,
      limit: 2,
      windowMs: 60_000,
      keyFn: () => 'one'
    });

    const first = await request(app).get('/probe');
    await request(app).get('/probe');
    const blocked = await request(app).get('/probe');

    return {
      limit: first.headers['ratelimit-limit'],
      remaining: first.headers['ratelimit-remaining'],
      blockedStatus: blocked.status,
      retryAfter: Number(blocked.headers['retry-after'])
    };
  },

  // One caller exhausting their budget must not affect anyone else.
  async isolation() {
    const app = appWith({
      name: `split-${process.pid}`,
      limit: 1,
      windowMs: 60_000,
      keyFn: (req) => req.headers['x-caller']
    });

    return {
      aFirst: (await request(app).get('/probe').set('x-caller', 'a')).status,
      aSecond: (await request(app).get('/probe').set('x-caller', 'a')).status,
      bFirst: (await request(app).get('/probe').set('x-caller', 'b')).status
    };
  },

  // An unattributable request cannot be metered, and must not pass unmetered.
  async unattributable() {
    const app = appWith({
      name: `anon-${process.pid}`,
      limit: 5,
      windowMs: 60_000,
      keyFn: () => null
    });

    return { status: (await request(app).get('/probe')).status };
  }
};

async function main() {
  const name = process.argv[2];
  const scenario = scenarios[name];

  if (!scenario) {
    console.error(`unknown scenario: ${name}`);
    process.exit(2);
  }

  console.log(JSON.stringify(await scenario()));
  process.exit(0);
}

main().catch((err) => {
  console.error(err.stack || String(err));
  process.exit(1);
});
