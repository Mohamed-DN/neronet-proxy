/**
 * Exercises the limiters on the secret-verifying endpoints and prints the result as
 * JSON.
 *
 * Out of process for the same reason as rateLimitProbe.js: the limiter reads its
 * disable switch once, at module load, and the suite runs with that switch on so the
 * auth fuzzing tests can hammer the endpoints. The switch is deliberately not
 * runtime-mutable.
 *
 * Nothing here reaches Valkey: the probe never calls initValkey, so the limiter
 * takes its in-process path. That is the cache-outage case the endpoints have to
 * survive, and the scenarios report which path they took.
 *
 * Usage: node tests/helpers/secretEndpointProbe.js <scenario>
 */

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const request = require('supertest');

const scenarioName = process.argv[2] || 'unknown';
const testDbPath = path.resolve(__dirname, `../../../data/test_probe_${scenarioName}_${process.pid}.db`);
process.env.SOVEREIGN_DB_PATH = testDbPath;

const { getDatabase, closeDatabase } = require('../../db/index');
const { runMigrations } = require('../../db/migrator');
const { seedDatabase } = require('../../db/seed');
const { getValkeyClient } = require('../../db/valkey');
const { signToken } = require('../../middleware/auth');
const { createApp } = require('../../server');

function freshApp() {
  if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
  const db = getDatabase(testDbPath);
  runMigrations(db);
  seedDatabase(db);
  return createApp();
}

