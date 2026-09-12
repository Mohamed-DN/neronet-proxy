import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';

import {
  markReachable,
  markUnreachable,
  markMocked,
  getDataSourceState,
  subscribeToDataSource,
  mockDataAllowed,
  resolveList,
  resolveOne
} from './dataSource.js';

// mockDataAllowed() reads import.meta.env, which Vite defines at build time and plain
// Node does not. Under the test runner it resolves to false, which is the shipped
// default and the behaviour these cases exercise.

describe('mock data is opt-in', () => {
  it('is disabled unless the build explicitly enables it', () => {
    assert.strictEqual(mockDataAllowed(), false);
  });
});

describe('resolveList distinguishes "empty" from "no answer"', () => {
  beforeEach(() => markReachable());

  it('returns an empty live response as-is', () => {
    // "No nodes are registered" is an answer the operator needs. Replacing it with
    // fixtures is what made a healthy mesh and an empty database look identical.
    const result = resolveList('/nodes', [], [{ id: 'fixture' }]);

    assert.deepStrictEqual(result, []);
    assert.strictEqual(getDataSourceState().isShowingMockData, false);
  });

  it('returns live data when the request succeeded', () => {
    const live = [{ id: 'real-node' }];
    assert.deepStrictEqual(resolveList('/nodes', live, [{ id: 'fixture' }]), live);
  });

  it('returns empty, not fixtures, when the request failed and mocks are off', () => {
    const result = resolveList('/nodes', null, [{ id: 'fixture' }]);

    assert.deepStrictEqual(result, []);
    assert.strictEqual(getDataSourceState().isShowingMockData, false);
  });
});

describe('resolveOne follows the same rules', () => {
  beforeEach(() => markReachable());

  it('passes through a live object', () => {
    const live = { id: 'real' };
    assert.strictEqual(resolveOne('/nodes/1', live, { id: 'fixture' }), live);
  });

  it('returns null rather than a fixture when the request failed', () => {
    assert.strictEqual(resolveOne('/nodes/1', null, { id: 'fixture' }), null);
  });
});

describe('connectivity state is observable', () => {
  beforeEach(() => markReachable());

  it('starts reachable and reports no error', () => {
    const state = getDataSourceState();
    assert.strictEqual(state.backend, 'reachable');
    assert.strictEqual(state.lastError, null);
  });

  it('records the failure reason when the control plane does not answer', () => {
    markUnreachable('fetch failed');

    const state = getDataSourceState();
    assert.strictEqual(state.backend, 'unreachable');
    assert.strictEqual(state.lastError, 'fetch failed');
  });

  it('clears mocked endpoints once the control plane answers again', () => {
    markUnreachable('fetch failed');
    markMocked('/users');
    assert.strictEqual(getDataSourceState().isShowingMockData, true);

    markReachable();

    const state = getDataSourceState();
    assert.strictEqual(state.backend, 'reachable');
    assert.deepStrictEqual(state.mockedEndpoints, []);
    assert.strictEqual(state.isShowingMockData, false);
  });

  it('notifies subscribers immediately and on change', () => {
    const seen = [];
    const unsubscribe = subscribeToDataSource((s) => seen.push(s.backend));

    assert.strictEqual(seen.length, 1, 'subscriber should receive the current state');

    markUnreachable('boom');
    assert.strictEqual(seen[seen.length - 1], 'unreachable');

    unsubscribe();
    markReachable();
    assert.strictEqual(seen[seen.length - 1], 'unreachable', 'unsubscribed listener kept receiving');
  });

  it('survives a subscriber that throws', () => {
    const unsubscribe = subscribeToDataSource(() => {
      throw new Error('subscriber exploded');
    });

    assert.doesNotThrow(() => markUnreachable('still fine'));
    unsubscribe();
  });
});
