const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const request = require('supertest');

const { setupTestDatabase } = require('./helpers/db');
const { createApp } = require('../server');
const { normalisePublicKeyHex } = require('../utils/crypto');
const CircuitEngine = require('../modules/onion/CircuitEngine');

/**
 * Path selection is the security decision in onion routing, not the sealing. A
 * three-hop circuit whose hops share an operator or an autonomous system protects
 * nothing against that party: they observe both ends and correlate directly.
 */

describe('Public key normalisation', () => {
  // The nodes table holds two encodings: 64 hex characters from Go nodes, and 44
  // characters of base64 from keys the console mints. Both are valid Curve25519
  // keys, but the wire field is public_key_hex, so handing a node the base64 form
  // produces a key it cannot decode and a handshake that fails unexplained.
  it('passes hex through unchanged', () => {
    const hex = 'a'.repeat(64);
    assert.strictEqual(normalisePublicKeyHex(hex), hex);
  });

  it('converts base64 to hex', () => {
    const raw = crypto.randomBytes(32);
    assert.strictEqual(normalisePublicKeyHex(raw.toString('base64')), raw.toString('hex'));
  });

  it('rejects placeholders left by the older bridge', () => {
    // Selecting one of these builds a circuit that fails at the first
    // Diffie-Hellman rather than at selection, where the reason is obvious.
    for (const bad of ['unknown-0o281g', '', 'not-a-key', 'YWJj']) {
      assert.strictEqual(normalisePublicKeyHex(bad), null, `${bad} should be rejected`);
    }
  });
});

