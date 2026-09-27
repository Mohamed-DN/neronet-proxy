/**
 * Tamper-evident audit ledger.
 *
 * Every event carries the HMAC-SHA256 of its content and of the previous event's
 * hash, so an edit, deletion or insertion breaks the chain from that point on.
 * Checkpoints sign the head of the chain with an Ed25519 key, so that truncating the
 * tail, or rewriting the whole chain, is caught as well by anyone holding the public
 * key.
 *
 * Keys. The HMAC key is SOVEREIGN_AUDIT_HMAC_SECRET and is used for nothing else. It
 * used to be the JWT signing secret, so anything able to mint sessions could also
 * rewrite the ledger. The checkpoint key is SOVEREIGN_AUDIT_SIGNING_KEY or, when
 * that is unset, a key generated once and kept in the data directory. It used to be
 * generated per process and each checkpoint was verified against the public key
 * stored in the same row, so a forged checkpoint carried the key that verified it,
 * and every real checkpoint became unverifiable at the next restart.
 *
 * Versions. Each event written by this code records the id of the key that hashed
 * it (hmac_key_id) and uses a canonical form that covers nested metadata; the old
 * form hashed only top-level metadata keys. Events without a key id predate this
 * change: they were keyed with the JWT secret and are accepted only as an unbroken
 * prefix of the chain, and only while SOVEREIGN_AUDIT_ACCEPT_LEGACY is not "false".
 * verifyChain reports how many there are.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { getPgPool } = require('../db/index');
const config = require('../config/env');
const logger = require('../utils/logger');

const GENESIS_HASH = '0'.repeat(64);
const DEFAULT_HMAC_SECRET = config.AUDIT_HMAC_SECRET;

// Serialises appends. SELECT ... ORDER BY ... LIMIT 1 FOR UPDATE does not: a waiter
// re-reads the row it locked, not the new head, so two concurrent appends took the
// same sequence number and one of them was lost to the unique index.
const APPEND_LOCK_ID = 7429201;

/** A short id for a key, from which the key cannot be recovered. */
function keyIdFor(secret) {
  return crypto.createHmac('sha256', secret).update('neronet-audit-hmac-key-id-v1').digest('hex').slice(0, 16);
}

function acceptLegacy() {
  return String(process.env.SOVEREIGN_AUDIT_ACCEPT_LEGACY || 'true').toLowerCase() !== 'false';
}

// ---------------------------------------------------------------------------
// Checkpoint signing key
// ---------------------------------------------------------------------------

let checkpointKeyPair = null;

function keyPairFromPrivate(privateKey) {
  const publicKey = crypto.createPublicKey(privateKey);
  return {
    privateKey,
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString()
  };
}

function getCheckpointKeyPair() {
  if (checkpointKeyPair) return checkpointKeyPair;

  const fromEnv = process.env.SOVEREIGN_AUDIT_SIGNING_KEY;
  if (fromEnv && fromEnv.trim()) {
    const text = fromEnv.trim();
    const privateKey = text.includes('BEGIN')
      ? crypto.createPrivateKey(text)
      : crypto.createPrivateKey({ key: Buffer.from(text, 'base64'), format: 'der', type: 'pkcs8' });
    if (privateKey.asymmetricKeyType !== 'ed25519') {
      throw new Error('SOVEREIGN_AUDIT_SIGNING_KEY must be an Ed25519 private key');
    }
    checkpointKeyPair = keyPairFromPrivate(privateKey);
    return checkpointKeyPair;
  }

  const keyPath = path.join(config.DATA_DIR, 'audit_checkpoint_ed25519.pem');
  if (fs.existsSync(keyPath)) {
    checkpointKeyPair = keyPairFromPrivate(crypto.createPrivateKey(fs.readFileSync(keyPath, 'utf8')));
    return checkpointKeyPair;
  }

  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  try {
    fs.mkdirSync(config.DATA_DIR, { recursive: true });
    fs.writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' });
  } catch (err) {
    if (err.code === 'EEXIST') {
      // Another process created it first; use theirs so both sign with one key.
      checkpointKeyPair = keyPairFromPrivate(crypto.createPrivateKey(fs.readFileSync(keyPath, 'utf8')));
      return checkpointKeyPair;
    }
    logger.error(
      `Could not persist the audit checkpoint key to ${keyPath}: ${err.message}. ` +
        'Checkpoints signed now cannot be verified after a restart; set SOVEREIGN_AUDIT_SIGNING_KEY.'
    );
  }
  checkpointKeyPair = keyPairFromPrivate(privateKey);
  return checkpointKeyPair;
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

/** JSON with object keys sorted at every depth. */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function metadataObject(value) {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch (err) {
      return value;
    }
  }
  // Round-trip first so Dates, undefined and the like look as they will after
  // being stored and read back.
  return JSON.parse(JSON.stringify(value || {}));
}

