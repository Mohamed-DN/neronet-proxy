import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { clearSession, storeSession } from '../authToken';
import { useConnectionTest } from './probe';
import { visibleInterval, LIVE_POLL_MS } from './polling';
import { invalidateForEvent } from './useLiveUpdates';
import { queryKeys } from './keys';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** A control plane that answers the POST with `first` and each following GET from `reads`. */
function plane(first: unknown, reads: unknown[] = [], status = 200) {
  const calls: { method: string; url: string }[] = [];
  const queue = [...reads];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ method, url });
    if (method === 'POST') return json(first, status);
    return json(queue.length > 1 ? queue.shift() : queue[0]);
  });
  return { fn, calls };
}

describe('the connection test', () => {
  beforeEach(() => {
    storeSession({ token: 'test-token' });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    clearSession();
  });

  it('asks the control plane, reads the same request until it is answered, and shows that figure', async () => {
    const { fn, calls } = plane({ request_id: 'prb-1', state: 'pending' }, [
      { request_id: 'prb-1', state: 'measuring' },
      { request_id: 'prb-1', state: 'replied', rtt_ms: 4.25, method: 'icmp', answered_at: '2026-11-23T10:00:00Z' }
    ]);
    vi.stubGlobal('fetch', fn);
    const { result } = renderHook(() => useConnectionTest('dev-1'));
    expect(result.current.view).toBeNull();

    await act(async () => {
      await result.current.start();
    });
    expect(result.current.view).toEqual({ state: 'replied', rttMs: 4.25, answeredAt: '2026-11-23T10:00:00Z' });
    expect(calls[0]).toEqual({ method: 'POST', url: '/api/nodes/dev-1/probe' });
    expect(calls.slice(1).every((c) => c.method === 'GET' && c.url === '/api/nodes/dev-1/probe/prb-1')).toBe(true);
    expect(calls.length).toBeGreaterThanOrEqual(3);
  });

  it('shows measuring while the request is open', async () => {
    const { fn } = plane({ request_id: 'prb-1', state: 'pending' }, [{ request_id: 'prb-1', state: 'measuring' }]);
    vi.stubGlobal('fetch', fn);
    const { result } = renderHook(() => useConnectionTest('dev-1'));
    act(() => {
      void result.current.start();
    });
    await waitFor(() => expect(result.current.view).toEqual({ state: 'measuring' }));
    expect(result.current.running).toBe(true);
  });

  it.each([
    [{ request_id: 'p', state: 'no_reply', last_contact_at: '2026-11-23T09:59:50Z' }, 'no_reply'],
    [{ state: 'not_connected', last_contact_at: null }, 'not_connected'],
    [{ state: 'gateway_unreachable' }, 'gateway_unreachable'],
    [{ state: 'unsupported' }, 'unsupported']
  ])('maps %j to %s without inventing a number', async (answer, state) => {
    vi.stubGlobal('fetch', plane(answer, [answer]).fn);
    const { result } = renderHook(() => useConnectionTest('dev-1'));
    await act(async () => {
      await result.current.start();
    });
    expect(result.current.view?.state).toBe(state);
    expect(result.current.view).not.toHaveProperty('rttMs');
  });

  it('says rate limited on 429 and failed on any other error', async () => {
    vi.stubGlobal('fetch', plane({ error: 'slow down' }, [], 429).fn);
    const limited = renderHook(() => useConnectionTest('dev-1'));
    await act(async () => {
      await limited.result.current.start();
    });
    expect(limited.result.current.view).toEqual({ state: 'rate_limited' });

    vi.stubGlobal('fetch', plane({ error: 'boom' }, [], 500).fn);
    const failed = renderHook(() => useConnectionTest('dev-1'));
    await act(async () => {
      await failed.result.current.start();
    });
    expect(failed.result.current.view).toEqual({ state: 'failed' });
  });

  it('forgets the result when the device changes', async () => {
    vi.stubGlobal('fetch', plane({ state: 'unsupported' }, [{ state: 'unsupported' }]).fn);
    const { result, rerender } = renderHook(({ id }) => useConnectionTest(id), { initialProps: { id: 'dev-1' } });
    await act(async () => {
      await result.current.start();
    });
    expect(result.current.view?.state).toBe('unsupported');
    rerender({ id: 'dev-2' });
    await waitFor(() => expect(result.current.view).toBeNull());
  });
});

describe('live refresh', () => {
  it('node:updated refetches the fleet, the topology and that one device', () => {
    const seen: unknown[] = [];
    const keys = invalidateForEvent((key) => seen.push(key), { event: 'node:updated', node_id: 'dev-9' });
    expect(keys).toContainEqual(queryKeys.nodes);
    expect(keys).toContainEqual(queryKeys.statsTopology);
    expect(keys).toContainEqual(queryKeys.node('dev-9'));
    expect(seen.length).toBe(keys.length);
  });

  it('polls every 10 seconds while the tab is visible and not at all while it is hidden', () => {
    expect(LIVE_POLL_MS).toBe(10_000);
    const state = vi.spyOn(document, 'visibilityState', 'get');
    state.mockReturnValue('visible');
    expect(visibleInterval()).toBe(10_000);
    state.mockReturnValue('hidden');
    expect(visibleInterval()).toBe(false);
    state.mockRestore();
  });
});
