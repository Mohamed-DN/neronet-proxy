const { describe, it, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { setupTestDatabase } = require('./helpers/db');
const { issueConsoleTestToken } = require('./helpers/consoleSession');
const { appendHistoricalV2 } = require('./helpers/auditCanonicalV2');
const { AuditChainService } = require('../services/AuditChainService');
const { createApp } = require('../server');
const { settleAuditWrites } = require('../utils/audit');

describe('Signed organization attribution preserves audit content integrity', () => {
  let db, app, token;
  const orgA = 'org-audit-signature-a',
    orgB = 'org-audit-signature-b';
  before(async () => {
    db = await setupTestDatabase();
    assert.match(db.dbName, /^neronet_t_/);
    for (const org of [orgA, orgB])
      await db.pool.query('INSERT INTO organizations(id,name,slug) VALUES($1,$1,$1)', [org]);
    app = createApp();
    token = await issueConsoleTestToken((await db.pool.query("SELECT * FROM users WHERE id='usr-admin'")).rows[0]);
  });
  beforeEach(async () => {
    assert.equal((await db.pool.query('SELECT current_database() AS name')).rows[0].name, db.dbName);
    await settleAuditWrites();
    await db.pool.query('DELETE FROM audit_checkpoints');
    await db.pool.query('DELETE FROM audit_events');
  });
  after(async () => {
    if (db) await db.cleanup();
  });

  async function append(organizationId = orgA) {
    return AuditChainService.appendEvent({
      eventType: 'AUDIT_ORGANIZATION_PROBE',
      organizationId,
      message: 'Measured organization attribution',
      actorUserId: 'usr-admin',
      metadata: { n: 0.1 }
    });
  }
  async function verify(range = {}) {
    const response = await request(app).get('/api/audit/verify').query(range).auth(token, { type: 'bearer' });
    assert.equal(response.status, 200);
    return response.body.verification;
  }
  async function rejected(reason, sequence, range) {
    const report = await verify(range);
    assert.equal(report.valid, false);
    assert.equal(report.reason, reason);
    assert.equal(Number(report.broken_at_sequence), Number(sequence));
  }

  it('reports v3 content coverage separately from organization attribution', async () => {
    const event = await append();
    assert.equal(event.canonical_version, 3);
    await append(null);
    const report = await verify();
    assert.equal(report.valid, true);
    assert.equal(report.integrity_profile, 'canonical-v3');
    assert.equal(report.canonical_v2_events, 0);
    assert.equal(report.canonical_v3_events, 2);
    assert.equal(report.organization_attributed_events, 1);
    assert.equal(report.unattributed_events, 1);
    assert.equal(report.highest_canonical_version, 3);
  });

  for (const replacement of [orgB, null, '']) {
    it(`detects an organization-only change to ${replacement === null ? 'null' : JSON.stringify(replacement)}`, async () => {
      const event = await append();
      await AuditChainService.createCheckpoint();
      assert.equal((await verify()).valid, true);
      await db.pool.query('UPDATE audit_events SET organization_id=$2 WHERE id=$1', [event.id, replacement]);
      await rejected('HASH_TAMPERED', event.sequence_num);
      await db.pool.query('UPDATE audit_events SET organization_id=$2 WHERE id=$1', [event.id, orgA]);
      assert.equal((await verify()).valid, true);
    });
  }

  it('does not guess a tenant from the actor, metadata, or target when context is omitted', async () => {
    const row = await AuditChainService.appendEvent({
      eventType: 'AUDIT_SCOPE_UNKNOWN',
      actorUserId: 'usr-admin',
      targetId: orgA,
      message: orgA,
      metadata: { organization_id: orgA }
    });
    assert.equal(row.organization_id, null);
    assert.equal((await verify()).unattributed_events, 1);
  });

  it('rejects a correctly signed historical v2 after v3 across full, boundary and prefix ranges', async () => {
    await append();
    const downgrade = await appendHistoricalV2(db.pool);
    await append();
    for (const range of [{}, { from: 2, to: 2 }, { from: 3 }, { from: 2 }])
      await rejected('CANONICAL_DOWNGRADE', downgrade.sequence_num, range);
    assert.equal((await verify({ to: 1 })).valid, true);
  });

  it('keeps SQL numeric precision verification for v2 when v3 follows it', async () => {
    const historical = await appendHistoricalV2(db.pool, { metadataText: '{"n":0.100000000000000005}' });
    await append();
    const control = await verify();
    assert.equal(control.valid, true);
    assert.equal(control.canonical_v2_events, 1);
    assert.equal(control.canonical_v3_events, 1);
    await db.pool.query('UPDATE audit_events SET metadata_json=$2::jsonb WHERE id=$1', [historical.id, '{"n":0.1}']);
    await rejected('HASH_TAMPERED', historical.sequence_num);
  });

  it('refuses attribution on unsigned historical formats at both schema and verifier boundaries', async () => {
    const historical = await appendHistoricalV2(db.pool);
    await assert.rejects(
      db.pool.query('UPDATE audit_events SET organization_id=$2 WHERE id=$1', [historical.id, orgA]),
      { code: '23514' }
    );
    // Exercise defense against a database actor that can also remove this CHECK.
    await db.pool.query('ALTER TABLE audit_events DROP CONSTRAINT audit_events_organization_signed_check');
    try {
      await db.pool.query('UPDATE audit_events SET organization_id=$2 WHERE id=$1', [historical.id, orgA]);
      await rejected('UNSIGNED_ORGANIZATION', historical.sequence_num);
    } finally {
      await db.pool.query('UPDATE audit_events SET organization_id=NULL WHERE id=$1', [historical.id]);
      await db.pool.query(
        'ALTER TABLE audit_events ADD CONSTRAINT audit_events_organization_signed_check CHECK (organization_id IS NULL OR canonical_version=3)'
      );
    }
    assert.equal((await verify()).valid, true);
  });
});
