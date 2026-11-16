// ADR 0033, NeroDrop phase 0: members of one organisation send each other files. The
// browser encrypts; the console keeps only metadata and signs short-lived tickets the
// organisation's default profile gateway honours; the gateway keeps the ciphertext.
const { issueConsoleTestToken } = require('./helpers/consoleSession');
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const request = require('supertest');
const { setupTestDatabase } = require('./helpers/db');
const { createApp } = require('../server');

const X25519_PKCS8 = Buffer.from('302e020100300506032b656e04220420', 'hex');
const x25519Private = (raw) =>
  crypto.createPrivateKey({ key: Buffer.concat([X25519_PKCS8, raw]), format: 'der', type: 'pkcs8' });
const rawPublic = (privateKey) => {
  const der = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  return Buffer.from(der.subarray(der.length - 32));
};

// What the gateway does (pkg/drop): derive the key from its own private key and the
// control plane's public key, then check the HMAC.
function gatewayVerifies(ticket, nodePrivateRaw, cpPublicHex) {
  const publicKey = cpPublicKeyObject(cpPublicHex);
  const shared = crypto.diffieHellman({ privateKey: x25519Private(nodePrivateRaw), publicKey });
  const key = Buffer.from(
    crypto.hkdfSync('sha256', shared, Buffer.alloc(0), Buffer.from('neronet/v4/drop-ticket'), 32)
  );
  const [payload, mac] = ticket.split('.');
  const expected = crypto.createHmac('sha256', key).update(`nerodrop-ticket-v1.${payload}`).digest('base64url');
  assert.strictEqual(mac, expected, 'the gateway cannot verify the ticket');
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
}

function cpPublicKeyObject(hex) {
  return crypto.createPublicKey({
    key: Buffer.concat([Buffer.from('302a300506032b656e032100', 'hex'), Buffer.from(hex, 'hex')]),
    format: 'der',
    type: 'spki'
  });
}

