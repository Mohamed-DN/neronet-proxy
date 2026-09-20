// Run: node --test scripts/sim/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildPlan } from './fleet.mjs';
import { pairIndex } from './lib/sim.mjs';
import { resetScript, shapeScript } from './lib/tc.mjs';
import { allowedDeviation, judge, parsePingOutput, pingScript } from './measure.mjs';

const catalogue = JSON.parse(readFileSync(new URL('./regions.json', import.meta.url), 'utf8'));
const plan = buildPlan({ catalogue, nodes: 60, seed: 1 });
const index = pairIndex(plan);
const self = plan.entities.find((e) => e.kind === 'node');
const peers = plan.entities
  .filter((e) => e.id !== self.id)
  .map((e, i) => ({ id: e.id, ip: `10.89.${Math.floor(i / 200)}.${(i % 200) + 2}` }));
const script = shapeScript(peers, (id) => index.get(`${self.id}|${id}`));
const lines = script.split('\n');

test('one class, one netem leaf and one filter per peer, and nothing else', () => {
  assert.equal(peers.length, 66);
  assert.equal(lines.filter((l) => l.includes(' netem ')).length, peers.length);
  assert.equal(lines.filter((l) => l.startsWith('tc filter add')).length, peers.length);
  assert.equal(lines.filter((l) => l.startsWith('tc class add') && !l.includes('classid 1:1 ')).length, peers.length);
});

test('every peer is steered to a class of its own by destination address', () => {
  const classes = new Set();
  for (const peer of peers) {
    const filter = lines.find((l) => l.includes(`match ip dst ${peer.ip}/32`));
    assert.ok(filter, `no filter for ${peer.ip}`);
    const flowid = filter.match(/flowid (1:[0-9a-f]+)$/)[1];
    assert.ok(!classes.has(flowid), `class ${flowid} is used twice`);
    classes.add(flowid);
  }
});

test('each leaf carries the one-way delay, jitter and loss of the plan for that peer', () => {
  for (const peer of peers) {
    const pair = index.get(`${self.id}|${peer.id}`);
    const flowid = lines.find((l) => l.includes(`match ip dst ${peer.ip}/32`)).match(/flowid 1:([0-9a-f]+)$/)[1];
    const leaf = lines.find((l) => l.includes(`parent 1:${flowid} handle ${flowid}: netem`));
    assert.ok(leaf, `no netem leaf for class ${flowid}`);
    assert.ok(leaf.includes(`delay ${pair.one_way_ms.toFixed(1)}ms ${pair.jitter_ms.toFixed(1)}ms`), leaf);
    if (pair.loss_pct > 0) assert.ok(leaf.includes(`loss ${pair.loss_pct.toFixed(3)}%`), leaf);
  }
});

test('the default class is unshaped, so traffic to non-peers is untouched', () => {
  assert.ok(lines.includes('tc qdisc add dev "$IF" root handle 1: htb default 1'));
  const defaultClass = lines.find((l) => l.includes('classid 1:1 '));
  assert.ok(defaultClass && !defaultClass.includes('netem'));
  assert.ok(!lines.some((l) => l.includes('netem') && l.includes('parent 1:1 ')));
});

test('the script removes an earlier configuration before it installs a new one, so it can run twice', () => {
  const del = lines.findIndex((l) => l.startsWith('tc qdisc del'));
  const add = lines.findIndex((l) => l.startsWith('tc qdisc add'));
  assert.ok(del >= 0 && del < add);
  assert.ok(lines[del].endsWith('|| true'), 'the first run has nothing to delete and must not fail');
});

test('the reset script only removes', () => {
  const reset = resetScript();
  assert.ok(reset.includes('tc qdisc del'));
  assert.ok(!reset.includes('tc qdisc add') && !reset.includes('netem'));
});

test('a pair missing from the plan is an error', () => {
  assert.throws(() => shapeScript([{ id: 'ghost', ip: '10.0.0.9' }], () => undefined), /ghost/);
});

test('the tolerance is the larger of 3 ms and 15%', () => {
  assert.equal(allowedDeviation(10), 3);
  assert.equal(allowedDeviation(20), 3);
  assert.equal(allowedDeviation(200), 30);
});

test('judge accepts a value inside the tolerance and refuses one outside it', () => {
  assert.equal(judge(100, 112, 20, 20).ok, true);
  assert.equal(judge(100, 116, 20, 20).ok, false);
  assert.equal(judge(100, 84, 20, 20).ok, false);
  assert.equal(judge(10, 12.9, 20, 20).ok, true);
  assert.equal(judge(10, 13.1, 20, 20).ok, false);
});

test('judge refuses a pair that mostly did not answer', () => {
  assert.equal(judge(100, 100, 5, 20).ok, false);
  assert.equal(judge(100, null, 0, 20).ok, false);
});

test('ping output is parsed into one median per target', () => {
  const parsed = parsePingOutput('derp-fra 12.500 20\nclient-syd-1 nan 0\n\n');
  assert.deepEqual(parsed, [
    { id: 'derp-fra', median_ms: 12.5, received: 20 },
    { id: 'client-syd-1', median_ms: null, received: 0 }
  ]);
});

test('the ping script starts one background ping per target and waits for all of them', () => {
  const s = pingScript(
    [
      { id: 'a', ip: '10.0.0.2' },
      { id: 'b', ip: '10.0.0.3' }
    ],
    20
  );
  assert.equal(s.split('\n').filter((l) => l.startsWith('( ping ')).length, 2);
  assert.ok(s.includes('ping -n -c 20 -i 0.2 -W 4 10.0.0.2'));
  assert.ok(s.trimEnd().endsWith('wait'));
});
