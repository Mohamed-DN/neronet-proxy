const crypto = require('node:crypto');
const { getPgPool } = require('../db/index');
const config = require('../config/env');
const logger = require('../utils/logger');

const GENESIS_HASH = '0'.repeat(64);
const DEFAULT_HMAC_SECRET = config.JWT_SECRET || 'neronet-audit-chain-default-secret-v4';

// Checkpoint signing keypair (cached in memory)
let checkpointKeyPair = null;

function getCheckpointKeyPair() {
  if (!checkpointKeyPair) {
    checkpointKeyPair = crypto.generateKeyPairSync('ed25519', {
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
    });
  }
  return checkpointKeyPair;
}

/**
 * Deterministically serialize audit event fields for hashing.
 */
function canonicalizeEvent(event) {
  const metadataStr =
    typeof event.metadata_json === 'string'
      ? event.metadata_json
      : JSON.stringify(event.metadata_json || {}, Object.keys(event.metadata_json || {}).sort());

  const createdAt = event.created_at instanceof Date ? event.created_at.toISOString() : String(event.created_at);

  return [
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
  ].join('|');
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

    try {
      await client.query('BEGIN');

      // 1. Fetch latest event with row-level lock to prevent concurrent forks
      const lastRes = await client.query(
        `SELECT sequence_num, entry_hash
           FROM audit_events
          ORDER BY sequence_num DESC NULLS LAST, id DESC
          LIMIT 1
          FOR UPDATE`
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
        metadata_json: metadata
      };

      const entryHash = computeEventHash(eventRecord);
      eventRecord.entry_hash = entryHash;

      const insertRes = await client.query(
        `INSERT INTO audit_events (
           sequence_num, prev_hash, entry_hash,
           event_type, severity, actor_user_id, actor_username,
           target_id, target_type, message, ip_address, user_agent,
           metadata_json, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
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
          eventRecord.created_at
        ]
      );

      await client.query('COMMIT');
      return insertRes.rows[0];
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Verify the cryptographic audit chain integrity.
   * Detects modified rows, deleted rows, inserted rows, and sequence gaps.
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

    if (events.length === 0) {
      return {
        valid: true,
        events_count: 0,
        message: 'No events to verify in specified range'
      };
    }

    let expectedSeq = fromSequence;
    let expectedPrevHash = events[0].prev_hash; // initial anchor

    for (let i = 0; i < events.length; i++) {
      const row = events[i];
      const seq = Number(row.sequence_num);

      // Check 1: Contiguous sequence numbers (detects deletions)
      if (seq !== expectedSeq) {
        return {
          valid: false,
          broken_at_sequence: expectedSeq,
          broken_event_id: row.id,
          reason: 'GAP_IN_SEQUENCE',
          message: `Expected sequence ${expectedSeq}, found ${seq}`
        };
      }

      // Check 2: Hash chain linkage
      if (row.prev_hash !== expectedPrevHash) {
        return {
          valid: false,
          broken_at_sequence: seq,
          broken_event_id: row.id,
          reason: 'PREV_HASH_MISMATCH',
          expected_prev_hash: expectedPrevHash,
          actual_prev_hash: row.prev_hash,
          message: `Previous hash mismatch at sequence ${seq}`
        };
      }

      // Check 3: HMAC verification of row contents (detects tampering/modifications)
      const computed = computeEventHash(row, secret);
      if (row.entry_hash !== computed) {
        return {
          valid: false,
          broken_at_sequence: seq,
          broken_event_id: row.id,
          reason: 'HASH_TAMPERED',
          expected_hash: computed,
          actual_hash: row.entry_hash,
          message: `Tampered event content detected at sequence ${seq}`
        };
      }

      expectedPrevHash = row.entry_hash;
      expectedSeq++;
    }

    return {
      valid: true,
      events_count: events.length,
      first_sequence: Number(events[0].sequence_num),
      last_sequence: Number(events[events.length - 1].sequence_num),
      head_hash: events[events.length - 1].entry_hash
    };
  }

  /**
   * Create and store a cryptographically signed audit checkpoint.
   */
  static async createCheckpoint() {
    const pool = getPgPool();
    const lastRes = await pool.query(
      `SELECT id, sequence_num, entry_hash
         FROM audit_events
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
    const pubKeyPem = keyPair.publicKey;

    const res = await pool.query(
      `INSERT INTO audit_checkpoints (
         last_event_id, last_sequence_num, checkpoint_hash, signature, public_key
       ) VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [last.id, last.sequence_num, last.entry_hash, signature, pubKeyPem]
    );

    return res.rows[0];
  }

  /**
   * Verify an existing audit checkpoint signature.
   */
  static verifyCheckpoint(checkpoint) {
    const dataToVerify = Buffer.from(
      `${checkpoint.last_event_id}|${checkpoint.last_sequence_num}|${checkpoint.checkpoint_hash}`
    );
    const pubKeyPem = checkpoint.public_key;
    const signatureBuf = Buffer.from(checkpoint.signature, 'hex');

    return crypto.verify(null, dataToVerify, pubKeyPem, signatureBuf);
  }

  static getPublicKey() {
    return getCheckpointKeyPair().publicKey;
  }
}

module.exports = {
  AuditChainService,
  computeEventHash,
  canonicalizeEvent,
  GENESIS_HASH
};