/**
 * Deterministically serialize audit event fields for hashing.
 */
function canonicalizeEvent(event) {
  const createdAt = event.created_at instanceof Date ? event.created_at.toISOString() : String(event.created_at);

  let metadataStr;
  if (event.hmac_key_id) {
    metadataStr = canonicalJson(metadataObject(event.metadata_json));
  } else {
    // Legacy form. The replacer array filters keys at every depth, so nested
    // metadata was not covered by the hash. Kept only to verify old events.
    metadataStr =
      typeof event.metadata_json === 'string'
        ? event.metadata_json
        : JSON.stringify(event.metadata_json || {}, Object.keys(event.metadata_json || {}).sort());
  }

  const fields = [
    String(event.sequence_num),
    String(event.prev_hash),
    String(event.event_type),
    String(event.severity),
    String(event.actor_user_id || ''),
    String(event.actor_username || ''),
    String(event.target_id || ''),
    String(event.target_type || ''),
    String(event.message || ''),
    String(event.ip_address || ''),
    createdAt,
    metadataStr
  ];
  if (event.hmac_key_id) fields.push(String(event.hmac_key_id));
  return fields.join('|');
}

/**
 * Compute HMAC-SHA256 of the canonical representation.
 */
function computeEventHash(event, secret = DEFAULT_HMAC_SECRET) {
  const canonical = canonicalizeEvent(event);
  return crypto.createHmac('sha256', secret).update(canonical, 'utf8').digest('hex');
}

class AuditChainService {
  /**
   * Append a new tamper-evident audit event to the cryptographic chain.
   */
  static async appendEvent({
    eventType,
    severity = 'info',
    actorUserId = null,
    actorUsername = 'system',
    targetId = null,
    targetType = null,
    message,
    ipAddress = '127.0.0.1',
    userAgent = null,
    metadata = {}
  }) {
    const pool = getPgPool();
    const client = await pool.connect();

    // A checked-out client whose connection drops between queries emits 'error'.
    // With no listener that is an uncaught exception, and the process dies with the
    // database connection: on a failover, or a test dropping its database.
    let connectionError = null;
    const onError = (err) => {
      connectionError = err;
      logger.warn(`Audit ledger connection lost: ${err.message}`);
    };
    client.on('error', onError);

    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1)', [APPEND_LOCK_ID]);

      const lastRes = await client.query(
        `SELECT sequence_num, entry_hash
           FROM audit_events
          WHERE sequence_num IS NOT NULL
          ORDER BY sequence_num DESC
          LIMIT 1`
      );

      let nextSeq = 1;
      let prevHash = GENESIS_HASH;

      if (lastRes.rows.length > 0 && lastRes.rows[0].sequence_num) {
        nextSeq = Number(lastRes.rows[0].sequence_num) + 1;
        prevHash = lastRes.rows[0].entry_hash || GENESIS_HASH;
      }

      const now = new Date();
      const eventRecord = {
        sequence_num: nextSeq,
        prev_hash: prevHash,
        event_type: eventType,
        severity: severity,
        actor_user_id: actorUserId,
        actor_username: actorUsername,
        target_id: targetId,
        target_type: targetType,
        message: message,
        ip_address: ipAddress,
        user_agent: userAgent,
        created_at: now,
        metadata_json: metadataObject(metadata),
        hmac_key_id: keyIdFor(DEFAULT_HMAC_SECRET)
      };

      const entryHash = computeEventHash(eventRecord);
      eventRecord.entry_hash = entryHash;