function cleanUp() {
  closeDatabase();
  for (const suffix of ['', '-wal', '-shm']) {
    const f = `${testDbPath}${suffix}`;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
}

/** Which side of the limiter served this run, so a result cannot be misread. */
function counterBacking() {
  return getValkeyClient() ? 'valkey' : 'in-process';
}

function anAccount() {
  const row = getDatabase().prepare("SELECT id, username, role FROM users WHERE role = 'super-admin' LIMIT 1").get();
  return { user: row, token: signToken({ id: row.id, username: row.username, role: row.role }) };
}

const scenarios = {
  /**
   * Five unlock attempts are allowed in the window and the sixth is refused, even
   * though every one of them carries the correct passphrase. The seventh arrives
   * from a different address: the budget belongs to the account, not the address.
   */
  async dmsUnlock() {
    const app = freshApp();
    const { token } = anAccount();
    const passphrase = crypto.randomBytes(16).toString('hex');

    const setup = await request(app)
      .post('/api/nuke/personal-dms/setup')
      .set('Authorization', `Bearer ${token}`)
      .send({ passphrase, heartbeat_interval_seconds: 3600 });

    const codes = [];
    for (let i = 0; i < 6; i++) {
      const res = await request(app)
        .post('/api/nuke/personal-dms/unlock')
        .set('Authorization', `Bearer ${token}`)
        .send({ passphrase });
      codes.push(res.status);
    }

    const fromAnotherAddress = await request(app)
      .post('/api/nuke/personal-dms/unlock')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Forwarded-For', '198.51.100.23')
      .send({ passphrase });

    return {
      backing: counterBacking(),
      setupStatus: setup.status,
      codes,
      fromAnotherAddress: fromAnotherAddress.status
    };
  },

  /** The other two paths to the same verification share one budget. */
  async dmsUnlockAliases() {
    const app = freshApp();
    const { token } = anAccount();
    const passphrase = crypto.randomBytes(16).toString('hex');

    await request(app)
      .post('/api/nuke/personal-dms/setup')
      .set('Authorization', `Bearer ${token}`)
      .send({ passphrase, heartbeat_interval_seconds: 3600 });

    const paths = [
      '/api/nuke/personal-dms/unlock',
      '/api/nuke/personal-dms/access',
      '/api/nuke/personal-dms/auth',
      '/api/nuke/personal-dms/unlock',
      '/api/nuke/personal-dms/access',
      '/api/nuke/personal-dms/auth'
    ];

    const codes = [];
    for (const p of paths) {
      const res = await request(app).post(p).set('Authorization', `Bearer ${token}`).send({ passphrase });
      codes.push(res.status);
    }

    return { backing: counterBacking(), codes };
  },

  /** A second account is metered separately. */
  async dmsUnlockPerUser() {
    const app = freshApp();
    const db = getDatabase();
    const admin = anAccount();

    const otherId = `usr-probe-${crypto.randomBytes(4).toString('hex')}`;
    db.prepare("INSERT INTO users (id, username, email, password_hash, role) VALUES (?, ?, ?, 'x', 'user')").run(
      otherId,
      `probe-${otherId}`,
      `${otherId}@example.test`
    );
    const otherToken = signToken({ id: otherId, username: `probe-${otherId}`, role: 'user' });

    const passphrase = crypto.randomBytes(16).toString('hex');
    await request(app)
      .post('/api/nuke/personal-dms/setup')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ passphrase, heartbeat_interval_seconds: 3600 });

    const exhausted = [];
    for (let i = 0; i < 6; i++) {
      const res = await request(app)
        .post('/api/nuke/personal-dms/unlock')
        .set('Authorization', `Bearer ${admin.token}`)
        .send({ passphrase });
      exhausted.push(res.status);
    }

    const other = await request(app)
      .post('/api/nuke/personal-dms/unlock')
      .set('Authorization', `Bearer ${otherToken}`)
      .send({ passphrase: 'whatever' });

    return { backing: counterBacking(), exhausted, otherAccount: other.status };
  },

  /**
   * Ten gateway attempts for one domain from one address are allowed and the
   * eleventh is refused. The domain does not exist, which is the point: the limiter
   * has to meter attempts that fail, or it meters nothing an attacker does.
   */
  async gatewayAuth() {
    const app = freshApp();

    const codes = [];
    for (let i = 0; i < 11; i++) {
      const res = await request(app)
        .post('/api/cloud-pc/custom-domains/probe.example.test/auth-gateway')
        .set('X-Forwarded-For', '203.0.113.9')
        .send({ otp_code: '123456' });
      codes.push(res.status);
    }

    return { backing: counterBacking(), codes };
  },

  /** A second domain, and a second address, each get their own budget. */
  async gatewayIsolation() {
    const app = freshApp();

    const exhausted = [];
    for (let i = 0; i < 11; i++) {
      const res = await request(app)
        .post('/api/cloud-pc/custom-domains/probe-a.example.test/auth-gateway')
        .set('X-Forwarded-For', '203.0.113.9')
        .send({ otp_code: '123456' });
      exhausted.push(res.status);
    }

    const otherDomain = await request(app)
      .post('/api/cloud-pc/custom-domains/probe-b.example.test/auth-gateway')
      .set('X-Forwarded-For', '203.0.113.9')
      .send({ otp_code: '123456' });

    const otherAddress = await request(app)
      .post('/api/cloud-pc/custom-domains/probe-a.example.test/auth-gateway')
      .set('X-Forwarded-For', '198.51.100.44')
      .send({ otp_code: '123456' });

    return {
      backing: counterBacking(),
      exhausted: exhausted[exhausted.length - 1],
      otherDomain: otherDomain.status,
      otherAddress: otherAddress.status
    };
  },

  /**
   * One domain, one hundred attempts spread over ten addresses, is inside the
   * per-domain budget; the hundred and first is not. The per-address limiter would
   * not catch this on its own.
   */
  async gatewayPerDomain() {
    const app = freshApp();

    let lastAllowed = null;
    let refused = null;

    for (let attempt = 0; attempt < 101; attempt++) {
      // A fresh address every ten attempts keeps the per-address budget (10) intact
      // while the per-domain budget (100) fills up.
      const address = `203.0.113.${100 + Math.floor(attempt / 10)}`;
      const res = await request(app)
        .post('/api/cloud-pc/custom-domains/probe-flood.example.test/auth-gateway')
        .set('X-Forwarded-For', address)
        .send({ otp_code: '123456' });

      if (attempt === 99) lastAllowed = res.status;
      if (attempt === 100) refused = res.status;
    }

    return { backing: counterBacking(), lastAllowed, refused };
  }
};

async function main() {
  const scenario = scenarios[scenarioName];

  if (!scenario) {
    console.error(`unknown scenario: ${scenarioName}`);
    process.exit(2);
  }

  try {
    // Prefixed because the application logs to stdout too: migrations, the seed and
    // the database shutdown all print after this line.
    console.log(`PROBE_RESULT ${JSON.stringify(await scenario())}`);
  } finally {
    cleanUp();
  }

  process.exit(0);
}

main().catch((err) => {
  console.error(err.stack || String(err));
  cleanUp();
  process.exit(1);
});
