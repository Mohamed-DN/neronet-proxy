// The console's side of the app end-to-end scenario (ADR 0040), run inside the stack network:
//
//   node app-e2e.mjs prepare             admin creates a person, who turns on an authenticator
//   node app-e2e.mjs approve USER_CODE   the person signs in (code from the authenticator) and approves an app
//   node app-e2e.mjs suspend             an administrator ends all of the person's sessions ("revoke all")
//   node app-e2e.mjs revoke              the person revokes their app for good
//   node app-e2e.mjs peers EXCLUDE_ID    prints "<id> <overlay address>" of every other healthy node
//   node app-e2e.mjs node ID             prints the console's row for one node, or "gone"
//
// Environment: CONSOLE (https://frontend:8443), ADMIN_USER, ADMIN_PASS, WORK (a directory that keeps the
// person's state between runs), NODE_EXTRA_CA_CERTS. Nothing secret is printed. Exit status is non-zero on
// any failure, with the reason on stderr.
import { createHmac, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const CONSOLE = process.env.CONSOLE || 'https://frontend:8443';
const WORK = process.env.WORK || '/work';
const STATE = `${WORK}/person.json`;

const die = (msg) => {
  console.error(msg);
  process.exit(1);
};

async function api(method, path, token, body) {
  const res = await fetch(`${CONSOLE}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  return { status: res.status, json };
}

// RFC 6238, six digits, thirty seconds: what an authenticator app does.
function base32(s) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of s.replace(/=+$/, '').toUpperCase()) bits += alphabet.indexOf(c).toString(2).padStart(5, '0');
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}
const step = () => Math.floor(Date.now() / 30000);
function totp(secret, counter = step()) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', base32(secret)).update(buf).digest();
  const o = h[h.length - 1] & 15;
  const n = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1000000).padStart(6, '0');
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The sign-in is limited to eight a quarter of an hour per name: the administrator's token is kept for ten
// minutes between runs of this script rather than asked for again.
async function adminToken() {
  const cache = `${WORK}/admin.json`;
  if (existsSync(cache)) {
    const c = JSON.parse(readFileSync(cache, 'utf8'));
    if (Date.now() - c.at < 10 * 60 * 1000) return c.token;
  }
  const token = await adminSignIn();
  writeFileSync(cache, JSON.stringify({ token, at: Date.now() }), { mode: 0o600 });
  return token;
}

async function adminSignIn() {
  const r = await api('POST', '/auth/login', null, { username: process.env.ADMIN_USER || 'admin', password: process.env.ADMIN_PASS });
  if (r.status !== 200 || !r.json?.token) die(`admin sign-in failed: ${r.status}`);
  return r.json.token;
}

const load = () => (existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : die('no person yet: run prepare first'));
const save = (p) => writeFileSync(STATE, JSON.stringify(p), { mode: 0o600 });

// A code the console has not seen yet: each is good once, so wait for a fresh time step.
async function freshCode(p) {
  while (step() <= (p.lastStep || 0)) await sleep(1000);
  p.lastStep = step();
  save(p);
  return totp(p.secret, p.lastStep);
}

async function personToken(p) {
  const r = await api('POST', '/auth/login', null, { username: p.username, password: p.password, totp_code: await freshCode(p) });
  if (r.status !== 200 || !r.json?.token) die(`the person's sign-in failed: ${r.status} ${JSON.stringify(r.json && Object.keys(r.json))}`);
  return r.json.token;
}

const [cmd, arg] = process.argv.slice(2);

if (cmd === 'prepare') {
  const admin = await adminToken();
  const username = `appe2e_${randomBytes(3).toString('hex')}`;
  const password = randomBytes(18).toString('hex');
  const made = await api('POST', '/users', admin, { username, password });
  if (made.status !== 201) die(`creating the person failed: ${made.status}`);
  const p = { username, password, id: made.json.user.id };
  const login = await api('POST', '/auth/login', null, { username, password });
  if (login.status !== 200 || !login.json?.token) die(`the new person cannot sign in: ${login.status}`);
  const setup = await api('POST', '/auth/mfa/setup', login.json.token, {});
  if (setup.status !== 200 || !setup.json?.secret) die(`authenticator setup failed: ${setup.status}`);
  p.secret = setup.json.secret;
  p.lastStep = 0;
  const code = await freshCode(p);
  const verify = await api('POST', '/auth/mfa/verify', login.json.token, { code });
  if (verify.status !== 200) die(`confirming the authenticator failed: ${verify.status}`);
  save(p);
  console.log(JSON.stringify({ person: p.username, mfa: true }));
} else if (cmd === 'approve') {
  const p = load();
  const token = await personToken(p);
  const look = await api('POST', '/app-auth/device/lookup', token, { user_code: arg });
  if (look.status !== 200) die(`lookup failed: ${look.status} ${look.json?.code}`);
  if (!look.json.mfa_required) die('the console did not ask for a second factor for this person');
  const noCode = await api('POST', '/app-auth/device/approve', token, { user_code: arg });
  if (noCode.status !== 401 || noCode.json?.code !== 'mfa_required') die(`approving without the authenticator was not refused: ${noCode.status}`);
  const ok = await api('POST', '/app-auth/device/approve', token, { user_code: arg, totp_code: await freshCode(p) });
  if (ok.status !== 200) die(`approve failed: ${ok.status} ${ok.json?.code}`);
  console.log(JSON.stringify({ approved: true, platform: look.json.platform, device_name: look.json.device_name }));
} else if (cmd === 'suspend') {
  const p = load();
  const admin = await adminToken();
  const r = await api('POST', `/users/${p.id}/revoke-sessions`, admin, {});
  if (r.status !== 200) die(`revoke-all failed: ${r.status}`);
  console.log(JSON.stringify({ suspended: true }));
} else if (cmd === 'revoke') {
  const p = load();
  const token = await personToken(p);
  const list = await api('GET', '/app-auth/sessions', token);
  const live = (list.json?.sessions || []).find((s) => s.status === 'active' || s.status === 'suspended');
  if (!live) die('the person has no app to revoke');
  const r = await api('DELETE', `/app-auth/sessions/${live.id}`, token);
  if (r.status !== 200) die(`revoke failed: ${r.status}`);
  console.log(JSON.stringify({ revoked: live.id, was: live.status }));
} else if (cmd === 'status') {
  const p = load();
  const token = await personToken(p);
  const list = await api('GET', '/app-auth/sessions', token);
  console.log(JSON.stringify((list.json?.sessions || []).map((s) => ({ id: s.id, status: s.status, node: s.node_id }))));
} else if (cmd === 'peers') {
  const admin = await adminToken();
  const r = await api('GET', '/nodes?limit=100', admin);
  const nodes = r.json?.nodes || r.json || [];
  for (const n of nodes) if (n.id !== arg && n.overlay_ipv4 && n.is_healthy !== false) console.log(`${n.id} ${n.overlay_ipv4} ${n.name || ''}`);
} else if (cmd === 'node') {
  const admin = await adminToken();
  const r = await api('GET', `/nodes/${arg}`, admin);
  console.log(r.status === 200 ? JSON.stringify({ id: r.json?.node?.id || r.json?.id }) : 'gone');
} else {
  die('usage: app-e2e.mjs prepare|approve CODE|suspend|revoke|status|peers EXCLUDE_ID|node ID');
}
