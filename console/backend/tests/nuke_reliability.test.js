const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { setupTestDatabase } = require('./helpers/db');
const { settleAuditWrites } = require('../utils/audit');
const NukeEngine = require('../modules/nuke/NukeEngine');
const RevocationEngine = require('../services/RevocationEngine');

// ARCH-REVIEW, finding 5: the dead man's switch check-in swallowed a failed database
// write, answered success and updated its in-memory copy, so the user was told the
// countdown was reset while the stored deadline -- the one the sweep reads -- ran
// out. The sweep swallowed its own errors, and nothing stopped two runs from acting
// on the same expired switch.

describe("The dead man's switch fails loudly and destroys once", () => {
  let dbHelper;
  let pool;

  async function addUserWithSwitch(id, { expired }) {
    await pool.query(
      `INSERT INTO users (id, username, email, password_hash, role) VALUES ($1, $1, $2, 'hash', 'user')`,
      [id, `${id}@dms.test`]
    );
    await pool.query(
      `INSERT INTO dead_man_switch (id, user_id, switch_tier, passphrase_hash, heartbeat_interval_seconds, next_deadline_at)
       VALUES ($1, $2, 'personal_user', 'x', 3600, NOW() + ($3 || ' seconds')::interval)`,
      [`dms-${id}`, id, expired ? '-60' : '3600']
    );
  }

  const deadline = async (id) =>
    (await pool.query('SELECT next_deadline_at FROM dead_man_switch WHERE user_id = $1', [id])).rows[0]
      .next_deadline_at;

  before(async () => {
    dbHelper = await setupTestDatabase();
    pool = dbHelper.pool;
  });

  after(async () => {
    if (dbHelper) await dbHelper.cleanup();
  });

  it('does not report a check-in the database did not record', async () => {
    await addUserWithSwitch('usr-dms-hb', { expired: false });
    const before = await deadline('usr-dms-hb');

    const realQuery = pool.query.bind(pool);
    pool.query = (text, ...rest) => {
      if (typeof text === 'string' && /^UPDATE dead_man_switch SET last_heartbeat_at/.test(text.trim())) {
        return Promise.reject(new Error('connection lost'));
      }
      return realQuery(text, ...rest);
    };
    try {
      await assert.rejects(() => NukeEngine.heartbeatPersonalDMS('usr-dms-hb'), /connection lost/);
    } finally {
      pool.query = realQuery;
    }
    assert.strictEqual((await deadline('usr-dms-hb')).getTime(), before.getTime());

    const ok = await NukeEngine.heartbeatPersonalDMS('usr-dms-hb');
    assert.strictEqual(ok.success, true);
    assert.ok((await deadline('usr-dms-hb')).getTime() > before.getTime());
  });

  it('destroys an expired account once when two sweeps overlap', async () => {
    await addUserWithSwitch('usr-dms-race', { expired: true });

    await Promise.all([NukeEngine.checkExpiredDeadManSwitches(), NukeEngine.checkExpiredDeadManSwitches()]);
    await settleAuditWrites();

    const gone = await pool.query("SELECT 1 FROM users WHERE id = 'usr-dms-race'");
    assert.strictEqual(gone.rows.length, 0);
    const events = await pool.query(
      "SELECT count(*)::int AS n FROM audit_events WHERE event_type = 'NUKE_USER_INSTANT' AND target_id = 'user:usr-dms-race'"
    );
    assert.strictEqual(events.rows[0].n, 1, 'the destruction ran more than once');
  });

  it('keeps the account and retries when the destruction fails', async () => {
    await addUserWithSwitch('usr-dms-retry', { expired: true });

    const real = RevocationEngine.revokeUserNodes;
    RevocationEngine.revokeUserNodes = async () => {
      throw new Error('revocation unavailable');
    };
    try {
      await NukeEngine.checkExpiredDeadManSwitches();
    } finally {
      RevocationEngine.revokeUserNodes = real;
    }

    assert.strictEqual((await pool.query("SELECT 1 FROM users WHERE id = 'usr-dms-retry'")).rows.length, 1);
    const status = (await pool.query("SELECT status FROM dead_man_switch WHERE user_id = 'usr-dms-retry'")).rows[0]
      .status;
    assert.strictEqual(status, 'active', 'the claim must be released so the next tick retries');

    await NukeEngine.checkExpiredDeadManSwitches();
    assert.strictEqual((await pool.query("SELECT 1 FROM users WHERE id = 'usr-dms-retry'")).rows.length, 0);
  });
});
