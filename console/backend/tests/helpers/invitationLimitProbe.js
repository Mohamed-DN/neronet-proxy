/**
 * Exercises the invitation acceptance limiter and prints the result as JSON.
 *
 * Out of process for the same reason as rateLimitProbe.js: the limiter reads its
 * disable switch once, at module load, and the suite runs with that switch on.
 *
 * The console sits behind one trusted proxy (nginx, `set_real_ip_from`), which appends
 * the address it saw to X-Forwarded-For. Supertest plays that proxy here: the header
 * it sends is what nginx would forward, and the right-most entry is the real client.
 *
 * Usage: node tests/helpers/invitationLimitProbe.js
 */

const request = require('supertest');
const { setupTestDatabase } = require('./db');
const { createApp } = require('../../server');

async function main() {
  const dbHelper = await setupTestDatabase();
  try {
    const app = createApp();
    const attempt = (forwardedFor, i) =>
      request(app)
        .post('/api/invitations/accept')
        .set('X-Forwarded-For', forwardedFor)
        .send({ code: 'ABCD-EFGH-JKMN', username: `probe${i}`, password: 'Password123!' });

    const codes = [];
    for (let i = 0; i < 11; i++) codes.push((await attempt('203.0.113.5', i)).status);
    // A client cannot buy a fresh budget by prepending its own entry: the proxy appends
    // the real address, and only that last hop is trusted.
    const forged = (await attempt('198.51.100.99, 203.0.113.5', 11)).status;
    const otherAddress = (await attempt('203.0.113.6', 12)).status;
    console.log(`PROBE_RESULT ${JSON.stringify({ codes, forged, otherAddress })}`);
  } finally {
    await dbHelper.cleanup();
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err.stack || String(err));
  process.exit(1);
});
