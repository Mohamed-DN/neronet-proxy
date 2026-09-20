// Run: node --test scripts/sim/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildPlan, renderCompose } from './fleet.mjs';

const catalogue = JSON.parse(readFileSync(new URL('./regions.json', import.meta.url), 'utf8'));
const plan = (nodes, seed = 1, extra = {}) => buildPlan({ catalogue, nodes, seed, ...extra });
const nodesOf = (p) => p.entities.filter((e) => e.kind === 'node');

test('the same arguments give the same plan and the same compose file', () => {
  assert.deepEqual(plan(24, 1), plan(24, 1));
  assert.equal(renderCompose(plan(24, 1)), renderCompose(plan(24, 1)));
});

test('another seed gives another fleet', () => {
  const a = nodesOf(plan(24, 1)).map((e) => e.location);
  const b = nodesOf(plan(24, 2)).map((e) => e.location);
  assert.notDeepEqual(a, b);
});

test('the fleet has the requested size and the stated exit ratio', () => {
  for (const n of [2, 24, 60]) {
    const p = plan(n, 7, { exitRatio: 0.25 });
    const nodes = nodesOf(p);
    assert.equal(nodes.length, n);
    assert.equal(nodes.filter((e) => e.role === 'exit').length, Math.max(1, Math.round(n * 0.25)));
  }
});

test('exit nodes are placed in datacentre locations only', () => {
  const exits = nodesOf(plan(60, 3)).filter((e) => e.role === 'exit');
  assert.ok(exits.length > 0);
  for (const e of exits) assert.equal(e.ip_class, 'DATACENTER', `${e.id} is ${e.ip_class}`);
});

test('a fleet of 24 covers 24 different locations and every continent', () => {
  const nodes = nodesOf(plan(24, 1));
  assert.equal(new Set(nodes.map((e) => e.location)).size, 24);

  const continents = new Set(nodes.map((e) => catalogue.locations.find((l) => l.id === e.location).continent));
  assert.ok(continents.size >= 5, `only ${[...continents]}`);
});

test('a fleet of 60 uses every location before it uses one three times', () => {
  const counts = new Map();
  for (const e of nodesOf(plan(60, 1))) counts.set(e.location, (counts.get(e.location) ?? 0) + 1);
  assert.equal(counts.size, catalogue.locations.length);
  assert.ok(Math.max(...counts.values()) <= 3);
});

test('service names are unique and valid as DNS labels', () => {
  const p = plan(60, 1);
  const services = p.entities.map((e) => e.service);
  assert.equal(new Set(services).size, services.length);
  for (const s of services) assert.match(s, /^[a-z0-9][a-z0-9-]*$/);
});

test('every unordered pair is modelled once, with the values the shaping will apply', () => {
  const p = plan(24, 1);
  const n = p.entities.length;
  assert.equal(p.pairs.length, (n * (n - 1)) / 2);

  const ids = new Set(p.entities.map((e) => e.id));
  const seen = new Set();
  for (const pair of p.pairs) {
    assert.ok(ids.has(pair.a) && ids.has(pair.b));
    const key = [pair.a, pair.b].sort().join('|');
    assert.ok(!seen.has(key), `duplicate ${key}`);
    seen.add(key);
    assert.equal(pair.rtt_ms, Math.round(2 * pair.one_way_ms * 10) / 10);
    assert.ok(pair.one_way_ms > 0);
  }
});

test('the plan places the control plane at the home region and the relays in their regions', () => {
  const p = plan(6, 1, { home: 'ams', derpRegions: ['iad', 'sin'] });
  const control = p.entities.find((e) => e.kind === 'control');
  assert.equal(control.location, 'ams');
  assert.equal(control.service, 'frontend');
  assert.deepEqual(
    p.entities.filter((e) => e.kind === 'derp').map((e) => e.location),
    ['iad', 'sin']
  );
});

test('the compose override declares each service once, with the declared location as flags', () => {
  const p = plan(6, 1);
  const yml = renderCompose(p, '--nodes 6 --seed 1');

  for (const e of nodesOf(p)) {
    assert.equal(yml.split(`\n  ${e.service}:\n`).length - 1, 1, `${e.service} is not declared once`);
    assert.ok(yml.includes(`"-city", ${JSON.stringify(e.city)}`));
    assert.ok(yml.includes(`"-lat", "${e.lat}"`));
    assert.ok(yml.includes(`"-lon", "${e.lon}"`));
  }

  const exits = nodesOf(p).filter((e) => e.role === 'exit').length;
  assert.equal(yml.split('"-enable-exit=true"').length - 1, exits);
  assert.ok(yml.includes('profiles: ["fleet"]'));
  assert.ok(!yml.includes('container_name'), 'a fixed container name would break parallel stacks');
  assert.ok(!yml.includes('ports:'), 'the fleet must not publish host ports');
  assert.ok(!yml.includes('\n  frontend:'), 'the control plane is not part of the override');
});

test('bad arguments are refused', () => {
  assert.throws(() => plan(0), /positive integer/);
  assert.throws(() => plan(3.5), /positive integer/);
  assert.throws(() => plan(3, 1, { home: 'atlantis' }), /atlantis/);
  assert.throws(() => plan(3, 1, { exitRatio: 2 }), /exit-ratio/);
});
