const { describe, it } = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');

const { runMigrations } = require('../db/migrator');
const { allocateNextVip, vipFromOffset } = require('../utils/crypto');

/**
 * Allocation used to read every row of the nodes table and scan offsets upward in
 * JavaScript. Measured: 0.8 ms at 1,000 nodes, 6.7 ms at 10,000, 71 ms at 100,000 --
 * on a single-threaded runtime, so at scale that is the whole API stopped for 71 ms
 * per registration. It was also racy: two concurrent callers read the same set of
 * used addresses and picked the same one.
 */

function freshDb(nodeCount = 0) {
  const db = new Database(':memory:');
  runMigrations(db);
  db.prepare(
    "INSERT INTO users (id, username, email, password_hash, role) VALUES ('u', 'u', 'u@example.com', 'h', 'super-admin')"
  ).run();

  if (nodeCount > 0) {
    const insert = db.prepare(
      'INSERT INTO nodes (id, user_id, name, public_key, overlay_ipv4, overlay_ipv6) VALUES (?, ?, ?, ?, ?, ?)'
    );
    db.transaction(() => {
      let inserted = 0;
      for (let offset = 1; inserted < nodeCount; offset++) {
        const vip = vipFromOffset(offset);
        if (!vip.usable) continue;
        insert.run(`n${offset}`, 'u', `n${offset}`, `k${offset}`, vip.overlayIpv4, vip.overlayIpv6);
        inserted++;
      }
      db.prepare('UPDATE vip_allocator SET next_offset = ? WHERE id = 1').run(nodeCount + 8);
    })();
  }

  return db;
}

describe('Overlay VIP allocation', () => {
  it('hands out addresses inside 100.64.0.0/10 with the matching IPv6', async () => {
    const db = freshDb();
    const vip = await allocateNextVip(db);

    assert.match(vip.overlayIpv4, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/);
    assert.match(vip.overlayIpv6, /^fd7a:115c:a1e0::[0-9a-f]+$/);
    db.close();
  });

  it('never returns a network or broadcast address', async () => {
    const db = freshDb();

    for (let i = 0; i < 600; i++) {
      const { overlayIpv4 } = await allocateNextVip(db);
      const lastOctet = Number(overlayIpv4.split('.')[3]);
      assert.notStrictEqual(lastOctet, 0, `${overlayIpv4} is a network address`);
      assert.notStrictEqual(lastOctet, 255, `${overlayIpv4} is a broadcast address`);
    }

    db.close();
  });

  it('never repeats an address across many allocations', async () => {
    const db = freshDb();
    const seenV4 = new Set();
    const seenV6 = new Set();

    for (let i = 0; i < 1000; i++) {
      const vip = await allocateNextVip(db);
      assert.ok(!seenV4.has(vip.overlayIpv4), `${vip.overlayIpv4} was handed out twice`);
      assert.ok(!seenV6.has(vip.overlayIpv6), `${vip.overlayIpv6} was handed out twice`);
      seenV4.add(vip.overlayIpv4);
      seenV6.add(vip.overlayIpv6);
    }

    db.close();
  });

  it('skips addresses already assigned outside the allocator', async () => {
    // Seed rows and imported nodes get addresses without going through the counter,
    // and the counter is positioned at migration time, before any of that exists.
    // Both overlay columns are UNIQUE, so an unchecked collision surfaces as a
    // constraint violation the caller cannot do anything about.
    const db = freshDb();
    db.prepare('UPDATE vip_allocator SET next_offset = 1 WHERE id = 1').run();

    const taken = vipFromOffset(1);
    db.prepare(
      'INSERT INTO nodes (id, user_id, name, public_key, overlay_ipv4, overlay_ipv6) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('squatter', 'u', 'squatter', 'k-squatter', taken.overlayIpv4, taken.overlayIpv6);

    const vip = await allocateNextVip(db);

    assert.notStrictEqual(vip.overlayIpv4, taken.overlayIpv4);
    assert.notStrictEqual(vip.overlayIpv6, taken.overlayIpv6);
    db.close();
  });

  it('costs the same at 100 nodes as at 20,000', async () => {
    // The property that matters is not the absolute number but its shape. The old
    // allocator was linear in fleet size; this one must not be, or the ceiling just
    // moves further out instead of going away.
    async function costPerAllocation(nodeCount) {
      const db = freshDb(nodeCount);
      const rounds = 50;

      const start = process.hrtime.bigint();
      for (let i = 0; i < rounds; i++) await allocateNextVip(db);
      const elapsed = Number(process.hrtime.bigint() - start) / 1e6 / rounds;

      db.close();
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
