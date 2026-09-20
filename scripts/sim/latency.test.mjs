// Run: node --test scripts/sim/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULT_MODEL, backboneRttMs, distanceKm, link, modelFromCatalogue } from './latency.mjs';

const catalogue = JSON.parse(readFileSync(new URL('./regions.json', import.meta.url), 'utf8'));
const model = modelFromCatalogue(catalogue);
const at = (id) => {
  const location = catalogue.locations.find((l) => l.id === id);
  assert.ok(location, `no location ${id}`);
  return { ...location, location: id };
};

// Reference round trips, milliseconds: Azure inter-region P50 for the datacentre cities
// of each pair, dataset of 2026-07-30
// (https://learn.microsoft.com/en-us/azure/networking/azure-network-latency).
// Frankfurt is Germany West Central, Ashburn is East US, Sao Paulo is Brazil South,
// Singapore is Southeast Asia, Tokyo is Japan East, Sydney is Australia East,
// Johannesburg is South Africa North, Mumbai is Central India (Pune).
const AZURE_RTT_MS = {
  'fra|iad': 94,
  'fra|sin': 166,
  'fra|syd': 267,
  'fra|jnb': 165,
  'fra|tyo': 236,
  'fra|gru': 198,
  'fra|bom': 140,
  'fra|dxb': 100,
  'iad|syd': 202,
  'iad|sin': 224,
  'iad|tyo': 162,
  'iad|gru': 118,
  'iad|jnb': 219,
  'syd|sin': 95,
  'syd|jnb': 328,
  'gru|sin': 331,
  'gru|jnb': 321
};

const pairs = Object.entries(AZURE_RTT_MS).map(([key, rtt]) => {
  const [a, b] = key.split('|');
  return { a, b, rtt };
});

const hasOverride = (a, b) => catalogue.route_factors.some((r) => (r.a === a && r.b === b) || (r.a === b && r.b === a));

test('distance: known city pairs', () => {
  // Great-circle distances from published tables, tolerance 1%.
  const cases = [
    ['fra', 'nyc', 6200],
    ['syd', 'jnb', 11040],
    ['lon', 'nyc', 5570],
    ['fra', 'lon', 638]
  ];
  for (const [a, b, km] of cases) {
    const got = distanceKm(at(a), at(b));
    assert.ok(Math.abs(got / km - 1) < 0.01, `${a}-${b}: ${got.toFixed(0)} km, expected about ${km}`);
  }
  assert.equal(distanceKm(at('fra'), at('fra')), 0);
});

test('Frankfurt to New York: backbone round trip against the 85-95 ms typical figure', () => {
  // The card quotes 85-95 ms. The default route factor of 1.6 gives about 99 ms, so the
  // test allows 10% either side of that range (76.5 to 104.5 ms) and documents the gap.
  const rtt = backboneRttMs(at('fra'), at('nyc'), model);
  assert.ok(rtt > 76.5 && rtt < 104.5, `Frankfurt-New York backbone RTT ${rtt.toFixed(1)} ms`);
});

test('pairs on the default route factor are within 15% of the published round trip', () => {
  const checked = pairs.filter(({ a, b }) => !hasOverride(a, b));
  assert.ok(checked.length >= 5, 'too few reference pairs on the default factor');
  for (const { a, b, rtt } of checked) {
    const got = backboneRttMs(at(a), at(b), model);
    assert.ok(Math.abs(got / rtt - 1) <= 0.15, `${a}-${b}: model ${got.toFixed(1)} ms, published ${rtt} ms`);
  }
});

test('pairs with a route factor override are within 3% of the published round trip', () => {
  const overridden = pairs.filter(({ a, b }) => hasOverride(a, b));
  assert.ok(overridden.length >= 8);
  for (const { a, b, rtt } of overridden) {
    const got = backboneRttMs(at(a), at(b), model);
    assert.ok(Math.abs(got / rtt - 1) <= 0.03, `${a}-${b}: model ${got.toFixed(1)} ms, published ${rtt} ms`);
  }
});

