'use strict';

/**
 * NeroDrop phase 0 (ADR 0033): tickets, the organisation switch, and who may send to whom.
 *
 * The console never carries a key, a file name or plaintext. It decides whether a
 * transfer may happen, remembers its metadata, and signs tickets that the organisation's
 * default profile gateway verifies offline (pkg/drop). The ticket key is
 * HKDF-SHA-256(X25519(control plane private key, gateway public key),
 * info "neronet/v4/drop-ticket"); the gateway derives the same value from its own
 * private key, so no secret is configured on either side.
 */

const crypto = require('crypto');
const { getPgPool } = require('../db/index');
const { normalisePublicKeyHex } = require('../utils/crypto');
const ControlPlaneKeyService = require('./ControlPlaneKeyService');
const ProfileGatewayService = require('./ProfileGatewayService');

/** The IAM action ADR 0030's can(actor, 'device.drop', recipient) checks once grants land. */
const DEVICE_DROP = 'device.drop';
/** What a gateway running the mailbox reports at registration (pkg/drop.Capability). */
const CAPABILITY = 'drop-v1';
const TICKET_INFO = 'neronet/v4/drop-ticket';
const TICKET_DOMAIN = 'nerodrop-ticket-v1.';
const PUT_TICKET_SECONDS = 15 * 60;
const GET_TICKET_SECONDS = 5 * 60;
const LIFETIME_HOURS = 24;
/** Open transfers (not expired, not received) one person may have at a time. */
const MAX_OPEN_PER_SENDER = 20;
/**
 * The smallest valid ciphertext: the sealed manifest (1024 + 16 bytes) and one sealed,
 * empty final chunk (16 bytes). See console/frontend/src/drop/dropCrypto.ts.
 */
const MIN_CIPHERTEXT_BYTES = 1056;
const ID = /^[0-9a-f]{32}$/;
const SPKI_X25519 = Buffer.from('302a300506032b656e032100', 'hex');
const DEFAULT_ORG = 'org-default';

const orgKey = (org) => org || DEFAULT_ORG;

/** Largest ciphertext accepted, from SOVEREIGN_DROP_MAX_MIB (default 256 MiB). */
function maxBytes() {
  const mib = Number.parseInt(process.env.SOVEREIGN_DROP_MAX_MIB || '', 10);
  return (Number.isFinite(mib) && mib > 0 ? mib : 256) * 1024 * 1024;
}

function validId(id) {
  return typeof id === 'string' && ID.test(id);
}

function newId() {
  return crypto.randomBytes(16).toString('hex');
}

