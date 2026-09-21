const { describe, it } = require('node:test');
const assert = require('node:assert');
const { setupTestDatabase } = require('./helpers/db');
const { allocateNextVip, vipFromOffset } = require('../utils/crypto');

/**
 * Allocation used to read every row of the nodes table and scan offsets upward in
 * JavaScript. Measured: 0.8 ms at 1,000 nodes, 6.7 ms at 10,000, 71 ms at 100,000 --
 * on a single-threaded runtime, so at scale that is the whole API stopped for 71 ms
 * per registration. It was also racy: two concurrent callers read the same set of
 * used addresses and picked the same one.
 */

async function freshDb(nodeCount = 0) {
  const dbHelper = await setupTestDatabase();
  const pool = dbHelper.pool;
  await pool.query('DELETE FROM nodes');
  await pool.query("SELECT setval('overlay_vip_seq', 1, false)");

  if (nodeCount > 0) {
    const ids = [];
    const names = [];
    const keys = [];
    const v4s = [];
    const v6s = [];
    let inserted = 0;
    for (let offset = 1; inserted < nodeCount; offset++) {
      const vip = vipFromOffset(offset);
      if (!vip.usable) continue;
      ids.push(`n${offset}`);
      names.push(`n${offset}`);
      keys.push(`key_${offset}_`.padEnd(64, 'x'));
      v4s.push(vip.overlayIpv4);
      v6s.push(vip.overlayIpv6);
      inserted++;
    }
    await pool.query(
      `INSERT INTO nodes (id, user_id, name, public_key, overlay_ipv4, overlay_ipv6)
       SELECT unnest($1::text[]), (SELECT id FROM users WHERE role = 'super-admin' LIMIT 1), unnest($2::text[]), unnest($3::text[]), unnest($4::text[]), unnest($5::text[])`,
      [ids, names, keys, v4s, v6s]
    );
    await pool.query("SELECT setval('overlay_vip_seq', $1, true)", [nodeCount + 8]);
  }

  return dbHelper;
}

describe('Overlay VIP allocation', () => {
  it('hands out addresses inside 100.64.0.0/10 with the matching IPv6', async () => {
    const dbHelper = await freshDb();
    const vip = await allocateNextVip(dbHelper.pool);

    assert.match(vip.overlayIpv4, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/);
    assert.match(vip.overlayIpv6, /^fd7a:115c:a1e0::[0-9a-f]+$/);
    await dbHelper.cleanup();
  });

  it('never returns a network or broadcast address', async () => {
    const dbHelper = await freshDb();

    for (let i = 0; i < 600; i++) {
      const { overlayIpv4 } = await allocateNextVip(dbHelper.pool);
      const lastOctet = Number(overlayIpv4.split('.')[3]);
      assert.notStrictEqual(lastOctet, 0, `${overlayIpv4} is a network address`);
      assert.notStrictEqual(lastOctet, 255, `${overlayIpv4} is a broadcast address`);
    }

    await dbHelper.cleanup();
  });

  it('never repeats an address across many allocations', async () => {
    const dbHelper = await freshDb();
    const seenV4 = new Set();
    const seenV6 = new Set();

    for (let i = 0; i < 1000; i++) {
      const vip = await allocateNextVip(dbHelper.pool);
      assert.ok(!seenV4.has(vip.overlayIpv4), `${vip.overlayIpv4} was handed out twice`);
      assert.ok(!seenV6.has(vip.overlayIpv6), `${vip.overlayIpv6} was handed out twice`);
      seenV4.add(vip.overlayIpv4);
      seenV6.add(vip.overlayIpv6);
    }

    await dbHelper.cleanup();
  });

  it('skips addresses already assigned outside the allocator', async () => {
    // Seed rows and imported nodes get addresses without going through the counter,
    // and the counter is positioned at migration time, before any of that exists.
    // Both overlay columns are UNIQUE, so an unchecked collision surfaces as a
    // constraint violation the caller cannot do anything about.
    const dbHelper = await freshDb();
    const pool = dbHelper.pool;
    await pool.query("SELECT setval('overlay_vip_seq', 1, false)");

    const taken = vipFromOffset(1);
    await pool.query(
      "INSERT INTO nodes (id, user_id, name, public_key, overlay_ipv4, overlay_ipv6) VALUES ($1, (SELECT id FROM users WHERE role = 'super-admin' LIMIT 1), $2, $3, $4, $5)",
      ['squatter', 'squatter', 'k-squatter'.padEnd(64, '0'), taken.overlayIpv4, taken.overlayIpv6]
    );

    const vip = await allocateNextVip(pool);

    assert.notStrictEqual(vip.overlayIpv4, taken.overlayIpv4);
    assert.notStrictEqual(vip.overlayIpv6, taken.overlayIpv6);
    await dbHelper.cleanup();
  });

  it('costs the same at 100 nodes as at 20,000', async () => {
    // The property that matters is not the absolute number but its shape. The old
    // allocator was linear in fleet size; this one must not be, or the ceiling just
    // moves further out instead of going away.
    async function costPerAllocation(nodeCount) {
      const dbHelper = await freshDb(nodeCount);
      const rounds = 50;

      const start = process.hrtime.bigint();
      for (let i = 0; i < rounds; i++) await allocateNextVip(dbHelper.pool);
      const elapsed = Number(process.hrtime.bigint() - start) / 1e6 / rounds;

      await dbHelper.cleanup();
      return elapsed;
    }

    const small = await costPerAllocation(100);
    const large = await costPerAllocation(20000);

    // A 200x larger fleet under the old implementation meant roughly 200x the work.
    // Allow a generous 5x band here: this is a guard against reintroducing a scan,
    // not a benchmark, and it has to hold on a loaded CI machine.
    assert.ok(
      large < Math.max(small * 5, 1),
      `allocation cost grew with fleet size: ${small.toFixed(3)} ms at 100 nodes, ${large.toFixed(3)} ms at 20,000`
    );
  });
});