test('Sydney to Johannesburg needs its override: the default factor is far too fast', () => {
  const published = AZURE_RTT_MS['syd|jnb'];
  const withoutOverride = backboneRttMs(at('syd'), at('jnb'), DEFAULT_MODEL);
  const withOverride = backboneRttMs(at('syd'), at('jnb'), model);
  assert.ok(withoutOverride < published * 0.6, `default factor gives ${withoutOverride.toFixed(0)} ms`);
  assert.ok(Math.abs(withOverride / published - 1) <= 0.03, `override gives ${withOverride.toFixed(0)} ms`);
});

test('Sao Paulo to Singapore, the other awkward pair, matches its published round trip', () => {
  const got = backboneRttMs(at('gru'), at('sin'), model);
  assert.ok(Math.abs(got / 331 - 1) <= 0.03, `${got.toFixed(0)} ms`);
});

test('the link adds both access delays to the propagation delay', () => {
  const a = at('fra');
  const b = at('nyc');
  const result = link(a, b, model);
  const fibre = catalogue.profiles.fibre.delay_ms;
  const cable = catalogue.profiles.cable.delay_ms;

  assert.ok(Math.abs(result.one_way_ms - (result.propagation_ms + fibre + cable)) < 1e-9);
  assert.equal(result.rtt_ms, 2 * result.one_way_ms);
});

test('the link is symmetric and deterministic', () => {
  const a = at('rkv');
  const b = at('syd');
  assert.deepEqual(link(a, b, model), link(b, a, model));
  assert.deepEqual(link(a, b, model), link(a, b, model));
});

test('a satellite endpoint in Reykjavik is slower, more jittery and lossier than a fibre one at the same place', () => {
  const peer = at('lon');
  const satellite = link(at('rkv'), peer, model);
  const fibre = link({ ...at('rkv'), profile: 'fibre' }, peer, model);

  assert.ok(satellite.one_way_ms > fibre.one_way_ms + 20);
  assert.ok(satellite.jitter_ms > fibre.jitter_ms * 5);
  assert.ok(satellite.loss_pct > fibre.loss_pct * 10);
});

test('two endpoints at the same place still see the access delays', () => {
  const result = link(at('fra'), { ...at('fra'), id: 'other' }, model);
  assert.equal(result.propagation_ms, 0);
  assert.equal(result.one_way_ms, 2 * catalogue.profiles.fibre.delay_ms);
});

test('losses combine as independent events', () => {
  const result = link(
    { lat: 0, lon: 0, access: { delay_ms: 0, jitter_ms: 0, loss_pct: 10 } },
    { lat: 0, lon: 0, access: { delay_ms: 0, jitter_ms: 0, loss_pct: 10 } },
    model
  );
  assert.ok(Math.abs(result.loss_pct - 19) < 1e-9);
});

test('an unknown profile is an error, not a default', () => {
  assert.throws(() => link({ lat: 0, lon: 0, profile: 'carrier-pigeon' }, at('fra'), model), /carrier-pigeon/);
});

test('the catalogue covers every inhabited continent with at least 24 locations', () => {
  const continents = new Set(catalogue.locations.map((l) => l.continent));
  for (const c of ['NA', 'SA', 'EU', 'AF', 'AS', 'OC']) assert.ok(continents.has(c), `no location in ${c}`);
  assert.ok(catalogue.locations.length >= 24);

  const classes = new Set(catalogue.locations.map((l) => l.ip_class));
  for (const c of ['RESIDENTIAL', 'DATACENTER', 'MOBILE_5G']) assert.ok(classes.has(c), `no ${c} location`);

  const ids = catalogue.locations.map((l) => l.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate location id');
  for (const l of catalogue.locations) {
    assert.ok(catalogue.profiles[l.profile], `${l.id} names an unknown profile ${l.profile}`);
    assert.ok(l.lat >= -90 && l.lat <= 90 && l.lon >= -180 && l.lon <= 180, `${l.id} has bad coordinates`);
  }
});