/** The eight characters both people see to recognise a transfer: "7F3A-09C2". */
function shortCode(id) {
  const s = id.slice(0, 8).toUpperCase();
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

/** The ticket key for a gateway, from the control plane's private key object. */
function ticketKeyFrom(cpPrivateKeyObject, gatewayPublicKey) {
  const hex = normalisePublicKeyHex(gatewayPublicKey);
  if (!hex) throw new Error('the gateway has no usable public key');
  const publicKey = crypto.createPublicKey({
    key: Buffer.concat([SPKI_X25519, Buffer.from(hex, 'hex')]),
    format: 'der',
    type: 'spki'
  });
  const shared = crypto.diffieHellman({ privateKey: cpPrivateKeyObject, publicKey });
  return Buffer.from(crypto.hkdfSync('sha256', shared, Buffer.alloc(0), Buffer.from(TICKET_INFO, 'utf8'), 32));
}

function ticketKey(gatewayPublicKey) {
  return ticketKeyFrom(ControlPlaneKeyService.getControlPlaneKeypair().privateKeyObject, gatewayPublicKey);
}

/** base64url(JSON) "." base64url(HMAC-SHA-256(key, domain || payload)). */
function signTicket(claims, key) {
  const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  const mac = crypto
    .createHmac('sha256', key)
    .update(TICKET_DOMAIN + payload)
    .digest('base64url');
  return `${payload}.${mac}`;
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

/** An upload ticket: exactly `bytes`, kept until `expiresAt`, deleted after one download if `once`. */
function uploadTicket(transfer, gateway) {
  const exp = nowSeconds() + PUT_TICKET_SECONDS;
  const ticket = signTicket(
    {
      v: 1,
      op: 'put',
      id: transfer.id,
      gw: gateway.id,
      n: Number(transfer.ciphertext_bytes),
      exp,
      del: Math.floor(new Date(transfer.expires_at).getTime() / 1000),
      once: Boolean(transfer.one_time)
    },
    ticketKey(gateway.public_key)
  );
  return { url: `/drop-blob/${transfer.id}`, ticket, expires_at: new Date(exp * 1000).toISOString() };
}

function downloadTicket(transfer, gateway) {
  const exp = nowSeconds() + GET_TICKET_SECONDS;
  const ticket = signTicket(
    { v: 1, op: 'get', id: transfer.id, gw: gateway.id, n: Number(transfer.ciphertext_bytes), exp },
    ticketKey(gateway.public_key)
  );
  return { url: `/drop-blob/${transfer.id}`, ticket, expires_at: new Date(exp * 1000).toISOString() };
}

/**
 * The gateway that holds the organisation's transfers: its default profile gateway, if
 * it runs the mailbox and is not quarantined. Null otherwise.
 */
async function mailbox(organizationId, client = getPgPool()) {
  const gateway = await ProfileGatewayService.defaultGateway(organizationId, client);
  if (!gateway || gateway.is_quarantined) return null;
  const res = await client.query('SELECT id, public_key, node_capabilities FROM nodes WHERE id = $1', [gateway.id]);
  const row = res.rows[0];
  if (!row || !Array.isArray(row.node_capabilities) || !row.node_capabilities.includes(CAPABILITY)) return null;
  if (!normalisePublicKeyHex(row.public_key)) return null;
  return { id: row.id, public_key: row.public_key };
}

/** The gateway a transfer was stored on, if it still exists. */
async function gatewayOf(transfer, client = getPgPool()) {
  if (!transfer.gateway_node_id) return null;
  const res = await client.query('SELECT id, public_key FROM nodes WHERE id = $1', [transfer.gateway_node_id]);
  return res.rows[0] || null;
}

async function enabled(organizationId, client = getPgPool()) {
  const res = await client.query('SELECT drop_enabled FROM organizations WHERE id = $1', [orgKey(organizationId)]);
  return res.rows[0] ? res.rows[0].drop_enabled !== false : true;
}

async function setEnabled(organizationId, value, client = getPgPool()) {
  await client.query('UPDATE organizations SET drop_enabled = $2, updated_at = NOW() WHERE id = $1', [
    orgKey(organizationId),
    value
  ]);
}

function isAuditor(user) {
  return Boolean(user) && (user.role === 'auditor' || user.org_role === 'auditor');
}

function isAdmin(user) {
  return Boolean(user) && (user.role === 'admin' || user.role === 'super-admin');
}

/**
 * The IAM hook: may this user send to `recipient` in this organisation? Every member may
 * send to every member of their own organisation while the organisation allows it; an
 * auditor, whose role is read-only, may receive but not send. ADR 0030's
 * can(actor, DEVICE_DROP, recipient) replaces the body; every caller goes through here.
 */
async function mayDrop(user, organizationId, /* recipient, */ client = getPgPool()) {
  if (!user || isAuditor(user)) return false;
  return enabled(organizationId, client);
}

const ACTIVE_MEMBER = `u.status = 'active' AND (
    COALESCE(u.organization_id, '${DEFAULT_ORG}') = $1
    OR EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = u.id AND m.organization_id = $1))`;

/** The active members of the organisation: who a transfer may go to. */
async function recipients(organizationId, client = getPgPool()) {
  const res = await client.query(`SELECT u.id, u.username FROM users u WHERE ${ACTIVE_MEMBER} ORDER BY u.username`, [
    orgKey(organizationId)
  ]);
  return res.rows.map((r) => ({ id: r.id, username: r.username }));
}

async function member(organizationId, userId, client = getPgPool()) {
  if (typeof userId !== 'string' || !userId) return null;
  const res = await client.query(`SELECT u.id, u.username FROM users u WHERE u.id = $2 AND ${ACTIVE_MEMBER}`, [
    orgKey(organizationId),
    userId
  ]);
  return res.rows[0] || null;
}

async function openCount(userId, client = getPgPool()) {
  const res = await client.query(
    `SELECT COUNT(*)::int AS n FROM drop_transfers
      WHERE sender_user_id = $1 AND expires_at > NOW() AND status <> 'received'`,
    [userId]
  );
  return res.rows[0].n;
}

async function create(
  { organizationId, senderId, recipientId, gatewayId, ciphertextBytes, oneTime },
  client = getPgPool()
) {
  const res = await client.query(
    `INSERT INTO drop_transfers (id, organization_id, sender_user_id, recipient_user_id, gateway_node_id,
                                 ciphertext_bytes, one_time, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW() + make_interval(hours => $8))
     RETURNING *`,
    [newId(), orgKey(organizationId), senderId, recipientId, gatewayId, ciphertextBytes, oneTime, LIFETIME_HOURS]
  );
  return res.rows[0];
}

/** A transfer of this organisation in which `userId` plays `side` ('sender' or 'recipient'). */
async function find(organizationId, id, userId, side, client = getPgPool()) {
  if (!validId(id)) return null;
  const column = side === 'sender' ? 'sender_user_id' : 'recipient_user_id';
  const res = await client.query(
    `SELECT * FROM drop_transfers WHERE id = $1 AND organization_id = $2 AND ${column} = $3`,
    [id, orgKey(organizationId), userId]
  );
  return res.rows[0] || null;
}

async function markSent(id, client = getPgPool()) {
  await client.query(
    `UPDATE drop_transfers SET status = 'sent', sent_at = COALESCE(sent_at, NOW()) WHERE id = $1 AND status = 'pending'`,
    [id]
  );
}

async function markReceived(id, client = getPgPool()) {
  await client.query(
    `UPDATE drop_transfers SET status = 'received', received_at = COALESCE(received_at, NOW()) WHERE id = $1 AND status <> 'pending'`,
    [id]
  );
}

/** Inbox (side 'recipient') or outbox (side 'sender'): live transfers, newest first. */
async function list(organizationId, userId, side, client = getPgPool()) {
  const mine = side === 'sender' ? 'sender_user_id' : 'recipient_user_id';
  const peer = side === 'sender' ? 'recipient_user_id' : 'sender_user_id';
  const res = await client.query(
    `SELECT t.id, t.ciphertext_bytes, t.one_time, t.status, t.created_at, t.expires_at, t.received_at,
            p.id AS peer_id, p.username AS peer_username
       FROM drop_transfers t JOIN users p ON p.id = t.${peer}
      WHERE t.organization_id = $1 AND t.${mine} = $2 AND t.expires_at > NOW()
        AND (t.status <> 'pending' OR $3)
      ORDER BY t.created_at DESC
      LIMIT 100`,
    [orgKey(organizationId), userId, side === 'sender']
  );
  return res.rows.map((r) => ({
    id: r.id,
    short_code: shortCode(r.id),
    peer: { id: r.peer_id, username: r.peer_username },
    ciphertext_bytes: Number(r.ciphertext_bytes),
    one_time: r.one_time,
    status: r.status,
    created_at: r.created_at,
    expires_at: r.expires_at,
    received_at: r.received_at
  }));
}

/** Delete expired metadata. The gateway deletes the ciphertext on its own clock. */
async function sweep(client = getPgPool()) {
  const res = await client.query('DELETE FROM drop_transfers WHERE expires_at <= NOW()');
  return res.rowCount;
}

module.exports = {
  DEVICE_DROP,
  CAPABILITY,
  LIFETIME_HOURS,
  MAX_OPEN_PER_SENDER,
  MIN_CIPHERTEXT_BYTES,
  maxBytes,
  validId,
  shortCode,
  ticketKeyFrom,
  signTicket,
  uploadTicket,
  downloadTicket,
  mailbox,
  gatewayOf,
  enabled,
  setEnabled,
  isAdmin,
  mayDrop,
  recipients,
  member,
  openCount,
  create,
  find,
  markSent,
  markReceived,
  list,
  sweep
};
