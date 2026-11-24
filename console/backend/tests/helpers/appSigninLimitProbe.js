/**
 * Exercises the app sign-in limiters through the real routes and prints the result as JSON.
 *
 * Out of process for the same reason as rateLimitProbe.js: the limiter reads its disable
 * switch once, at module load, and the suite runs with that switch on.
 *
 * Usage: node tests/helpers/appSigninLimitProbe.js
 */

const request = require('supertest');
const crypto = require('crypto');
const { setupTestDatabase } = require('./db');
const { createApp } = require('../../server');

async function main() {
  const dbHelper = await setupTestDatabase();
  try {
    const app = createApp();
    const start = (ip) =>
      request(app)
        .post('/api/app-auth/device/start')
        .set('X-Forwarded-For', ip)
        .send({ platform: 'linux', device_name: 'probe', public_key_hex: crypto.randomBytes(32).toString('hex') });

    const startCodes = [];
    for (let i = 0; i < 31; i++) startCodes.push((await start('203.0.113.5')).status);
    const startOtherAddress = (await start('203.0.113.6')).status;

    // Polling is metered per device code: one app polling hard does not slow another.
    const poll = (code) =>
      request(app).post('/api/app-auth/device/poll').set('X-Forwarded-For', '203.0.113.7').send({ device_code: code });
    const a = crypto.randomBytes(32).toString('hex');
    const b = crypto.randomBytes(32).toString('hex');
    const pollCodes = [];
    for (let i = 0; i < 241; i++) pollCodes.push((await poll(a)).status);
    const pollOtherCode = (await poll(b)).status;

    // Typing codes into a signed-in account is metered per person, and lookups share the budget.
    const refresh = [];
    for (let i = 0; i < 61; i++) {
      refresh.push(
        (
          await request(app)
            .post('/api/app-auth/token/refresh')
            .set('X-Forwarded-For', '203.0.113.8')
            .send({ refresh_token: 'nnr_' + 'a'.repeat(64), public_key_hex: 'b'.repeat(64) })
        ).status
      );
    }
    console.log(
      `PROBE_RESULT ${JSON.stringify({
        startAllowed: startCodes.filter((c) => c === 200).length,
        startLast: startCodes[startCodes.length - 1],
        startOtherAddress,
        pollLast: pollCodes[pollCodes.length - 1],
        pollFirst: pollCodes[0],
        pollOtherCode,
        refreshLast: refresh[refresh.length - 1],
        refreshFirst: refresh[0]
      })}`
    );
  } finally {
    await dbHelper.cleanup();
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