describe('Circuit path selection', () => {
  let dbHelper;
  let app;

  // A monotonic counter, not a row count: tests delete relays between cases, so a
  // count-derived address collides with one already issued and the insert fails on
  // the UNIQUE constraint -- which surfaces as an unrelated 503 much later.
  let addressCounter = 0;

  async function addRelay({ id, owner, asn, country = 'US', role = 'EXIT_BRIDGE' }) {
    addressCounter += 1;

    await dbHelper.pool.query(
      `INSERT INTO users (id, username, email, password_hash, role)
       VALUES ($1, $2, $3, 'x', 'user')
       ON CONFLICT (id) DO NOTHING`,
      [owner, owner, `${owner}@example.com`]
    );

    await dbHelper.pool.query(
      `INSERT INTO nodes (id, user_id, name, public_key, overlay_ipv4, overlay_ipv6,
                          role, country_code, asn, is_healthy, is_quarantined)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, TRUE, FALSE)
       ON CONFLICT (id) DO UPDATE SET is_healthy = TRUE, is_quarantined = FALSE, role = $7, asn = $9, country_code = $8`,
      [
        id,
        owner,
        id,
        crypto.randomBytes(32).toString('hex'),
        `100.64.9.${addressCounter}`,
        `fd7a:115c:a1e0::9${addressCounter.toString(16)}`,
        role,
        country,
        asn
      ]
    );
  }

  before(async () => {
    dbHelper = await setupTestDatabase();
    app = createApp();

    await dbHelper.pool.query("UPDATE nodes SET role = 'CLIENT_ORIGIN'");
  });

  after(async () => {
    if (dbHelper) await dbHelper.cleanup();
  });

  it('refuses when there are not enough relays', async () => {
    const res = await request(app).post('/v4/control/circuit').send({ target_country: 'US' });
    assert.strictEqual(res.status, 503);
  });

  it('builds a path and reports full independence when operators and networks differ', async () => {
    await addRelay({ id: 'relay-a', owner: 'op-a', asn: 100 });
    await addRelay({ id: 'relay-b', owner: 'op-b', asn: 200 });
    await addRelay({ id: 'relay-c', owner: 'op-c', asn: 300 });

    const res = await request(app).post('/v4/control/circuit').send({ target_country: 'US' });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.hops.length, 3);
    assert.strictEqual(res.body.diversity.distinct_operators, true);
    assert.strictEqual(res.body.diversity.distinct_networks, true);

    // Hop indices must be contiguous from zero: the CLI labels entry and exit from
    // them, and it previously tested for 1 and 3 and named every hop wrongly.
    assert.deepStrictEqual(
      res.body.hops.map((h) => h.hop_index),
      [0, 1, 2]
    );
  });

  it('never repeats a node within one path', async () => {
    for (let i = 0; i < 25; i++) {
      const res = await request(app).post('/v4/control/circuit').send({ target_country: 'US' });
      const ids = res.body.hops.map((h) => h.node_id);
      assert.strictEqual(new Set(ids).size, ids.length, `repeated hop: ${ids.join(', ')}`);
    }
  });

  it('varies the path across requests', async () => {
    await addRelay({ id: 'relay-d', owner: 'op-d', asn: 400 });
    await addRelay({ id: 'relay-e', owner: 'op-e', asn: 500 });

    const seen = new Set();
    const failures = [];

    for (let i = 0; i < 30; i++) {
      const res = await request(app).post('/v4/control/circuit').send({ target_country: 'US' });

      // A request that did not return a circuit must be reported as itself, not
      // collapsed into "the path never varied" -- which is what this assertion used
      // to say whatever the real cause was.
      if (res.status !== 200 || !Array.isArray(res.body.hops)) {
        failures.push(`${res.status}: ${JSON.stringify(res.body).slice(0, 120)}`);
        continue;
      }

      seen.add(res.body.hops.map((h) => h.node_id).join('>'));
    }

    assert.deepStrictEqual(failures, [], `some circuit requests failed: ${failures.join(' | ')}`);

    // A predictable path is an attackable one. With five relays and three hops there
    // are many possible paths, so one distinct result across thirty draws means the
    // selection is not random.
    assert.ok(seen.size > 1, `every circuit selected the same path: ${[...seen].join(', ')}`);
  });

  it('issues distinct circuit ids', async () => {
    const ids = new Set();
    for (let i = 0; i < 20; i++) {
      const res = await request(app).post('/v4/control/circuit').send({ target_country: 'US' });
      ids.add(res.body.circuit_id);
    }
    assert.ok(ids.size > 15, `circuit ids repeated: ${ids.size} distinct out of 20`);
  });

  it('reports limited independence rather than hiding it', async () => {
    await dbHelper.pool.query("DELETE FROM nodes WHERE id LIKE 'relay-%'");

    // A self-hosted mesh: one owner, one network. Onion routing still hides traffic
    // from network observers and the destination, so the path is built -- but the
    // caller must be told what it is, or they will act as though they have anonymity
    // they do not have.
    await addRelay({ id: 'solo-a', owner: 'solo', asn: 7018 });
    await addRelay({ id: 'solo-b', owner: 'solo', asn: 7018 });
    await addRelay({ id: 'solo-c', owner: 'solo', asn: 7018 });

    const res = await request(app).post('/v4/control/circuit').send({ target_country: 'US' });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.diversity.distinct_operators, false);
    assert.strictEqual(res.body.diversity.operator_count, 1);
    assert.match(res.body.diversity.note, /same account|correlate/i);
  });

  it('excludes the requester from its own path', async () => {
    await dbHelper.pool.query("DELETE FROM nodes WHERE id LIKE 'solo-%'");

    // Four relays, not three: the requester is removed from the pool, so a three-hop
    // path needs three others.
    await addRelay({ id: 'self-node', owner: 'op-self', asn: 100 });
    await addRelay({ id: 'other-a', owner: 'op-a', asn: 200 });
    await addRelay({ id: 'other-b', owner: 'op-b', asn: 300 });
    await addRelay({ id: 'other-c', owner: 'op-c', asn: 400 });

    for (let i = 0; i < 10; i++) {
      const res = await request(app).post('/v4/control/circuit').send({ target_country: 'US', node_id: 'self-node' });

      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.ok(!res.body.hops.some((h) => h.node_id === 'self-node'), 'the requester was placed in its own circuit');
    }
  });

  it('honours the exit country', async () => {
    await addRelay({ id: 'exit-de', owner: 'op-de', asn: 600, country: 'DE' });

    const res = await request(app).post('/v4/control/circuit').send({ target_country: 'DE' });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.hops[res.body.hops.length - 1].node_id, 'exit-de');
  });

  it('refuses a country with no exit bridge rather than substituting one', async () => {
    const res = await request(app).post('/v4/control/circuit').send({ target_country: 'JP' });

    // Silently exiting from the wrong country would defeat the only reason the
    // caller asked for a country.
    assert.strictEqual(res.status, 503);
    assert.match(res.body.error, /JP/);
  });

  it('does not select quarantined or unhealthy relays', async () => {
    await dbHelper.pool.query("UPDATE nodes SET is_quarantined = TRUE WHERE id = 'other-a'");
    await dbHelper.pool.query("UPDATE nodes SET is_healthy = FALSE WHERE id = 'other-b'");

    for (let i = 0; i < 10; i++) {
      const res = await request(app).post('/v4/control/circuit').send({ target_country: 'US' });
      if (res.status !== 200) continue;

      const ids = res.body.hops.map((h) => h.node_id);
      assert.ok(!ids.includes('other-a'), 'a quarantined relay was used as a hop');
      assert.ok(!ids.includes('other-b'), 'an unhealthy relay was used as a hop');
    }

    await dbHelper.pool.query('UPDATE nodes SET is_quarantined = FALSE, is_healthy = TRUE');
  });

  it('sets an expiry so circuits rotate', async () => {
    const res = await request(app).post('/v4/control/circuit').send({ target_country: 'US' });
    const now = Math.floor(Date.now() / 1000);

    // A long-lived circuit gives a hostile relay more traffic to correlate.
    assert.ok(res.body.expiry_timestamp > now);
    assert.ok(res.body.expiry_timestamp <= now + CircuitEngine.CIRCUIT_LIFETIME_SECONDS + 5);
  });

  it('requires the enrolment token when one is configured', async () => {
    process.env.SOVEREIGN_REGISTRATION_TOKEN = 'circuit-token';
    try {
      const denied = await request(app).post('/v4/control/circuit').send({ target_country: 'US' });
      assert.strictEqual(denied.status, 401);
    } finally {
      delete process.env.SOVEREIGN_REGISTRATION_TOKEN;
    }
  });
});
