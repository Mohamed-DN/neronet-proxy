import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseFeatures, filterNavSections } from './features.js';

const sections = [
  { key: 'mesh', title: 'Mesh', items: [{ id: 'overview' }, { id: 'nodes' }] },
  { key: 'compute', title: 'Compute', items: [{ id: 'cloudpc', feature: 'cloud_pc' }] },
  { key: 'security', title: 'Security', items: [{ id: 'risk' }] }
];

const ids = (list) => list.flatMap((s) => s.items.map((i) => i.id));

test('menu entry for Cloud PC is absent when the server reports the flag off', () => {
  const shown = filterNavSections(sections, { cloud_pc: false });
  assert.deepEqual(ids(shown), ['overview', 'nodes', 'risk']);
});

test('the section that held only Cloud PC disappears with it', () => {
  const shown = filterNavSections(sections, { cloud_pc: false });
  assert.deepEqual(
    shown.map((s) => s.key),
    ['mesh', 'security']
  );
});

test('menu entry for Cloud PC returns when the server reports the flag on', () => {
  const shown = filterNavSections(sections, { cloud_pc: true });
  assert.deepEqual(ids(shown), ['overview', 'nodes', 'cloudpc', 'risk']);
});

test('items without a feature key are always shown', () => {
  assert.deepEqual(ids(filterNavSections(sections, undefined)), ['overview', 'nodes', 'risk']);
});

test('parseFeatures reads only a literal true as on', () => {
  assert.deepEqual(parseFeatures({ cloud_pc: true }), { cloud_pc: true });
  for (const body of [null, undefined, {}, { cloud_pc: 'true' }, { cloud_pc: 1 }, { cloud_pc: false }]) {
    assert.deepEqual(parseFeatures(body), { cloud_pc: false }, JSON.stringify(body));
  }
});
