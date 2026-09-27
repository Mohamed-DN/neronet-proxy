const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const dgram = require('node:dgram');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const { setupTestDatabase } = require('./helpers/db');
const { createApp } = require('../server');
const config = require('../config/env');
const { logAuditEvent } = require('../utils/audit');
const { AuditChainService, GENESIS_HASH } = require('../services/AuditChainService');
const { formatSyslogRFC5424, SiemExporter } = require('../services/SiemExporter');

describe('WP-301: Tamper-Evident Audit Log & SIEM Export', () => {
  let dbHelper;
  let pool;
  let app;
  let superAdminToken;

  before(async () => {
    dbHelper = await setupTestDatabase();
    pool = dbHelper.pool;
    app = createApp();

    // Clean audit tables
    await pool.query('DELETE FROM audit_checkpoints');
    await pool.query('DELETE FROM audit_events');
    await pool.query('DELETE FROM audit_siem_destinations');

    superAdminToken = jwt.sign(
      { id: 'usr-audit-admin', username: 'auditadmin', role: 'super-admin' },
      config.JWT_SECRET,
      { expiresIn: '1h' }
    );
  });

  after(async () => {
    if (dbHelper) await dbHelper.cleanup();
  });

  it('1. writes sequentially hash-chained audit events with valid HMAC', async () => {
    const ev1 = await logAuditEvent({
      eventType: 'NODE_REGISTERED',
      severity: 'info',
      actorUsername: 'operator1',
      targetId: 'node-alpha',
      message: 'Node registered'
    });

    assert.ok(ev1);
    assert.strictEqual(Number(ev1.sequence_num), 1);
    assert.strictEqual(ev1.prev_hash, GENESIS_HASH);
    assert.ok(ev1.entry_hash);

    const ev2 = await logAuditEvent({
      eventType: 'NODE_APPROVED',
      severity: 'info',
      actorUsername: 'operator1',
      targetId: 'node-alpha',
      message: 'Node approved'
    });

    assert.ok(ev2);
    assert.strictEqual(Number(ev2.sequence_num), 2);
    assert.strictEqual(ev2.prev_hash, ev1.entry_hash);

    const ev3 = await logAuditEvent({
      eventType: 'POLICY_UPDATED',
      severity: 'warn',
      actorUsername: 'secops',
      targetId: 'policy-default',
      message: 'Default policy changed to deny'
    });

    assert.ok(ev3);
    assert.strictEqual(Number(ev3.sequence_num), 3);
    assert.strictEqual(ev3.prev_hash, ev2.entry_hash);

    const verification = await AuditChainService.verifyChain();
    assert.strictEqual(verification.valid, true);
    assert.strictEqual(verification.events_count, 3);
    assert.strictEqual(verification.first_sequence, 1);
    assert.strictEqual(verification.last_sequence, 3);
  });

  it('2. detects in-place row tampering in PostgreSQL directly', async () => {
    // Tamper with the message of event 2 in the database directly
    await pool.query("UPDATE audit_events SET message = 'MALICIOUS_TAMPERED_MESSAGE' WHERE sequence_num = 2");

    const verification = await AuditChainService.verifyChain();
    assert.strictEqual(verification.valid, false);
    assert.strictEqual(verification.broken_at_sequence, 2);
    assert.strictEqual(verification.reason, 'HASH_TAMPERED');

    // Restore valid message for subsequent tests
    const ev2Expected = (await pool.query('SELECT * FROM audit_events WHERE sequence_num = 2')).rows[0];
    ev2Expected.message = 'Node approved';
    const { computeEventHash } = require('../services/AuditChainService');
    const validHash = computeEventHash(ev2Expected);
    await pool.query('UPDATE audit_events SET message = $1, entry_hash = $2 WHERE sequence_num = 2', [
      'Node approved',
      validHash
    ]);

    const verifiedAgain = await AuditChainService.verifyChain();
    assert.strictEqual(verifiedAgain.valid, true);
  });

  it('3. detects row deletion directly in database by sequence gap', async () => {
    // Add event 4
    await logAuditEvent({
      eventType: 'SECRET_ROTATED',
      severity: 'info',
      message: 'Secret rotated'
    });

    // Delete event 3
    const deletedRow = (await pool.query('DELETE FROM audit_events WHERE sequence_num = 3 RETURNING *')).rows[0];

    const verification = await AuditChainService.verifyChain();
    assert.strictEqual(verification.valid, false);
    assert.strictEqual(verification.broken_at_sequence, 3);
    assert.strictEqual(verification.reason, 'GAP_IN_SEQUENCE');

    // Re-insert deleted row with exact columns to restore clean chain state
    await pool.query(
      `INSERT INTO audit_events (
         id, sequence_num, prev_hash, entry_hash, event_type, severity,
         actor_user_id, actor_username, target_id, target_type, message,
         ip_address, user_agent, metadata_json, created_at, hmac_key_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
      [
        deletedRow.id,
        deletedRow.sequence_num,
        deletedRow.prev_hash,
        deletedRow.entry_hash,
        deletedRow.event_type,
        deletedRow.severity,
        deletedRow.actor_user_id,
        deletedRow.actor_username,
        deletedRow.target_id,
        deletedRow.target_type,
        deletedRow.message,
        deletedRow.ip_address,
        deletedRow.user_agent,
        JSON.stringify(deletedRow.metadata_json),
        deletedRow.created_at,
        deletedRow.hmac_key_id
      ]
    );

    const verified = await AuditChainService.verifyChain();
    assert.strictEqual(verified.valid, true, `Verification failed after restoring row: ${JSON.stringify(verified)}`);
  });

  it('4. creates and verifies signed cryptographic checkpoints', async () => {
    const checkpoint = await AuditChainService.createCheckpoint();
    assert.ok(checkpoint);
    assert.ok(checkpoint.id);
    assert.ok(checkpoint.signature);
    assert.ok(checkpoint.public_key);

    const isValid = AuditChainService.verifyCheckpoint(checkpoint);
    assert.strictEqual(isValid, true, 'Checkpoint signature must verify with mesh public key');
  });

  it('5. formats RFC 5424 compliant syslog messages and sends to UDP mock collector', async () => {
    const sampleEvent = {
      sequence_num: 42,
      event_type: 'NODE_REVOCATION',
      severity: 'critical',
      actor_username: 'admin',
      target_id: 'node-rogue',
      message: 'Rogue node keys revoked',
      entry_hash: 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
      created_at: new Date()
    };

    const syslog = formatSyslogRFC5424(sampleEvent, { hostname: 'control-plane-01' });
    assert.ok(syslog.startsWith('<10>1 ')); // facility 1 (8) + crit (2) = 10
    assert.ok(syslog.includes('NODE_REVOCATION'));
    assert.ok(syslog.includes('seq="42"'));
    assert.ok(syslog.includes('hash="abcdef1234567890'));

    // Test sending to mock UDP socket
    const server = dgram.createSocket('udp4');
    await new Promise((resolve) => server.bind(0, '127.0.0.1', resolve));
    const port = server.address().port;

    let receivedMsg = '';
    const receivedPromise = new Promise((resolve) => {
      server.on('message', (msg) => {
        receivedMsg = msg.toString('utf8');
        resolve();
      });
    });

    await SiemExporter.sendToDestination({ protocol: 'udp', endpoint: `127.0.0.1:${port}` }, syslog, sampleEvent);

    await receivedPromise;
    server.close();

    assert.ok(receivedMsg.includes('Rogue node keys revoked'));
  });

  it('6. exposes audit verification and SIEM management API endpoints', async () => {
    // GET /api/audit/verify
    const resVerify = await request(app).get('/api/audit/verify').set('Authorization', `Bearer ${superAdminToken}`);

    assert.strictEqual(resVerify.status, 200);
    assert.strictEqual(resVerify.body.verification.valid, true);

    // POST /api/audit/checkpoints
    const resCp = await request(app).post('/api/audit/checkpoints').set('Authorization', `Bearer ${superAdminToken}`);

    assert.strictEqual(resCp.status, 201);
    assert.ok(resCp.body.checkpoint.signature);

    // GET /api/audit/checkpoints
    const resListCp = await request(app)
      .get('/api/audit/checkpoints')
      .set('Authorization', `Bearer ${superAdminToken}`);

    assert.strictEqual(resListCp.status, 200);
    assert.ok(resListCp.body.checkpoints.length >= 1);
    assert.ok(resListCp.body.public_key);

    // POST /api/audit/siem
    const resSiem = await request(app).post('/api/audit/siem').set('Authorization', `Bearer ${superAdminToken}`).send({
      name: 'Enterprise Splunk SIEM',
      protocol: 'udp',
      endpoint: '10.0.0.50:514',
      format: 'rfc5424'
    });

    assert.strictEqual(resSiem.status, 201);
    assert.strictEqual(resSiem.body.destination.name, 'Enterprise Splunk SIEM');

    // GET /api/audit/siem
    const resListSiem = await request(app).get('/api/audit/siem').set('Authorization', `Bearer ${superAdminToken}`);

    assert.strictEqual(resListSiem.status, 200);
    assert.strictEqual(resListSiem.body.destinations.length, 1);
  });
  describe('keys, checkpoints and concurrency', () => {
    const crypto = require('node:crypto');
    const { computeEventHash } = require('../services/AuditChainService');

    async function freshLedger() {
      await pool.query('DELETE FROM audit_checkpoints');
      await pool.query('DELETE FROM audit_siem_destinations');
      await pool.query('DELETE FROM audit_events');
      for (let i = 1; i <= 3; i++) {
        await logAuditEvent({
          eventType: 'TEST_EVENT',
          message: `event ${i}`,
          metadata: { step: i, nested: { a: i } }
        });
      }
    }

    it('does not accept an event rehashed with the session signing key', async () => {
      await freshLedger();
      const row = (await pool.query('SELECT * FROM audit_events WHERE sequence_num = 2')).rows[0];
      row.message = 'rewritten by someone holding the JWT secret';
      const forged = computeEventHash(row, config.JWT_SECRET);
      await pool.query('UPDATE audit_events SET message = $1, entry_hash = $2 WHERE sequence_num = 2', [
        row.message,
        forged
      ]);

      const result = await AuditChainService.verifyChain();
      assert.strictEqual(result.valid, false);
      assert.strictEqual(result.broken_at_sequence, 2);
    });

    it('covers nested metadata', async () => {
      await freshLedger();
      await pool.query(
        `UPDATE audit_events SET metadata_json = jsonb_set(metadata_json, '{nested,a}', '99') WHERE sequence_num = 2`
      );

      const result = await AuditChainService.verifyChain();
      assert.strictEqual(result.valid, false);
      assert.strictEqual(result.reason, 'HASH_TAMPERED');
    });

    it('rejects a checkpoint signed with any key but its own', async () => {
      await freshLedger();
      const real = await AuditChainService.createCheckpoint();
      assert.strictEqual(AuditChainService.verifyCheckpoint(real), true);

      // Whoever can write the table can also sign with a key of their own and store
      // its public half in the same row. That must not verify.
      const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
      const data = Buffer.from(`${real.last_event_id}|${real.last_sequence_num}|${'f'.repeat(64)}`);
      const forged = {
        ...real,
        checkpoint_hash: 'f'.repeat(64),
        signature: crypto.sign(null, data, privateKey).toString('hex'),
        public_key: publicKey.export({ type: 'spki', format: 'pem' })
      };
      assert.strictEqual(AuditChainService.verifyCheckpoint(forged), false);
    });

    it('detects a truncated tail below a signed checkpoint', async () => {
      await freshLedger();
      await AuditChainService.createCheckpoint();
      await pool.query('DELETE FROM audit_events WHERE sequence_num = 3');

      const result = await AuditChainService.verifyChain();
      assert.strictEqual(result.valid, false);
      assert.strictEqual(result.reason, 'TRUNCATED');
    });

    it('detects a chain rewritten from the start under a signed checkpoint', async () => {
      await freshLedger();
      await AuditChainService.createCheckpoint();

      // Rewrite every event consistently with the real HMAC key: the chain itself
      // verifies, only the checkpoint can tell.
      const rows = (await pool.query('SELECT * FROM audit_events ORDER BY sequence_num')).rows;
      let prev = rows[0].prev_hash;
      for (const row of rows) {
        row.prev_hash = prev;
        row.message = `${row.message} (rewritten)`;
        row.entry_hash = computeEventHash(row);
        await pool.query('UPDATE audit_events SET message = $1, prev_hash = $2, entry_hash = $3 WHERE id = $4', [
          row.message,
          row.prev_hash,
          row.entry_hash,
          row.id
        ]);
        prev = row.entry_hash;
      }

      const result = await AuditChainService.verifyChain();
      assert.strictEqual(result.valid, false);
      assert.strictEqual(result.reason, 'CHECKPOINT_MISMATCH');
    });

    it('keeps every event when many are written at once', async () => {
      await freshLedger();
      await Promise.all(
        Array.from({ length: 25 }, (_, i) => logAuditEvent({ eventType: 'CONCURRENT', message: `c${i}` }))
      );

      const count = Number((await pool.query('SELECT count(*) AS n FROM audit_events')).rows[0].n);
      assert.strictEqual(count, 28, 'no event may be lost to a sequence collision');
      const result = await AuditChainService.verifyChain();
      assert.strictEqual(result.valid, true, JSON.stringify(result));
    });

    it('accepts events from before the dedicated key only as a prefix', async () => {
      await pool.query('DELETE FROM audit_checkpoints');
      await pool.query('DELETE FROM audit_events');

      // Two events as the previous code wrote them: no key id, keyed with the JWT secret.
      const { GENESIS_HASH: genesis } = require('../services/AuditChainService');
      let prev = genesis;
      for (let seq = 1; seq <= 2; seq++) {
        const row = {
          sequence_num: seq,
          prev_hash: prev,
          event_type: 'LEGACY',
          severity: 'info',
          actor_user_id: null,
          actor_username: 'system',
          target_id: null,
          target_type: null,
          message: `legacy ${seq}`,
          ip_address: '127.0.0.1',
          created_at: new Date(),
          metadata_json: {}
        };
        row.entry_hash = computeEventHash(row, config.JWT_SECRET);
        await pool.query(
          `INSERT INTO audit_events (sequence_num, prev_hash, entry_hash, event_type, severity, actor_username,
                                     message, ip_address, metadata_json, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, '{}'::jsonb, $9)`,
          [
            seq,
            row.prev_hash,
            row.entry_hash,
            row.event_type,
            row.severity,
            row.actor_username,
            row.message,
            row.ip_address,
            row.created_at
          ]
        );
        prev = row.entry_hash;
      }
      await logAuditEvent({ eventType: 'CURRENT', message: 'after the upgrade' });

      const ok = await AuditChainService.verifyChain();
      assert.strictEqual(ok.valid, true, JSON.stringify(ok));
      assert.strictEqual(ok.legacy_events, 2);

      // A legacy-style event appended after a current one is a forgery.
      const head = (await pool.query('SELECT * FROM audit_events ORDER BY sequence_num DESC LIMIT 1')).rows[0];
      const forged = {
        sequence_num: Number(head.sequence_num) + 1,
        prev_hash: head.entry_hash,
        event_type: 'FORGED',
        severity: 'info',
        actor_user_id: null,
        actor_username: 'system',
        target_id: null,
        target_type: null,
        message: 'inserted with the JWT secret',
        ip_address: '127.0.0.1',
        created_at: new Date(),
        metadata_json: {}
      };
      forged.entry_hash = computeEventHash(forged, config.JWT_SECRET);
      await pool.query(
        `INSERT INTO audit_events (sequence_num, prev_hash, entry_hash, event_type, severity, actor_username,
                                   message, ip_address, metadata_json, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, '{}'::jsonb, $9)`,
        [
          forged.sequence_num,
          forged.prev_hash,
          forged.entry_hash,
          forged.event_type,
          forged.severity,
          forged.actor_username,
          forged.message,
          forged.ip_address,
          forged.created_at
        ]
      );

      const bad = await AuditChainService.verifyChain();
      assert.strictEqual(bad.valid, false);
      assert.strictEqual(bad.reason, 'LEGACY_KEY');
    });
  });
});
