import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseFeatures, filterNavSections } from './features.js';
import { api } from './api.js';

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

function stubFetch(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => handler(url);
  return () => {
    globalThis.fetch = original;
  };
}

test('api.features.get asks /api/features and returns what the server said', async () => {
  const seen = [];
  const restore = stubFetch((url) => {
    seen.push(url);
    return { ok: true, status: 200, json: async () => ({ cloud_pc: true }) };
  });
  try {
    assert.deepEqual(await api.features.get(), { cloud_pc: true });
    assert.deepEqual(seen, ['/api/features']);
  } finally {
    restore();
  }
});

test('api.features.get reads an unreachable server as everything off', async () => {
  const restore = stubFetch(() => {
    throw new Error('connection refused');
  });
  try {
    assert.deepEqual(await api.features.get(), { cloud_pc: false });
  } finally {
    restore();
  }
});

test('api.features.get reads an error status as everything off', async () => {
  const restore = stubFetch(() => ({ ok: false, status: 500, json: async () => ({}) }));
  try {
    assert.deepEqual(await api.features.get(), { cloud_pc: false });
  } finally {
    restore();
  }
});
