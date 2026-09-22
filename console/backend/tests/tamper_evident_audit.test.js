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
         ip_address, user_agent, metadata_json, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
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
        deletedRow.created_at
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

    await SiemExporter.sendToDestination(
      { protocol: 'udp', endpoint: `127.0.0.1:${port}` },
      syslog,
      sampleEvent
    );

    await receivedPromise;
    server.close();

    assert.ok(receivedMsg.includes('Rogue node keys revoked'));
  });

  it('6. exposes audit verification and SIEM management API endpoints', async () => {
    // GET /api/audit/verify
    const resVerify = await request(app)
      .get('/api/audit/verify')
      .set('Authorization', `Bearer ${superAdminToken}`);

    assert.strictEqual(resVerify.status, 200);
    assert.strictEqual(resVerify.body.verification.valid, true);

    // POST /api/audit/checkpoints
    const resCp = await request(app)
      .post('/api/audit/checkpoints')
      .set('Authorization', `Bearer ${superAdminToken}`);

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
    const resSiem = await request(app)
      .post('/api/audit/siem')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({
        name: 'Enterprise Splunk SIEM',
        protocol: 'udp',
        endpoint: '10.0.0.50:514',
        format: 'rfc5424'
      });

    assert.strictEqual(resSiem.status, 201);
    assert.strictEqual(resSiem.body.destination.name, 'Enterprise Splunk SIEM');

    // GET /api/audit/siem
    const resListSiem = await request(app)
      .get('/api/audit/siem')
      .set('Authorization', `Bearer ${superAdminToken}`);

    assert.strictEqual(resListSiem.status, 200);
    assert.strictEqual(resListSiem.body.destinations.length, 1);
  });
});
