// NeroDrop end to end (ADR 0033) against a running stack with the gateway
// (docker-compose.gateway.yml). Two members of one organisation; one sends a random
// file through the console origin, the other downloads and decrypts it with the same
// code the browser runs (console/frontend/src/drop/dropCrypto.ts, bundled to
// DROP_CRYPTO), and the SHA-256 of what arrives is compared with what was sent.
//
// Run inside the stack network, e.g.:
//   node scripts/dev/scenarios/nerodrop-e2e.mjs
// Environment: CONSOLE (https://frontend:8443), ADMIN_USER, ADMIN_PASS, DROP_CRYPTO
// (path of the bundled module), SIZE (bytes, default 5 MiB), NODE_EXTRA_CA_CERTS.
// Prints one JSON line per step and a final summary; exits non-zero on any failure.
// The marker it plants in the plaintext is printed, so the caller can search the
// gateway's volume for it.
import { createHash, randomBytes, webcrypto } from 'node:crypto';

const CONSOLE = process.env.CONSOLE || 'https://frontend:8443';
const SIZE = Number(process.env.SIZE || 5 * 1024 * 1024);
const { encryptFile, Decryptor, ciphertextLength } = await import(process.env.DROP_CRYPTO || './dropCrypto.mjs');

const log = (step, data = {}) => console.log(JSON.stringify({ step, ...data }));
function check(condition, what) {
  if (!condition) {
    log('FAIL', { what });
    process.exit(1);
  }
}