      const insertRes = await client.query(
        `INSERT INTO audit_events (
           sequence_num, prev_hash, entry_hash,
           event_type, severity, actor_user_id, actor_username,
           target_id, target_type, message, ip_address, user_agent,
           metadata_json, created_at, hmac_key_id
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
         RETURNING *`,
        [
          eventRecord.sequence_num,
          eventRecord.prev_hash,
          eventRecord.entry_hash,
          eventRecord.event_type,
          eventRecord.severity,
          eventRecord.actor_user_id,
          eventRecord.actor_username,
          eventRecord.target_id,
          eventRecord.target_type,
          eventRecord.message,
          eventRecord.ip_address,
          eventRecord.user_agent,
          JSON.stringify(eventRecord.metadata_json),
          eventRecord.created_at,
          eventRecord.hmac_key_id
        ]
      );

      await client.query('COMMIT');
      return insertRes.rows[0];
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.removeListener('error', onError);
      // A broken connection is discarded rather than returned to the pool.
      client.release(connectionError || undefined);
    }
  }

  /**
   * Verify the chain between two sequence numbers (the whole chain by default).
   *
   * Detects modified, deleted and inserted events, a chain that does not start at
   * the genesis hash, legacy events after the first current one, and, against the
   * signed checkpoints, a truncated tail or a chain rewritten from the start.
   */
  static async verifyChain({ fromSequence = 1, toSequence = null, secret = DEFAULT_HMAC_SECRET, pool = null } = {}) {
    const activePool = pool || getPgPool();
    let queryText = `SELECT * FROM audit_events WHERE sequence_num >= $1`;
    const params = [fromSequence];

    if (toSequence !== null) {
      queryText += ` AND sequence_num <= $2`;
      params.push(toSequence);
    }

    queryText += ` ORDER BY sequence_num ASC`;

    const res = await activePool.query(queryText, params);
    const events = res.rows;

    const broken = (seq, row, reason, message, extra = {}) => ({
      valid: false,
      broken_at_sequence: seq,
      broken_event_id: row ? row.id : null,
      reason,
      message,
      ...extra
    });

    // Where the range starts: the genesis hash, or the hash of the event before it.
    let expectedPrevHash = GENESIS_HASH;
    if (fromSequence > 1) {
      const prevRes = await activePool.query('SELECT entry_hash FROM audit_events WHERE sequence_num = $1', [
        fromSequence - 1
      ]);
      if (prevRes.rows.length === 0) {
        return broken(fromSequence - 1, null, 'GAP_IN_SEQUENCE', `Event ${fromSequence - 1} is missing`);
      }
      expectedPrevHash = prevRes.rows[0].entry_hash;
    }

    const currentKeyId = keyIdFor(secret);
    const legacyAllowed = acceptLegacy() && fromSequence === 1;
    let seenCurrent = false;
    let legacyEvents = 0;
    let expectedSeq = fromSequence;

    for (const row of events) {
      const seq = Number(row.sequence_num);

      if (seq !== expectedSeq) {
        return broken(expectedSeq, row, 'GAP_IN_SEQUENCE', `Expected sequence ${expectedSeq}, found ${seq}`);
      }

      if (row.prev_hash !== expectedPrevHash) {
        return broken(seq, row, 'PREV_HASH_MISMATCH', `Previous hash mismatch at sequence ${seq}`, {
          expected_prev_hash: expectedPrevHash,
          actual_prev_hash: row.prev_hash
        });
      }

      let key;
      if (row.hmac_key_id) {
        if (row.hmac_key_id !== currentKeyId) {
          return broken(seq, row, 'UNKNOWN_KEY', `Event ${seq} was hashed with a key this server does not hold`);
        }
        key = secret;
        seenCurrent = true;
      } else {
        // Written before the ledger had its own key. Accepted only as a prefix: a
        // legacy event after a current one can only be a forgery.
        if (!legacyAllowed || seenCurrent || !config.JWT_SECRET) {
          return broken(
            seq,
            row,
            'LEGACY_KEY',
            `Event ${seq} is hashed with the retired key and is not part of a legacy prefix`
          );
        }
        key = config.JWT_SECRET;
        legacyEvents++;
      }

      const computed = computeEventHash(row, key);
      if (row.entry_hash !== computed) {
        return broken(seq, row, 'HASH_TAMPERED', `Tampered event content detected at sequence ${seq}`, {
          expected_hash: computed,
          actual_hash: row.entry_hash
        });
      }

      expectedPrevHash = row.entry_hash;
      expectedSeq++;
    }

    // Anchor against the checkpoints this server signed. Checkpoints whose signature
    // does not verify (signed by a retired key) cannot vouch for anything and are
    // only counted.
    const lastSeq = events.length > 0 ? Number(events[events.length - 1].sequence_num) : fromSequence - 1;
    const bySeq = new Map(events.map((e) => [Number(e.sequence_num), e]));
    const cpRes = await activePool.query(
      'SELECT * FROM audit_checkpoints WHERE last_sequence_num >= $1 ORDER BY last_sequence_num ASC',
      [fromSequence]
    );
    let checkpointsVerified = 0;
    let checkpointsUnverifiable = 0;
    for (const cp of cpRes.rows) {
      const cpSeq = Number(cp.last_sequence_num);
      if (toSequence !== null && cpSeq > toSequence) continue;
      if (!AuditChainService.verifyCheckpoint(cp)) {
        checkpointsUnverifiable++;
        continue;
      }
      if (cpSeq > lastSeq) {
        return broken(
          lastSeq + 1,
          null,
          'TRUNCATED',
          `A signed checkpoint covers event ${cpSeq}, but the chain ends at ${lastSeq}`
        );
      }
      const row = bySeq.get(cpSeq);
      if (!row || row.entry_hash !== cp.checkpoint_hash) {
        return broken(cpSeq, row, 'CHECKPOINT_MISMATCH', `Event ${cpSeq} differs from the signed checkpoint`);
      }
      checkpointsVerified++;
    }

    if (events.length === 0) {
      return {
        valid: true,
        events_count: 0,
        checkpoints_verified: checkpointsVerified,
        checkpoints_unverifiable: checkpointsUnverifiable,
        message: 'No events to verify in specified range'
      };
    }

    return {
      valid: true,
      events_count: events.length,
      first_sequence: Number(events[0].sequence_num),
      last_sequence: lastSeq,
      head_hash: events[events.length - 1].entry_hash,
      legacy_events: legacyEvents,
      checkpoints_verified: checkpointsVerified,
      checkpoints_unverifiable: checkpointsUnverifiable
    };
  }

  /**
   * Sign the current head of the chain and store the checkpoint.
   */
  static async createCheckpoint() {
    const pool = getPgPool();
    const lastRes = await pool.query(
      `SELECT id, sequence_num, entry_hash
         FROM audit_events
        WHERE sequence_num IS NOT NULL
        ORDER BY sequence_num DESC
        LIMIT 1`
    );

    if (lastRes.rows.length === 0) {
      throw new Error('Cannot create checkpoint: audit log is empty');
    }

    const last = lastRes.rows[0];
    const keyPair = getCheckpointKeyPair();

    const dataToSign = Buffer.from(`${last.id}|${last.sequence_num}|${last.entry_hash}`);
    const signature = crypto.sign(null, dataToSign, keyPair.privateKey).toString('hex');

    const res = await pool.query(
      `INSERT INTO audit_checkpoints (
         last_event_id, last_sequence_num, checkpoint_hash, signature, public_key
       ) VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [last.id, last.sequence_num, last.entry_hash, signature, keyPair.publicKey]
    );

    return res.rows[0];
  }

  /**
   * Verify a checkpoint's signature against this server's checkpoint key, or against
   * a public key the caller pins. Never against the key stored in the checkpoint:
   * whoever can write the row can write that too.
   */
  static verifyCheckpoint(checkpoint, publicKeyPem = null) {
    try {
      const dataToVerify = Buffer.from(
        `${checkpoint.last_event_id}|${checkpoint.last_sequence_num}|${checkpoint.checkpoint_hash}`
      );
      const key = publicKeyPem || getCheckpointKeyPair().publicKey;
      return crypto.verify(null, dataToVerify, key, Buffer.from(String(checkpoint.signature), 'hex'));
    } catch (err) {
      return false;
    }
  }

  static getPublicKey() {
    return getCheckpointKeyPair().publicKey;
  }
}

module.exports = {
  AuditChainService,
  computeEventHash,
  canonicalizeEvent,
  keyIdFor,
  GENESIS_HASH
};