describe('ADR 0033: NeroDrop tickets and metadata', () => {
  const ControlPlaneKeyService = require('../services/ControlPlaneKeyService');
  const DropService = require('../services/DropService');
  let dbHelper;
  let pool;
  let app;
  const org = 'org-drop';
  const otherOrg = 'org-drop-other';
  const gatewayPrivate = crypto.randomBytes(32);
  const tokens = {};
  const auth = (who) => ({ Authorization: `Bearer ${tokens[who]}` });
  const MARKER = 'segreto-piano-NERODROP-7f3a.pdf';

  before(async () => {
    dbHelper = await setupTestDatabase();
    pool = dbHelper.pool;
    app = createApp();
    await pool.query(
      `INSERT INTO organizations (id, name, slug, default_policy) VALUES
         ($1, 'Drop', 'drop', 'deny'), ($2, 'Drop other', 'drop-other', 'deny')`,
      [org, otherOrg]
    );
    await pool.query(
      `INSERT INTO users (id, username, email, password_hash, role, organization_id, status) VALUES
         ('usr-drop-admin', 'dropadmin', 'da@drop.example', 'x', 'admin', $1, 'active'),
         ('usr-drop-anna', 'anna', 'anna@drop.example', 'x', 'user', $1, 'active'),
         ('usr-drop-bruno', 'bruno', 'bruno@drop.example', 'x', 'user', $1, 'active'),
         ('usr-drop-carla', 'carla', 'carla@drop.example', 'x', 'user', $1, 'active'),
         ('usr-drop-aud', 'dropaudit', 'aud@drop.example', 'x', 'auditor', $1, 'active'),
         ('usr-drop-gone', 'gone', 'gone@drop.example', 'x', 'user', $1, 'suspended'),
         ('usr-drop-out', 'outsider', 'out@other.example', 'x', 'admin', $2, 'active')`,
      [org, otherOrg]
    );
    await pool.query(
      `INSERT INTO nodes (id, organization_id, user_id, name, overlay_ipv4, overlay_ipv6, public_key, role,
                          is_healthy, is_quarantined, profile_gateway_endpoint, is_default_profile_gateway, node_capabilities)
       VALUES ('node-drop-gw', $1, 'usr-drop-admin', 'home', '100.64.70.1', 'fd00:70::1', $2, 'CLIENT_ORIGIN',
               TRUE, FALSE, 'gw.example:51820', TRUE, '{derp-v2,drop-v1}'),
              ('node-drop-gw-other', $3, 'usr-drop-out', 'other', '100.64.70.2', 'fd00:70::2', $4, 'CLIENT_ORIGIN',
               TRUE, FALSE, 'gw2.example:51820', TRUE, '{derp-v2,drop-v1}')`,
      [org, rawPublic(x25519Private(gatewayPrivate)).toString('hex'), otherOrg, crypto.randomBytes(32).toString('hex')]
    );
    for (const [who, id, username, role, o] of [
      ['admin', 'usr-drop-admin', 'dropadmin', 'admin', org],
      ['anna', 'usr-drop-anna', 'anna', 'user', org],
      ['bruno', 'usr-drop-bruno', 'bruno', 'user', org],
      ['carla', 'usr-drop-carla', 'carla', 'user', org],
      ['auditor', 'usr-drop-aud', 'dropaudit', 'auditor', org],
      ['outsider', 'usr-drop-out', 'outsider', 'admin', otherOrg]
    ]) {
      tokens[who] = await issueConsoleTestToken({ sub: id, id, username, role, organization_id: o });
    }
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM drop_transfers');
    await pool.query('UPDATE organizations SET drop_enabled = TRUE WHERE id IN ($1, $2)', [org, otherOrg]);
    await pool.query(
      `UPDATE nodes SET node_capabilities = '{derp-v2,drop-v1}', profile_gateway_endpoint = 'gw.example:51820'
        WHERE id = 'node-drop-gw'`
    );
  });

  after(async () => {
    if (dbHelper) await dbHelper.cleanup();
  });

  const create = (who, body) =>
    request(app)
      .post('/api/drop/transfers')
      .set(auth(who))
      .send({ recipient_id: 'usr-drop-bruno', ciphertext_bytes: 5_243_920, one_time: false, ...body });
  const sendOne = async (body = {}) => {
    const res = await create('anna', body);
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    const sent = await request(app).post(`/api/drop/transfers/${res.body.id}/sent`).set(auth('anna'));
    assert.strictEqual(sent.status, 200);
    return res.body;
  };

  it('signs the same ticket as the gateway expects (shared vector with pkg/drop)', () => {
    const cp = x25519Private(Buffer.alloc(32, 0x11));
    const nodePublic = '0faa684ed28867b97f4a6a2dee5df8ce974e76b7018e3f22a1c4cf2678570f20';
    const key = DropService.ticketKeyFrom(cp, nodePublic);
    assert.strictEqual(key.toString('hex'), '68a74ead287e671031c31bdb568da900eeb1d5e58a47a5434e76eccf56c91e53');
    const ticket = DropService.signTicket(
      {
        v: 1,
        op: 'put',
        id: '0123456789abcdef0123456789abcdef',
        gw: 'node-gw-1',
        n: 5243920,
        exp: 2000000000,
        del: 2000086400,
        once: true
      },
      key
    );
    assert.strictEqual(
      ticket,
      'eyJ2IjoxLCJvcCI6InB1dCIsImlkIjoiMDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWYiLCJndyI6Im5vZGUtZ3ctMSIsIm4iOjUyNDM5MjAsImV4cCI6MjAwMDAwMDAwMCwiZGVsIjoyMDAwMDg2NDAwLCJvbmNlIjp0cnVlfQ.rk1UxFcHW6WxDOAihVhpbZKZY7zXNydUhpBT5piYl4I'
    );
  });

  it('answers what the page needs: enabled, a mailbox, the size limit', async () => {
    const res = await request(app).get('/api/drop/config').set(auth('anna'));
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.enabled, true);
    assert.strictEqual(res.body.available, true);
    assert.strictEqual(res.body.may_send, true);
    assert.strictEqual(res.body.can_manage, false);
    assert.strictEqual(res.body.lifetime_hours, 24);
    assert.ok(res.body.max_bytes >= 1 << 20);
    const admin = await request(app).get('/api/drop/config').set(auth('admin'));
    assert.strictEqual(admin.body.can_manage, true);
  });

  it('needs a signed-in user', async () => {
    assert.strictEqual((await request(app).get('/api/drop/config')).status, 401);
    assert.strictEqual((await request(app).post('/api/drop/transfers').send({})).status, 401);
  });

  it('lists the active members of the organisation as recipients, nobody else', async () => {
    const res = await request(app).get('/api/drop/recipients').set(auth('anna'));
    assert.strictEqual(res.status, 200);
    const names = res.body.recipients.map((r) => r.username).sort();
    assert.deepStrictEqual(names, ['anna', 'bruno', 'carla', 'dropadmin', 'dropaudit']);
    assert.ok(res.body.recipients.every((r) => Object.keys(r).sort().join() === 'id,username'));
  });

  it('issues an upload ticket bound to the transfer, the size, the direction and the default gateway', async () => {
    const before = Math.floor(Date.now() / 1000);
    const res = await create('anna', { one_time: true });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    assert.match(res.body.id, /^[0-9a-f]{32}$/);
    assert.match(res.body.short_code, /^[0-9A-F]{4}-[0-9A-F]{4}$/);
    assert.strictEqual(res.body.upload.url, `/drop-blob/${res.body.id}`);
    const claims = gatewayVerifies(
      res.body.upload.ticket,
      gatewayPrivate,
      ControlPlaneKeyService.getControlPlanePublicKey()
    );
    assert.strictEqual(claims.v, 1);
    assert.strictEqual(claims.op, 'put');
    assert.strictEqual(claims.id, res.body.id);
    assert.strictEqual(claims.gw, 'node-drop-gw');
    assert.strictEqual(claims.n, 5_243_920);
    assert.strictEqual(claims.once, true);
    assert.ok(claims.exp > before && claims.exp <= before + 15 * 60 + 5, 'an upload ticket lives at most 15 minutes');
    assert.ok(claims.del >= before + 24 * 3600 - 5 && claims.del <= before + 24 * 3600 + 5, 'kept 24 hours');
  });

  it('issues a download ticket to the recipient only, and only once the upload is confirmed', async () => {
    const created = await create('anna');
    const id = created.body.id;
    const early = await request(app).post(`/api/drop/transfers/${id}/download-ticket`).set(auth('bruno'));
    assert.strictEqual(early.status, 409);
    assert.strictEqual(early.body.code, 'drop_not_ready');

    assert.strictEqual(
      (await request(app).post(`/api/drop/transfers/${id}/sent`).set(auth('bruno'))).status,
      404,
      'only the sender confirms the upload'
    );
    assert.strictEqual((await request(app).post(`/api/drop/transfers/${id}/sent`).set(auth('anna'))).status, 200);

    for (const who of ['anna', 'carla', 'admin', 'outsider']) {
      const res = await request(app).post(`/api/drop/transfers/${id}/download-ticket`).set(auth(who));
      assert.strictEqual(res.status, 404, `${who} got a download ticket`);
    }
    const res = await request(app).post(`/api/drop/transfers/${id}/download-ticket`).set(auth('bruno'));
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.url, `/drop-blob/${id}`);
    assert.strictEqual(res.body.ciphertext_bytes, 5_243_920);
    const claims = gatewayVerifies(res.body.ticket, gatewayPrivate, ControlPlaneKeyService.getControlPlanePublicKey());
    assert.strictEqual(claims.op, 'get');
    assert.strictEqual(claims.id, id);
    assert.strictEqual(claims.gw, 'node-drop-gw');
    assert.ok(claims.exp <= Math.floor(Date.now() / 1000) + 5 * 60 + 5, 'a download ticket lives at most 5 minutes');
  });

  it('refuses a recipient in another organisation as if it did not exist', async () => {
    const res = await create('anna', { recipient_id: 'usr-drop-out' });
    assert.strictEqual(res.status, 404);
    assert.strictEqual(res.body.code, 'no_such_recipient');
    const back = await create('outsider', { recipient_id: 'usr-drop-anna' });
    assert.strictEqual(back.status, 404);
    for (const id of ['usr-drop-gone', 'nobody', '', null]) {
      assert.strictEqual((await create('anna', { recipient_id: id })).status, id ? 404 : 400, String(id));
    }
    const rows = await pool.query('SELECT COUNT(*)::int AS n FROM drop_transfers');
    assert.strictEqual(rows.rows[0].n, 0);
  });

  it("does not show another organisation's transfers", async () => {
    const t = await sendOne();
    const inbox = await request(app).get('/api/drop/inbox').set(auth('outsider'));
    assert.strictEqual(inbox.status, 200);
    assert.deepStrictEqual(inbox.body.transfers, []);
    const ticket = await request(app).post(`/api/drop/transfers/${t.id}/download-ticket`).set(auth('outsider'));
    assert.strictEqual(ticket.status, 404);
  });

  it('shows the inbox and the outbox with metadata only', async () => {
    const t = await sendOne({ one_time: true });
    const inbox = await request(app).get('/api/drop/inbox').set(auth('bruno'));
    assert.strictEqual(inbox.status, 200);
    assert.strictEqual(inbox.body.transfers.length, 1);
    const item = inbox.body.transfers[0];
    assert.deepStrictEqual(Object.keys(item).sort(), [
      'ciphertext_bytes',
      'created_at',
      'expires_at',
      'id',
      'one_time',
      'peer',
      'received_at',
      'short_code',
      'status'
    ]);
    assert.strictEqual(item.id, t.id);
    assert.strictEqual(item.peer.username, 'anna');
    assert.strictEqual(item.status, 'sent');
    const outbox = await request(app).get('/api/drop/outbox').set(auth('anna'));
    assert.strictEqual(outbox.body.transfers[0].peer.username, 'bruno');
    assert.deepStrictEqual((await request(app).get('/api/drop/inbox').set(auth('carla'))).body.transfers, []);
  });

  it('never stores a file name or anything else the caller adds', async () => {
    const res = await create('anna', {
      name: MARKER,
      file_name: MARKER,
      mime_type: 'application/pdf',
      sha256: crypto.createHash('sha256').update(MARKER).digest('hex'),
      key: 'k'.repeat(43)
    });
    assert.strictEqual(res.status, 201);
    await request(app).post(`/api/drop/transfers/${res.body.id}/sent`).set(auth('anna'));
    const columns = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'drop_transfers' ORDER BY column_name`
    );
    assert.deepStrictEqual(
      columns.rows.map((r) => r.column_name),
      [
        'ciphertext_bytes',
        'created_at',
        'expires_at',
        'gateway_node_id',
        'id',
        'one_time',
        'organization_id',
        'received_at',
        'recipient_user_id',
        'sender_user_id',
        'sent_at',
        'status'
      ],
      'drop_transfers holds metadata only'
    );
    const dump = JSON.stringify((await pool.query('SELECT * FROM drop_transfers')).rows);
    assert.ok(!dump.includes(MARKER) && !dump.includes('application/pdf') && !dump.includes('kkkk'));
    const audit = await pool.query(`SELECT * FROM audit_events WHERE event_type LIKE 'DROP_%'`);
    assert.ok(audit.rows.length >= 2, 'creating and sending are audited');
    const auditDump = JSON.stringify(audit.rows);
    assert.ok(!auditDump.includes(MARKER), 'the audit never carries a file name');
    assert.ok(!auditDump.includes(res.body.upload.ticket), 'the audit never carries a ticket');
    assert.ok(auditDump.includes(res.body.id), 'the audit names the transfer');
  });

  it('refuses expired transfers and hides them', async () => {
    const t = await sendOne();
    await pool.query(`UPDATE drop_transfers SET expires_at = NOW() - INTERVAL '1 second' WHERE id = $1`, [t.id]);
    const res = await request(app).post(`/api/drop/transfers/${t.id}/download-ticket`).set(auth('bruno'));
    assert.strictEqual(res.status, 410);
    assert.strictEqual(res.body.code, 'drop_expired');
    assert.deepStrictEqual((await request(app).get('/api/drop/inbox').set(auth('bruno'))).body.transfers, []);
    assert.deepStrictEqual((await request(app).get('/api/drop/outbox').set(auth('anna'))).body.transfers, []);
  });

  it('removes expired metadata', async () => {
    const t = await sendOne();
    await pool.query(`UPDATE drop_transfers SET expires_at = NOW() - INTERVAL '1 second' WHERE id = $1`, [t.id]);
    const removed = await DropService.sweep();
    assert.strictEqual(removed, 1);
    const left = await pool.query('SELECT COUNT(*)::int AS n FROM drop_transfers');
    assert.strictEqual(left.rows[0].n, 0);
  });

  it('lets a one-time transfer be received once', async () => {
    const t = await sendOne({ one_time: true });
    assert.strictEqual(
      (await request(app).post(`/api/drop/transfers/${t.id}/download-ticket`).set(auth('bruno'))).status,
      200
    );
    assert.strictEqual(
      (await request(app).post(`/api/drop/transfers/${t.id}/received`).set(auth('anna'))).status,
      404,
      'only the recipient confirms receipt'
    );
    const done = await request(app).post(`/api/drop/transfers/${t.id}/received`).set(auth('bruno'));
    assert.strictEqual(done.status, 200);
    const again = await request(app).post(`/api/drop/transfers/${t.id}/download-ticket`).set(auth('bruno'));
    assert.strictEqual(again.status, 410);
    assert.strictEqual(again.body.code, 'drop_already_received');

    const reusable = await sendOne({ one_time: false });
    await request(app).post(`/api/drop/transfers/${reusable.id}/received`).set(auth('bruno'));
    assert.strictEqual(
      (await request(app).post(`/api/drop/transfers/${reusable.id}/download-ticket`).set(auth('bruno'))).status,
      200,
      'a 24-hour transfer can be downloaded again'
    );
  });

  it('checks the size against the limit', async () => {
    for (const bytes of [0, -1, 1.5, '100', 1055]) {
      const res = await create('anna', { ciphertext_bytes: bytes });
      assert.strictEqual(res.status, 400, `size ${bytes}`);
    }
    const big = await create('anna', { ciphertext_bytes: DropService.maxBytes() + 1 });
    assert.strictEqual(big.status, 413);
    assert.strictEqual(big.body.code, 'drop_too_large');
  });

  it('is unavailable without a default gateway that runs the mailbox', async () => {
    await pool.query(`UPDATE nodes SET node_capabilities = '{derp-v2}' WHERE id = 'node-drop-gw'`);
    const cfg = await request(app).get('/api/drop/config').set(auth('anna'));
    assert.strictEqual(cfg.body.available, false);
    const res = await create('anna');
    assert.strictEqual(res.status, 409);
    assert.strictEqual(res.body.code, 'drop_unavailable');
  });

  it('lets an administrator turn NeroDrop off for the organisation (the device.drop hook)', async () => {
    const t = await sendOne();
    assert.strictEqual(
      (await request(app).put('/api/drop/policy').set(auth('anna')).send({ enabled: false })).status,
      403
    );
    const off = await request(app).put('/api/drop/policy').set(auth('admin')).send({ enabled: false });
    assert.strictEqual(off.status, 200);
    assert.strictEqual(off.body.enabled, false);
    const res = await create('anna');
    assert.strictEqual(res.status, 403);
    assert.strictEqual(res.body.code, 'drop_disabled');
    const ticket = await request(app).post(`/api/drop/transfers/${t.id}/download-ticket`).set(auth('bruno'));
    assert.strictEqual(ticket.status, 403, 'turning it off stops downloads too');
    const cfg = await request(app).get('/api/drop/config').set(auth('anna'));
    assert.strictEqual(cfg.body.enabled, false);
    assert.strictEqual(cfg.body.may_send, false);
    const policyAudit = await pool.query(`SELECT 1 FROM audit_events WHERE event_type = 'DROP_POLICY_SET'`);
    assert.strictEqual(policyAudit.rows.length, 1);
    assert.strictEqual(
      (await request(app).put('/api/drop/policy').set(auth('admin')).send({ enabled: 'no' })).status,
      400
    );
  });

  it('does not let an auditor send', async () => {
    const res = await create('auditor');
    assert.strictEqual(res.status, 403);
    assert.strictEqual(res.body.code, 'drop_not_permitted');
    assert.strictEqual((await request(app).get('/api/drop/config').set(auth('auditor'))).body.may_send, false);
  });

  it('bounds how many transfers one person keeps open', async () => {
    for (let i = 0; i < DropService.MAX_OPEN_PER_SENDER; i++) {
      assert.strictEqual((await create('carla')).status, 201);
    }
    const res = await create('carla');
    assert.strictEqual(res.status, 429);
    assert.strictEqual(res.body.code, 'too_many_transfers');
  });

  it('keeps the mailbox capability a gateway reports at registration', async () => {
    const TransportPolicyService = require('../services/TransportPolicyService');
    await pool.query(`UPDATE nodes SET node_capabilities = '{}' WHERE id = 'node-drop-gw'`);
    await TransportPolicyService.recordNodeCapability('node-drop-gw', {
      transports: ['udp'],
      capabilities: ['derp-v2', 'drop-v1', 'made-up']
    });
    const row = await pool.query(`SELECT node_capabilities FROM nodes WHERE id = 'node-drop-gw'`);
    assert.deepStrictEqual([...row.rows[0].node_capabilities].sort(), ['derp-v2', 'drop-v1']);
  });

  it('answers 404 for a malformed transfer id', async () => {
    for (const id of ['x', '../../etc', 'ABCDEF0123456789ABCDEF0123456789']) {
      const res = await request(app)
        .post(`/api/drop/transfers/${encodeURIComponent(id)}/download-ticket`)
        .set(auth('bruno'));
      assert.strictEqual(res.status, 404, id);
    }
  });
});