async function api(method, path, token, body) {
  const res = await fetch(`${CONSOLE}/api${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text.slice(0, 200) };
  }
  return { status: res.status, body: json };
}

async function login(username, password) {
  const res = await api('POST', '/auth/login', null, { username, password });
  check(res.status === 200 && res.body && res.body.token, `login ${username}: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.token;
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const join = (parts) => Buffer.concat(parts.map((p) => Buffer.from(p.buffer, p.byteOffset, p.byteLength)));

async function blob(method, url, ticket, body) {
  return fetch(`${CONSOLE}${url}`, {
    method,
    headers: ticket ? { Authorization: `NeroDrop ${ticket}` } : {},
    body
  });
}

async function send(token, recipientId, plain, name, oneTime) {
  const bytes = ciphertextLength(plain.length);
  const created = await api('POST', '/drop/transfers', token, {
    recipient_id: recipientId,
    ciphertext_bytes: bytes,
    one_time: oneTime
  });
  check(created.status === 201, `create transfer: ${created.status} ${JSON.stringify(created.body)}`);
  const key = new Uint8Array(randomBytes(32));
  const parts = await encryptFile(
    { size: plain.length, read: async (s, e) => new Uint8Array(plain.subarray(s, e)) },
    { name, type: 'application/octet-stream' },
    created.body.id,
    key,
    { subtle: webcrypto.subtle }
  );
  const cipher = join(parts);
  check(cipher.length === bytes, 'ciphertext length matches what the console was told');
  const put = await blob('PUT', created.body.upload.url, created.body.upload.ticket, cipher);
  check(put.status === 201, `upload through the console origin: ${put.status}`);
  const sent = await api('POST', `/drop/transfers/${created.body.id}/sent`, token, {});
  check(sent.status === 200, `mark sent: ${sent.status}`);
  return { id: created.body.id, shortCode: created.body.short_code, key, cipherSha: sha256(cipher), bytes };
}

async function receive(token, id, key) {
  const ticket = await api('POST', `/drop/transfers/${id}/download-ticket`, token, {});
  check(ticket.status === 200, `download ticket: ${ticket.status} ${JSON.stringify(ticket.body)}`);
  const res = await blob('GET', ticket.body.url, ticket.body.ticket);
  check(res.status === 200, `download through the console origin: ${res.status}`);
  const d = new Decryptor(id, key, { subtle: webcrypto.subtle });
  const reader = res.body.getReader();
  let ciphertextBytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    ciphertextBytes += value.length;
    await d.push(value);
  }
  const { manifest, parts } = await d.finish();
  const got = await api('POST', `/drop/transfers/${id}/received`, token, {});
  check(got.status === 200, `mark received: ${got.status}`);
  return { manifest, plain: join(parts), ciphertextBytes };
}

// --- setup: admin, the gateway as default, two members ---------------------------
const admin = await login(process.env.ADMIN_USER || 'admin', process.env.ADMIN_PASS);
let gateway = null;
for (let i = 0; i < 60 && !gateway; i++) {
  const nodes = await api('GET', '/nodes', admin);
  const list = Array.isArray(nodes.body) ? nodes.body : nodes.body?.nodes || [];
  gateway = list.find((n) => (n.device_kind || 'mesh') === 'mesh') || null;
  if (!gateway) await new Promise((r) => setTimeout(r, 2000));
}
check(gateway, 'the gateway node registered');
const setGw = await api('PUT', '/devices/gateway', admin, { node_id: gateway.id, endpoint: 'gw.example.com:51820' });
check(setGw.status === 200, `set default gateway: ${setGw.status} ${JSON.stringify(setGw.body)}`);
log('gateway', { node_id: gateway.id });

const suffix = randomBytes(3).toString('hex');
const people = {};
for (const who of ['alice', 'bob']) {
  const password = randomBytes(18).toString('base64url');
  const username = `${who}-${suffix}`;
  const made = await api('POST', '/users', admin, { username, password, email: `${username}@example.com`, role: 'user' });
  check(made.status === 201 || made.status === 200, `create ${who}: ${made.status} ${JSON.stringify(made.body)}`);
  people[who] = { username, token: await login(username, password) };
}
const recipients = await api('GET', '/drop/recipients', people.alice.token);
const bob = recipients.body.recipients.find((r) => r.username === people.bob.username);
check(bob, 'bob is a recipient for alice');

let config = null;
for (let i = 0; i < 30; i++) {
  config = await api('GET', '/drop/config', people.alice.token);
  if (config.body && config.body.available) break;
  await new Promise((r) => setTimeout(r, 2000));
}
check(config.body.available && config.body.may_send, `NeroDrop available: ${JSON.stringify(config.body)}`);
log('config', config.body);

// --- 1. a random 5 MiB file with a known marker, sent and received ----------------
const marker = `NERODROP-E2E-MARKER-${randomBytes(6).toString('hex')}`;
const fileName = `${marker}-name.bin`;
const plain = randomBytes(SIZE);
for (const at of [0, Math.floor(SIZE / 2), SIZE - marker.length - 1]) plain.write(marker, at, 'latin1');
const sentSha = sha256(plain);
const t1 = await send(people.alice.token, bob.id, plain, fileName, false);
log('sent', { id: t1.id, short_code: t1.shortCode, plaintext_sha256: sentSha, ciphertext_bytes: t1.bytes, ciphertext_sha256: t1.cipherSha });

// --- 2. nothing without a ticket ----------------------------------------------------
const noTicket = await blob('GET', `/drop-blob/${t1.id}`);
const badTicket = await blob('GET', `/drop-blob/${t1.id}`, 'eyJ2IjoxfQ.AAAA');
const noTicketPut = await blob('PUT', `/drop-blob/${randomBytes(16).toString('hex')}`, null, Buffer.from('x'));
log('without-ticket', { get: noTicket.status, bad_ticket: badTicket.status, put: noTicketPut.status });
check(noTicket.status === 401 && badTicket.status === 401 && noTicketPut.status === 401, 'no ticket, no data');
const aliceTicket = await api('POST', `/drop/transfers/${t1.id}/download-ticket`, people.alice.token, {});
check(aliceTicket.status === 404, `the sender gets no download ticket: ${aliceTicket.status}`);

// --- 3. bob downloads and decrypts ---------------------------------------------------
const inbox = await api('GET', '/drop/inbox', people.bob.token);
check(inbox.body.transfers.some((t) => t.id === t1.id && t.short_code === t1.shortCode), 'in bob\'s inbox with the same short code');
const r1 = await receive(people.bob.token, t1.id, t1.key);
const gotSha = sha256(r1.plain);
log('received', { id: t1.id, plaintext_sha256: gotSha, name_restored: r1.manifest.name === fileName, ciphertext_bytes: r1.ciphertextBytes });
check(gotSha === sentSha, 'SHA-256 identical');

// --- 4. a one-time transfer is gone from the gateway after the download -------------
const small = randomBytes(64 * 1024);
small.write(marker, 100, 'latin1');
const t2 = await send(people.alice.token, bob.id, small, `${marker}-once.bin`, true);
const r2 = await receive(people.bob.token, t2.id, t2.key);
check(sha256(r2.plain) === sha256(small), 'one-time SHA-256 identical');
const again = await api('POST', `/drop/transfers/${t2.id}/download-ticket`, people.bob.token, {});
log('one-time', { id: t2.id, second_ticket: again.status });
check(again.status === 410, 'a one-time transfer cannot be fetched twice');

// --- 5. expiry: with the gateway started with a short SOVEREIGN_DROP_MAX_AGE, the
// ciphertext is gone after it, whatever the console still lists -----------------------
const t3 = await send(people.alice.token, bob.id, randomBytes(32 * 1024), `${marker}-unread.bin`, false);
const waitSeconds = Number(process.env.WAIT_EXPIRY || 0);
let expiry = null;
if (waitSeconds > 0) {
  log('waiting-for-expiry', { seconds: waitSeconds, unread: t3.id });
  await new Promise((r) => setTimeout(r, waitSeconds * 1000));
  expiry = {};
  for (const id of [t1.id, t3.id]) {
    const ticket = await api('POST', `/drop/transfers/${id}/download-ticket`, people.bob.token, {});
    const res = ticket.status === 200 ? await blob('GET', ticket.body.url, ticket.body.ticket) : null;
    expiry[id] = { ticket: ticket.status, gateway: res ? res.status : null };
    check(res && res.status === 404, `expired ciphertext served for ${id}`);
  }
  log('expired', expiry);
}

console.log(
  JSON.stringify({
    summary: 'ok',
    marker,
    file_name: fileName,
    size: SIZE,
    plaintext_sha256_sent: sentSha,
    plaintext_sha256_received: gotSha,
    reusable: t1.id,
    one_time_deleted: t2.id,
    unread: t3.id,
    expiry
  })
);
