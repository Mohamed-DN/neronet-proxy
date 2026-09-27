const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const http = require('http');
const https = require('https');
const { v4: uuidv4 } = require('uuid');
const { isPostgres, getPgPool, getDatabase } = require('../../db/index');
const { blacklistToken, publishTopologyEvent } = require('../../db/valkey');
const { logAuditEvent } = require('../../utils/audit');
const { generateCanary, invalidateCanary } = require('../../services/CanaryService');
const RevocationEngine = require('../../services/RevocationEngine');
const { bumpNetmap } = require('../../services/AclEngine');
const logger = require('../../utils/logger');

// In-memory state store for fallback and rapid O(1) checks
const inMemoryDms = new Map(); // key: `${userId}:${switchTier}` -> dmsRecord
const inMemoryScheduledKills = new Map(); // key: userId -> { scheduled_deletion_at, active }
const inMemoryOwnerDms = {
  configured: false,
  passphrase_hash: '',
  sha_hash: '',
  heartbeat_interval_seconds: 86400 * 30,
  last_heartbeat_at: 0,
  webhook_url: ''
};

/**
 * Ensures dead_man_switch table and users.scheduled_deletion_at column exist.
 */
async function ensureTables(dbOrPool) {
  try {
    if (isPostgres()) {
      const pool = dbOrPool || getPgPool();
      await pool.query(`
        CREATE TABLE IF NOT EXISTS dead_man_switch (
            id VARCHAR(64) PRIMARY KEY,
            user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            switch_tier VARCHAR(32) NOT NULL CHECK (switch_tier IN ('personal_user', 'owner_global')),
            passphrase_hash VARCHAR(255) NOT NULL,
            heartbeat_interval_seconds BIGINT NOT NULL,
            last_heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            next_deadline_at TIMESTAMPTZ NOT NULL,
            webhook_url VARCHAR(512),
            steganography_mode VARCHAR(32) DEFAULT 'shadow_password' CHECK (steganography_mode IN ('reverse_password', 'split_reverse', 'shadow_password', 'hardware_key', 'mobile_otp')),
            steganography_secret VARCHAR(255),
            status VARCHAR(32) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'triggered', 'deactivated')),
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            CONSTRAINT uq_user_switch_tier UNIQUE(user_id, switch_tier)
        );
        CREATE INDEX IF NOT EXISTS idx_dms_deadline ON dead_man_switch(next_deadline_at, status);
      `);

      // Ensure scheduled_deletion_at column on users table
      await pool.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name='users' AND column_name='scheduled_deletion_at'
          ) THEN
            ALTER TABLE users ADD COLUMN scheduled_deletion_at TIMESTAMPTZ;
          END IF;
        END $$;
      `);
    } else {
      const db = dbOrPool || getDatabase();
      db.exec(`
        CREATE TABLE IF NOT EXISTS dead_man_switch (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            switch_tier TEXT NOT NULL CHECK (switch_tier IN ('personal_user', 'owner_global')),
            passphrase_hash TEXT NOT NULL,
            heartbeat_interval_seconds INTEGER NOT NULL,
            last_heartbeat_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            next_deadline_at DATETIME NOT NULL,
            webhook_url TEXT,
            steganography_mode TEXT DEFAULT 'shadow_password' CHECK (steganography_mode IN ('reverse_password', 'split_reverse', 'shadow_password', 'hardware_key', 'mobile_otp')),
            steganography_secret TEXT,
            status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'triggered', 'deactivated')),
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(user_id, switch_tier)
        );
        CREATE INDEX IF NOT EXISTS idx_dms_deadline ON dead_man_switch(next_deadline_at, status);
      `);

      // Ensure scheduled_deletion_at in SQLite users table
      const userCols = db.pragma('table_info(users)').map((c) => c.name);
      if (!userCols.includes('scheduled_deletion_at')) {
        db.exec('ALTER TABLE users ADD COLUMN scheduled_deletion_at DATETIME;');
      }
    }
  } catch (err) {
    logger.warn(`NukeEngine ensureTables notice: ${err.message}`);
  }
}

/**
 * Sends a single webhook ping (fire-and-forget with short timeout).
 */
function sendWebhookPing(url) {
  if (!url || typeof url !== 'string' || !url.startsWith('http')) {
    return Promise.resolve(false);
  }

  return new Promise((resolve) => {
    try {
      const parsedUrl = new URL(url);
      const isHttps = parsedUrl.protocol === 'https:';
      const client = isHttps ? https : http;

      const payload = JSON.stringify({
        alert: 'NERONET_WARRANT_CANARY_DEAD_MAN_TRIGGERED',
        timestamp: new Date().toISOString()
      });

      const req = client.request(
        parsedUrl,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload)
          },
          timeout: 2000
        },
        (res) => {
          resolve(res.statusCode >= 200 && res.statusCode < 300);
        }
      );

      req.on('error', () => resolve(false));
      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });

      req.write(payload);
      req.end();
    } catch (e) {
      resolve(false);
    }
  });
}

// -----------------------------------------------------------------------------
// TIER 1: User Account Self-Destruct
// -----------------------------------------------------------------------------

/**
 * Executes immediate, irreversible destruction of a single user account and all owned assets.
 */
async function executeInstantUserDestruction(userId, token = null, actorUsername = 'user') {
  // Revoke before deleting. Once the rows are gone the keys cannot be looked up, and
  // every peer that federated with this user would keep routing to devices that no
  // longer exist. If revocation fails nothing is deleted: the caller gets the error,
  // and the timers retry on their next tick.
  //
  // This used to require './RevocationEngine', a file that does not exist in this
  // module. The require threw, the catch logged it, and every account was deleted
  // with its device keys still valid on the data plane.
  await RevocationEngine.revokeUserNodes(userId, { reason: 'user_destroyed' });

  await ensureTables();

  // 1. Blacklist active JWT token immediately
  if (token) {
    await blacklistToken(token, 86400);
  }

  // 2. Overwrite sensitive fields, then delete, in one transaction. A failure used to
  // be logged and the function went on to report the account wiped.
  if (isPostgres()) {
    const pool = getPgPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Overwrite node WireGuard / Noise keys & metadata
      const randomNoiseKey = crypto.randomBytes(32).toString('base64');
      await client.query(
        `
        UPDATE nodes
        SET preshared_key = $1, public_key = $2, endpoints = '[]'::jsonb, metadata = '{}'::jsonb
        WHERE user_id = $3
      `,
        [randomNoiseKey, `dead-${crypto.randomBytes(16).toString('hex')}`, userId]
      );

      // Overwrite user password & bypass_apps
      const randomHash = bcrypt.hashSync(crypto.randomBytes(32).toString('hex'), 10);
      await client.query(
        `
        UPDATE users
        SET password_hash = $1, email = $2, bypass_apps = '[]'::jsonb
        WHERE id = $3
      `,
        [randomHash, `deleted_${crypto.randomBytes(8).toString('hex')}@wiped.local`, userId]
      );

      // Hard delete in cascading order
      await client.query('DELETE FROM dead_man_switch WHERE user_id = $1', [userId]);
      await client.query('DELETE FROM refresh_tokens WHERE user_id = $1', [userId]);
      await client.query('DELETE FROM cloud_pcs WHERE user_id = $1', [userId]);
      await client.query('DELETE FROM nodes WHERE user_id = $1', [userId]);
      await client.query('DELETE FROM users WHERE id = $1', [userId]);

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      logger.error(`Account destruction for ${userId} failed and was rolled back: ${err.message}`);
      throw err;
    } finally {
      client.release();
    }
  } else {
    const db = getDatabase();

    db.pragma('foreign_keys = OFF');
    try {
      // Overwrite node keys
      const randomNoiseKey = crypto.randomBytes(32).toString('base64');
      db.prepare(
        `
          UPDATE nodes
          SET preshared_key = ?, public_key = ?, endpoints = '[]', metadata = '{}'
          WHERE user_id = ?
        `
      ).run(randomNoiseKey, `dead-${crypto.randomBytes(16).toString('hex')}`, userId);

      // Overwrite user
      const randomHash = bcrypt.hashSync(crypto.randomBytes(32).toString('hex'), 10);
      db.prepare(
        `
          UPDATE users
          SET password_hash = ?, email = ?, bypass_apps = '[]'
          WHERE id = ?
        `
      ).run(randomHash, `deleted_${crypto.randomBytes(8).toString('hex')}@wiped.local`, userId);

      // Hard delete cascading
      db.prepare('DELETE FROM dead_man_switch WHERE user_id = ?').run(userId);
      db.prepare('DELETE FROM refresh_tokens WHERE user_id = ?').run(userId);
      db.prepare('DELETE FROM app_share_links WHERE user_id = ?').run(userId);
      db.prepare('DELETE FROM nerodrop_sessions WHERE user_id = ?').run(userId);
      db.prepare('DELETE FROM app_bundles WHERE user_id = ?').run(userId);
      db.prepare('DELETE FROM cloud_pcs WHERE user_id = ?').run(userId);
      db.prepare('DELETE FROM nodes WHERE user_id = ?').run(userId);
      db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    } finally {
      db.pragma('foreign_keys = ON');
    }
  }

  // The revocation bumped the netmap before the rows went; bump again so no peer
  // keeps a netmap that still lists the deleted devices.
  await bumpNetmap();

  // Clear in-memory caches
  inMemoryDms.delete(`${userId}:personal_user`);
  inMemoryScheduledKills.delete(userId);

  // Broadcast topology event
  publishTopologyEvent({
    event_type: 'USER_WIPED',
    payload: { user_id: userId }
  });

  // Log Audit Event
  logAuditEvent({
    eventType: 'NUKE_USER_INSTANT',
    severity: 'critical',
    actorUserId: userId,
    actorUsername: actorUsername,
    targetId: `user:${userId}`,
    targetType: 'user',
    message: `User account ${userId} cryptographically wiped and hard deleted.`
  });

  return {
    success: true,
    message: 'User account cryptographically wiped'
  };
}

/**
 * Schedules account destruction for a future date.
 */
async function scheduleUserDestruction(userId, scheduledDeletionAt) {
  await ensureTables();

  if (!scheduledDeletionAt || scheduledDeletionAt === 'PAST_DATE') {
    throw new Error('Invalid scheduled_deletion_at timestamp');
  }

  const schedDate = new Date(scheduledDeletionAt);
  if (isNaN(schedDate.getTime()) || schedDate.getTime() <= Date.now()) {
    throw new Error('Invalid scheduled_deletion_at timestamp');
  }

  const isoString = schedDate.toISOString();

  try {
    if (isPostgres()) {
      const pool = getPgPool();
      await pool.query('UPDATE users SET scheduled_deletion_at = $1 WHERE id = $2', [isoString, userId]);
    } else {
      const db = getDatabase();
      db.prepare('UPDATE users SET scheduled_deletion_at = ? WHERE id = ?').run(isoString, userId);
    }
  } catch (err) {
    logger.warn(`Could not update scheduled_deletion_at in DB: ${err.message}`);
  }

  inMemoryScheduledKills.set(userId, {
    user_id: userId,
    scheduled_deletion_at: isoString,
    active: true
  });

  return {
    active: true,
    scheduled_deletion_at: isoString,
    persistent_red_button_state: 'ACTIVE_COUNTDOWN'
  };
}

/**
 * Cancels a scheduled account destruction.
 */
async function cancelScheduledUserDestruction(userId) {
  await ensureTables();

  try {
    if (isPostgres()) {
      const pool = getPgPool();
      await pool.query('UPDATE users SET scheduled_deletion_at = NULL WHERE id = $1', [userId]);
    } else {
      const db = getDatabase();
      db.prepare('UPDATE users SET scheduled_deletion_at = NULL WHERE id = ?').run(userId);
    }
  } catch (err) {
    logger.warn(`Could not cancel scheduled_deletion_at in DB: ${err.message}`);
  }

  inMemoryScheduledKills.delete(userId);

  return {
    success: true,
    active: false,
    message: 'Scheduled destruction cancelled'
  };
}

/**
 * Gets user self-destruct status.
 */
async function getUserNukeStatus(userId) {
  await ensureTables();

  let schedAt = null;
  if (isPostgres()) {
    const pool = getPgPool();
    const res = await pool.query('SELECT scheduled_deletion_at FROM users WHERE id = $1', [userId]);
    schedAt = res.rows[0]?.scheduled_deletion_at || null;
  } else {
    const db = getDatabase();
    const row = db.prepare('SELECT scheduled_deletion_at FROM users WHERE id = ?').get(userId);
    schedAt = row?.scheduled_deletion_at || null;
  }

  const memSched = inMemoryScheduledKills.get(userId);
  const scheduledTime = schedAt || (memSched ? memSched.scheduled_deletion_at : null);
  const isActive = Boolean(scheduledTime);

  return {
    user_id: userId,
    active: isActive,
    scheduled_deletion_at: scheduledTime,
    persistent_red_button_state: isActive ? 'ACTIVE_COUNTDOWN' : 'INACTIVE'
  };
}

// -----------------------------------------------------------------------------
// TIER 1b: Per-User Personal Dead Man's Switch (Silent / Invisible)
// -----------------------------------------------------------------------------

/**
 * Sets up or updates a user's personal silent Dead Man's Switch.
 */
async function setupPersonalDMS(
  userId,
  { passphrase, heartbeat_interval_seconds, steganography_mode, steganography_secret }
) {
  await ensureTables();

  if (!passphrase || typeof passphrase !== 'string' || passphrase.trim().length === 0) {
    throw new Error('Missing passphrase or heartbeat_interval_seconds');
  }

  const interval = Number(heartbeat_interval_seconds);
  if (isNaN(interval) || interval <= 0) {
    throw new Error('heartbeat_interval_seconds must be positive');
  }

  const mode = steganography_mode || 'reverse_password';
  const salt = bcrypt.genSaltSync(10);
  const passphraseHash = bcrypt.hashSync(passphrase, salt);
  const shaHash = crypto.createHash('sha256').update(passphrase).digest('hex');

  const now = new Date();
  const nextDeadline = new Date(now.getTime() + interval * 1000).toISOString();
  const dmsId = `dms-usr-${uuidv4().substring(0, 8)}`;
  const secretVal = steganography_secret || passphrase;

  try {
    if (isPostgres()) {
      const pool = getPgPool();
      await pool.query(
        `
        INSERT INTO dead_man_switch (
          id, user_id, switch_tier, passphrase_hash, heartbeat_interval_seconds,
          last_heartbeat_at, next_deadline_at, steganography_mode, steganography_secret, status
        ) VALUES ($1, $2, 'personal_user', $3, $4, NOW(), $5, $6, $7, 'active')
        ON CONFLICT (user_id, switch_tier) DO UPDATE SET
          passphrase_hash = EXCLUDED.passphrase_hash,
          heartbeat_interval_seconds = EXCLUDED.heartbeat_interval_seconds,
          last_heartbeat_at = NOW(),
          next_deadline_at = EXCLUDED.next_deadline_at,
          steganography_mode = EXCLUDED.steganography_mode,
          steganography_secret = EXCLUDED.steganography_secret,
          status = 'active',
          updated_at = NOW()
      `,
        [dmsId, userId, passphraseHash, interval, nextDeadline, mode, secretVal]
      );
    } else {
      const db = getDatabase();
      db.prepare(
        `
        INSERT INTO dead_man_switch (
          id, user_id, switch_tier, passphrase_hash, heartbeat_interval_seconds,
          last_heartbeat_at, next_deadline_at, steganography_mode, steganography_secret, status
        ) VALUES (?, ?, 'personal_user', ?, ?, CURRENT_TIMESTAMP, ?, ?, ?, 'active')
        ON CONFLICT(user_id, switch_tier) DO UPDATE SET
          passphrase_hash = excluded.passphrase_hash,
          heartbeat_interval_seconds = excluded.heartbeat_interval_seconds,
          last_heartbeat_at = CURRENT_TIMESTAMP,
          next_deadline_at = excluded.next_deadline_at,
          steganography_mode = excluded.steganography_mode,
          steganography_secret = excluded.steganography_secret,
          status = 'active',
          updated_at = CURRENT_TIMESTAMP
      `
      ).run(dmsId, userId, passphraseHash, interval, nextDeadline, mode, secretVal);
    }
  } catch (err) {
    logger.warn(`Could not save personal DMS in DB: ${err.message}`);
  }

  // Store in memory map for fast lookup
  inMemoryDms.set(`${userId}:personal_user`, {
    id: dmsId,
    user_id: userId,
    switch_tier: 'personal_user',
    passphrase_hash: passphraseHash,
    sha_hash: shaHash,
    original_passphrase: passphrase,
    heartbeat_interval_seconds: interval,
    last_heartbeat_at: now.getTime() / 1000,
    next_deadline_at: nextDeadline,
    steganography_mode: mode,
    steganography_secret: secretVal,
    status: 'active'
  });

  return {
    success: true,
    message: "Personal Dead Man's Switch activated silently"
  };
}

/**
 * Constant-time comparison of two secrets. Both sides are hashed first so the
 * comparison takes the same time whatever their lengths, and an empty or missing
 * candidate never matches.
 */
function secretsEqual(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string') return false;
  if (provided.length === 0 || expected.length === 0) return false;
  const a = crypto.createHash('sha256').update(provided).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

/**
 * Unlocks the personal Dead Man's Switch panel using steganographic credentials.
 */
async function unlockPersonalDMS(userId, stegoCredentials) {
  await ensureTables();

  let dms = inMemoryDms.get(`${userId}:personal_user`);

  if (!dms) {
    if (isPostgres()) {
      const pool = getPgPool();
      const res = await pool.query(
        'SELECT * FROM dead_man_switch WHERE user_id = $1 AND switch_tier = $2 AND status = $3',
        [userId, 'personal_user', 'active']
      );
      if (res.rows.length > 0) dms = res.rows[0];
    } else {
      const db = getDatabase();
      dms = db
        .prepare(
          "SELECT * FROM dead_man_switch WHERE user_id = ? AND switch_tier = 'personal_user' AND status = 'active'"
        )
        .get(userId);
    }
  }

  if (!dms) {
    const err = new Error('No Personal DMS configured');
    err.status = 404;
    throw err;
  }

  const mode = dms.steganography_mode || 'reverse_password';
  const authVal = String(stegoCredentials || '').trim();
  const original = dms.original_passphrase || dms.steganography_secret || '';

  // The values that open the switch in each mode. A mode can only widen this set by
  // transforming the secret the user stored (reversing it, for example); it can never
  // accept something the user did not choose. Earlier versions accepted any six digit
  // number in one mode, any string of ten characters or more in another, and fixed
  // strings written into this file, so a valid session alone was enough to open the
  // switch.
  const reverse = (value) => value.split('').reverse().join('');
  const accepted = [original, dms.steganography_secret];

  if (mode === 'reverse_password') {
    accepted.push(reverse(original));
  } else if (mode === 'split_reverse') {
    const mid = Math.floor(original.length / 2);
    const head = original.slice(0, mid);
    const tail = original.slice(mid);
    accepted.push(reverse(head) + tail, head + reverse(tail), reverse(head) + reverse(tail));
  }

  let valid = accepted.some((candidate) => secretsEqual(authVal, candidate));

  // shadow_password also honours the hash stored when the switch was set up.
  if (!valid && mode === 'shadow_password' && dms.passphrase_hash) {
    valid = bcrypt.compareSync(authVal, dms.passphrase_hash);
  }

  if (!valid) {
    const err = new Error('Steganographic verification failed');
    err.status = 401;
    throw err;
  }

  const intervalSec = Number(dms.heartbeat_interval_seconds);
  const lastHbMs =
    typeof dms.last_heartbeat_at === 'number'
      ? dms.last_heartbeat_at * 1000
      : new Date(dms.last_heartbeat_at || Date.now()).getTime();
  const deadlineMs = lastHbMs + intervalSec * 1000;
  const remainingSec = Math.max(0, Math.floor((deadlineMs - Date.now()) / 1000));

  return {
    unlocked: true,
    heartbeat_interval_seconds: intervalSec,
    seconds_remaining: remainingSec,
    last_heartbeat_at: dms.last_heartbeat_at,
    next_deadline_at: dms.next_deadline_at || new Date(deadlineMs).toISOString()
  };
}

/**
 * Resets the countdown timer for the personal Dead Man's Switch.
 */
async function heartbeatPersonalDMS(userId) {
  await ensureTables();

  let dms = inMemoryDms.get(`${userId}:personal_user`);
  if (!dms) {
    if (isPostgres()) {
      const pool = getPgPool();
      const res = await pool.query(
        'SELECT * FROM dead_man_switch WHERE user_id = $1 AND switch_tier = $2 AND status = $3',
        [userId, 'personal_user', 'active']
      );
      if (res.rows.length > 0) dms = res.rows[0];
    } else {
      const db = getDatabase();
      dms = db
        .prepare(
          "SELECT * FROM dead_man_switch WHERE user_id = ? AND switch_tier = 'personal_user' AND status = 'active'"
        )
        .get(userId);
    }
  }

  if (!dms) {
    const err = new Error('No Personal DMS configured');
    err.status = 404;
    throw err;
  }

  const now = new Date();
  const interval = Number(dms.heartbeat_interval_seconds);
  const nextDeadline = new Date(now.getTime() + interval * 1000).toISOString();

  // A check-in that did not reach the database is not a check-in. This used to
  // swallow the error, answer success, and update the in-memory copy, so the user was
  // told the countdown had been reset while the stored deadline -- the one the sweep
  // reads -- kept running out.
  if (isPostgres()) {
    const pool = getPgPool();
    const res = await pool.query(
      "UPDATE dead_man_switch SET last_heartbeat_at = NOW(), next_deadline_at = $1 WHERE user_id = $2 AND switch_tier = $3 AND status = 'active'",
      [nextDeadline, userId, 'personal_user']
    );
    if (res.rowCount === 0) {
      inMemoryDms.delete(`${userId}:personal_user`);
      const err = new Error('The personal switch is no longer active');
      err.status = 409;
      throw err;
    }
  } else {
    const db = getDatabase();
    db.prepare(
      "UPDATE dead_man_switch SET last_heartbeat_at = CURRENT_TIMESTAMP, next_deadline_at = ? WHERE user_id = ? AND switch_tier = 'personal_user'"
    ).run(nextDeadline, userId);
  }

  const epochTime = now.getTime() / 1000;
  if (inMemoryDms.has(`${userId}:personal_user`)) {
    const mem = inMemoryDms.get(`${userId}:personal_user`);
    mem.last_heartbeat_at = epochTime;
    mem.next_deadline_at = nextDeadline;
  }

  return {
    success: true,
    last_heartbeat_at: epochTime
  };
}

/**
 * Gets Personal DMS status for a given user.
 */
async function getPersonalDMSStatus(userId) {
  await ensureTables();

  let dms = inMemoryDms.get(`${userId}:personal_user`);
  if (!dms) {
    if (isPostgres()) {
      const pool = getPgPool();
      const res = await pool.query(
        'SELECT * FROM dead_man_switch WHERE user_id = $1 AND switch_tier = $2 AND status = $3',
        [userId, 'personal_user', 'active']
      );
      if (res.rows.length > 0) dms = res.rows[0];
    } else {
      const db = getDatabase();
      dms = db
        .prepare(
          "SELECT * FROM dead_man_switch WHERE user_id = ? AND switch_tier = 'personal_user' AND status = 'active'"
        )
        .get(userId);
    }
  }

  if (!dms) {
    return {
      configured: false,
      status: 'inactive'
    };
  }

  const interval = Number(dms.heartbeat_interval_seconds);
  const lastHbMs =
    typeof dms.last_heartbeat_at === 'number'
      ? dms.last_heartbeat_at * 1000
      : new Date(dms.last_heartbeat_at || Date.now()).getTime();
  const deadlineMs = lastHbMs + interval * 1000;
  const remainingSec = Math.max(0, Math.floor((deadlineMs - Date.now()) / 1000));

  return {
    configured: true,
    status: 'active',
    steganography_mode: dms.steganography_mode || 'reverse_password',
    heartbeat_interval_seconds: interval,
    last_heartbeat_at: dms.last_heartbeat_at,
    next_deadline_at: dms.next_deadline_at || new Date(deadlineMs).toISOString(),
    seconds_remaining: remainingSec
  };
}

// -----------------------------------------------------------------------------
// TIER 2: Network Owner Dead Man's Switch (Global Wipe)
// -----------------------------------------------------------------------------

/**
 * Sets up the Network Owner (Super-Admin) Dead Man's Switch.
 */
async function setupOwnerDMS(superAdminUserId, { passphrase, heartbeat_interval_seconds, webhook_url }) {
  await ensureTables();

  if (!passphrase || typeof passphrase !== 'string' || passphrase.trim().length === 0) {
    throw new Error('Missing passphrase or heartbeat_interval_seconds');
  }

  const interval = Number(heartbeat_interval_seconds);
  if (isNaN(interval) || interval <= 0) {
    throw new Error('heartbeat_interval_seconds must be positive');
  }

  const salt = bcrypt.genSaltSync(10);
  const passphraseHash = bcrypt.hashSync(passphrase, salt);
  const shaHash = crypto.createHash('sha256').update(passphrase).digest('hex');
  const now = new Date();
  const nextDeadline = new Date(now.getTime() + interval * 1000).toISOString();
  const dmsId = 'dms-owner-master';
  const hookUrl = webhook_url || '';

  try {
    if (isPostgres()) {
      const pool = getPgPool();
      await pool.query(
        `
        INSERT INTO dead_man_switch (
          id, user_id, switch_tier, passphrase_hash, heartbeat_interval_seconds,
          last_heartbeat_at, next_deadline_at, webhook_url, status
        ) VALUES ($1, $2, 'owner_global', $3, $4, NOW(), $5, $6, 'active')
        ON CONFLICT (user_id, switch_tier) DO UPDATE SET
          passphrase_hash = EXCLUDED.passphrase_hash,
          heartbeat_interval_seconds = EXCLUDED.heartbeat_interval_seconds,
          last_heartbeat_at = NOW(),
          next_deadline_at = EXCLUDED.next_deadline_at,
          webhook_url = EXCLUDED.webhook_url,
          status = 'active',
          updated_at = NOW()
      `,
        [dmsId, superAdminUserId, passphraseHash, interval, nextDeadline, hookUrl]
      );
    } else {
      const db = getDatabase();
      db.prepare(
        `
        INSERT INTO dead_man_switch (
          id, user_id, switch_tier, passphrase_hash, heartbeat_interval_seconds,
          last_heartbeat_at, next_deadline_at, webhook_url, status
        ) VALUES (?, ?, 'owner_global', ?, ?, CURRENT_TIMESTAMP, ?, ?, 'active')
        ON CONFLICT(user_id, switch_tier) DO UPDATE SET
          passphrase_hash = excluded.passphrase_hash,
          heartbeat_interval_seconds = excluded.heartbeat_interval_seconds,
          last_heartbeat_at = CURRENT_TIMESTAMP,
          next_deadline_at = excluded.next_deadline_at,
          webhook_url = excluded.webhook_url,
          status = 'active',
          updated_at = CURRENT_TIMESTAMP
      `
      ).run(dmsId, superAdminUserId, passphraseHash, interval, nextDeadline, hookUrl);
    }
  } catch (err) {
    logger.warn(`Could not persist owner DMS in DB: ${err.message}`);
  }

  inMemoryOwnerDms.configured = true;
  inMemoryOwnerDms.passphrase_hash = passphraseHash;
  inMemoryOwnerDms.sha_hash = shaHash;
  inMemoryOwnerDms.heartbeat_interval_seconds = interval;
  inMemoryOwnerDms.last_heartbeat_at = now.getTime() / 1000;
  inMemoryOwnerDms.webhook_url = hookUrl;

  // Refresh warrant canary
  await generateCanary();

  return {
    success: true,
    message: "Owner Dead Man's Switch configured"
  };
}

/**
 * Re-confirms owner heartbeat and refreshes the Warrant Canary.
 */
async function heartbeatOwnerDMS(superAdminUserId, passphrase) {
  await ensureTables();

  if (!passphrase) {
    const err = new Error('Invalid owner passphrase');
    err.status = 401;
    throw err;
  }

  let dbHash = inMemoryOwnerDms.passphrase_hash;
  let interval = inMemoryOwnerDms.heartbeat_interval_seconds;

  if (isPostgres()) {
    const pool = getPgPool();
    const res = await pool.query(
      "SELECT * FROM dead_man_switch WHERE switch_tier = 'owner_global' AND status = 'active' ORDER BY created_at DESC LIMIT 1"
    );
    if (res.rows.length > 0) {
      dbHash = res.rows[0].passphrase_hash;
      interval = Number(res.rows[0].heartbeat_interval_seconds);
    }
  } else {
    const db = getDatabase();
    const row = db
      .prepare(
        "SELECT * FROM dead_man_switch WHERE switch_tier = 'owner_global' AND status = 'active' ORDER BY created_at DESC LIMIT 1"
      )
      .get();
    if (row) {
      dbHash = row.passphrase_hash;
      interval = Number(row.heartbeat_interval_seconds);
    }
  }

  const shaInput = crypto.createHash('sha256').update(passphrase).digest('hex');
  const validSha = inMemoryOwnerDms.sha_hash && shaInput === inMemoryOwnerDms.sha_hash;
  // The stored hash is not a password: presenting it must not authenticate.
  const validBcrypt = Boolean(dbHash) && bcrypt.compareSync(passphrase, dbHash);

  if (!validSha && !validBcrypt) {
    const err = new Error('Invalid owner passphrase');
    err.status = 401;
    throw err;
  }

  const now = new Date();
  const nextDeadline = new Date(now.getTime() + interval * 1000).toISOString();

  if (isPostgres()) {
    const pool = getPgPool();
    const res = await pool.query(
      "UPDATE dead_man_switch SET last_heartbeat_at = NOW(), next_deadline_at = $1 WHERE switch_tier = 'owner_global' AND status = 'active'",
      [nextDeadline]
    );
    if (res.rowCount === 0 && !inMemoryOwnerDms.configured) {
      const err = new Error('The owner switch is not active');
      err.status = 409;
      throw err;
    }
  } else {
    const db = getDatabase();
    db.prepare(
      "UPDATE dead_man_switch SET last_heartbeat_at = CURRENT_TIMESTAMP, next_deadline_at = ? WHERE switch_tier = 'owner_global'"
    ).run(nextDeadline);
  }

  const epochTime = now.getTime() / 1000;
  inMemoryOwnerDms.last_heartbeat_at = epochTime;

  // Refresh warrant canary on valid heartbeat
  await generateCanary();

  return {
    success: true,
    last_heartbeat_at: epochTime
  };
}

/**
 * Gets the status of the Owner Dead Man's Switch.
 */
async function getOwnerDMSStatus(superAdminUserId) {
  await ensureTables();

  let dmsRow = null;
  if (isPostgres()) {
    const pool = getPgPool();
    const res = await pool.query(
      "SELECT * FROM dead_man_switch WHERE switch_tier = 'owner_global' AND status = 'active' LIMIT 1"
    );
    dmsRow = res.rows[0] || null;
  } else {
    const db = getDatabase();
    dmsRow =
      db
        .prepare("SELECT * FROM dead_man_switch WHERE switch_tier = 'owner_global' AND status = 'active' LIMIT 1")
        .get() || null;
  }

  if (!dmsRow && !inMemoryOwnerDms.configured) {
    return {
      configured: false,
      status: 'inactive'
    };
  }

  const interval = dmsRow ? Number(dmsRow.heartbeat_interval_seconds) : inMemoryOwnerDms.heartbeat_interval_seconds;
  const lastHb = dmsRow ? dmsRow.last_heartbeat_at : inMemoryOwnerDms.last_heartbeat_at;
  const lastHbMs = typeof lastHb === 'number' ? lastHb * 1000 : new Date(lastHb).getTime();
  const deadlineMs = lastHbMs + interval * 1000;
  const remainingSec = Math.max(0, Math.floor((deadlineMs - Date.now()) / 1000));

  return {
    configured: true,
    status: 'active',
    heartbeat_interval_seconds: interval,
    last_heartbeat_at: lastHb,
    next_deadline_at: dmsRow?.next_deadline_at || new Date(deadlineMs).toISOString(),
    seconds_remaining: remainingSec,
    webhook_url_configured: Boolean(dmsRow?.webhook_url || inMemoryOwnerDms.webhook_url)
  };
}

/**
 * Executes a full cascading wipe of the entire NeroNet database and in-memory stores.
 */
async function executeOwnerGlobalCascadingWipe() {
  await ensureTables();

  // 1. Send single webhook canary ping if URL configured
  let webhookUrl = inMemoryOwnerDms.webhook_url;
  try {
    if (isPostgres()) {
      const pool = getPgPool();
      const res = await pool.query(
        "SELECT webhook_url FROM dead_man_switch WHERE switch_tier = 'owner_global' LIMIT 1"
      );
      if (res.rows[0]?.webhook_url) webhookUrl = res.rows[0].webhook_url;
    } else {
      const db = getDatabase();
      const row = db
        .prepare("SELECT webhook_url FROM dead_man_switch WHERE switch_tier = 'owner_global' LIMIT 1")
        .get();
      if (row?.webhook_url) webhookUrl = row.webhook_url;
    }
  } catch (e) {
    // Not fatal: the wipe goes ahead without the notification.
    logger.error(`Owner wipe: could not read the webhook address: ${e.message}`);
  }

  if (webhookUrl) {
    await sendWebhookPing(webhookUrl);
  }

  // 2. Cascade wipe all database tables safely
  const tables = [
    'custom_domains',
    'cloud_pcs',
    'peering_agreements',
    'geofencing_policies',
    'node_telemetry_history',
    'dead_man_switch',
    'refresh_tokens',
    'nodes',
    'audit_events',
    'warrant_canaries',
    'system_metrics',
    'users'
  ];

  // Every table is attempted, and a table that could not be emptied is reported: a
  // silent failure here used to end in "Global cascading wipe completed" while data
  // remained.
  const failed = [];
  if (isPostgres()) {
    const pool = getPgPool();
    for (const tbl of tables) {
      try {
        await pool.query(`DELETE FROM ${tbl}`);
      } catch (e) {
        failed.push(tbl);
        logger.error(`Owner wipe: could not empty ${tbl}: ${e.message}`);
      }
    }
  } else {
    const db = getDatabase();
    db.pragma('foreign_keys = OFF');
    try {
      for (const tbl of tables) {
        try {
          db.prepare(`DELETE FROM ${tbl}`).run();
        } catch (e) {
          failed.push(tbl);
          logger.error(`Owner wipe: could not empty ${tbl}: ${e.message}`);
        }
      }
    } finally {
      db.pragma('foreign_keys = ON');
    }
  }

  // 3. Clear in-memory caches and Valkey
  inMemoryDms.clear();
  inMemoryScheduledKills.clear();
  inMemoryOwnerDms.configured = false;

  try {
    const { initValkey } = require('../db/valkey');
    const { client } = initValkey();
    if (client && typeof client.flushall === 'function') {
      await client.flushall();
    }
  } catch (e) {
    logger.warn(`Valkey FLUSHALL notice: ${e.message}`);
  }

  // 4. Invalidate Warrant Canary
  await invalidateCanary();

  if (failed.length > 0) {
    logger.error(`NeroNuke: global wipe finished with ${failed.length} table(s) not emptied: ${failed.join(', ')}`);
    return { success: false, message: 'Global wipe incomplete', failed_tables: failed };
  }

  logger.warn('NeroNuke: Global cascading disaster wipe completed.');

  return {
    success: true,
    message: 'Global cascading wipe completed'
  };
}

/**
 * Checks all active Dead Man's Switches and scheduled deletions for expiration.
 */
async function checkExpiredDeadManSwitches() {
  await ensureTables();

  // Each expired entry is claimed with an UPDATE that only one caller can win before
  // anything is destroyed. The sweep runs on the elected leader, but a leadership
  // hand-over, a slow tick overlapping the next, or a caller outside the scheduler
  // could otherwise act on the same row twice. A claim that is not followed by a
  // completed destruction is released, so the next tick retries it.
  //
  // Errors are logged. They were swallowed, so a database failure here was
  // indistinguishable from "nothing expired".
  if (!isPostgres()) return;
  const pool = getPgPool();

  // 1. Owner global switch
  try {
    const claimed = await pool.query(
      `UPDATE dead_man_switch SET status = 'triggered'
        WHERE switch_tier = 'owner_global' AND status = 'active' AND next_deadline_at < NOW()
        RETURNING id`
    );
    if (claimed.rowCount > 0) {
      logger.warn('Owner Dead Man Switch expired! Triggering global cascading wipe...');
      await executeOwnerGlobalCascadingWipe();
      return;
    }
  } catch (err) {
    logger.error(`Dead man's switch sweep (owner): ${err.message}`);
  }

  // 2. Personal switches
  try {
    const due = await pool.query(
      `SELECT user_id FROM dead_man_switch
        WHERE switch_tier = 'personal_user' AND status = 'active' AND next_deadline_at < NOW()`
    );
    for (const { user_id: uid } of due.rows) {
      const claim = await pool.query(
        `UPDATE dead_man_switch SET status = 'triggered'
          WHERE user_id = $1 AND switch_tier = 'personal_user' AND status = 'active' AND next_deadline_at < NOW()`,
        [uid]
      );
      if (claim.rowCount === 0) continue; // checked in, or claimed by another run

      logger.info(`Personal Dead Man Switch expired for user ${uid}. Silently wiping account...`);
      try {
        await executeInstantUserDestruction(uid, null, 'dms_timer');
      } catch (err) {
        logger.error(`Could not destroy account ${uid} (dms_timer), retrying next tick: ${err.message}`);
        await pool.query(
          "UPDATE dead_man_switch SET status = 'active' WHERE user_id = $1 AND switch_tier = 'personal_user' AND status = 'triggered'",
          [uid]
        );
      }
    }
  } catch (err) {
    logger.error(`Dead man's switch sweep (personal): ${err.message}`);
  }

  // 3. Scheduled deletions
  try {
    const due = await pool.query(
      'SELECT id, scheduled_deletion_at FROM users WHERE scheduled_deletion_at IS NOT NULL AND scheduled_deletion_at <= NOW()'
    );
    for (const { id: uid, scheduled_deletion_at: at } of due.rows) {
      const claim = await pool.query(
        'UPDATE users SET scheduled_deletion_at = NULL WHERE id = $1 AND scheduled_deletion_at = $2',
        [uid, at]
      );
      if (claim.rowCount === 0) continue;

      logger.info(`Scheduled deletion deadline reached for user ${uid}. Executing wipe...`);
      try {
        await executeInstantUserDestruction(uid, null, 'scheduled_timer');
      } catch (err) {
        logger.error(`Could not destroy account ${uid} (scheduled_timer), retrying next tick: ${err.message}`);
        await pool.query(
          'UPDATE users SET scheduled_deletion_at = $1 WHERE id = $2 AND scheduled_deletion_at IS NULL',
          [at, uid]
        );
      }
    }
  } catch (err) {
    logger.error(`Dead man's switch sweep (scheduled deletions): ${err.message}`);
  }
}

module.exports = {
  ensureTables,
  executeInstantUserDestruction,
  scheduleUserDestruction,
  cancelScheduledUserDestruction,
  getUserNukeStatus,
  setupPersonalDMS,
  unlockPersonalDMS,
  heartbeatPersonalDMS,
  getPersonalDMSStatus,
  setupOwnerDMS,
  heartbeatOwnerDMS,
  getOwnerDMSStatus,
  executeOwnerGlobalCascadingWipe,
  checkExpiredDeadManSwitches
};
