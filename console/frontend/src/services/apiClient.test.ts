import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError, apiRequest } from './apiClient';
import { clearSession, readAccessToken, storeSession } from './authToken';
import { getConnectionState, resetConnectionState } from './connection';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

describe('apiRequest', () => {
  beforeEach(() => {
    localStorage.clear();
    resetConnectionState();
  });

  afterEach(() => {
    clearSession();
    vi.unstubAllGlobals();
  });

  it('sends the stored access token as a bearer header', async () => {
    storeSession({ token: 'access-1', refreshToken: 'refresh-1' });
    const fetchMock = vi.fn(async () => jsonResponse({ nodes: [] }));
    vi.stubGlobal('fetch', fetchMock);

    await apiRequest('/nodes');

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/nodes');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer access-1');
  });

  it('throws ApiError with the server message and status on a 4xx', async () => {
    storeSession({ token: 'access-1' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ error: 'Node not found' }, 404))
    );

    const error = await apiRequest('/nodes/missing').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(404);
    expect((error as ApiError).message).toBe('Node not found');
    expect((error as ApiError).isClientError).toBe(true);
  });

  it('reports a transport failure as status 0 and marks the console offline', async () => {
    storeSession({ token: 'access-1' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      })
    );

    const error = await apiRequest('/nodes').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(0);
    expect((error as ApiError).isUnreachable).toBe(true);
    expect(getConnectionState().status).toBe('offline');
    expect(getConnectionState().lastError).toBe('Failed to fetch');
  });

  it('refreshes once on a 401 and retries the original request', async () => {
    storeSession({ token: 'expired', refreshToken: 'refresh-1' });
    const calls: string[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      if (url === '/api/auth/refresh') return jsonResponse({ token: 'fresh' });
      const auth = (init?.headers as Record<string, string>).Authorization;
      if (auth === 'Bearer expired') return jsonResponse({ error: 'Token expired' }, 401);
      return jsonResponse({ nodes: [{ id: 'n1' }] });
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const body = await apiRequest<{ nodes: { id: string }[] }>('/nodes');

    expect(body.nodes).toEqual([{ id: 'n1' }]);
    expect(calls).toEqual(['GET /api/nodes', 'POST /api/auth/refresh', 'GET /api/nodes']);
    expect(readAccessToken()).toBe('fresh');
  });

  it('shares one refresh between concurrent callers', async () => {
    storeSession({ token: 'expired', refreshToken: 'refresh-1' });
    let refreshes = 0;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/auth/refresh') {
        refreshes += 1;
        return jsonResponse({ token: 'fresh' });
      }
      const auth = (init?.headers as Record<string, string>).Authorization;
      if (auth === 'Bearer expired') return jsonResponse({ error: 'Token expired' }, 401);
      return jsonResponse({ ok: true });
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    await Promise.all([apiRequest('/nodes'), apiRequest('/users'), apiRequest('/acl/rules')]);

    expect(refreshes).toBe(1);
  });

  it('clears the session when the refresh token is rejected', async () => {
    storeSession({ token: 'expired', refreshToken: 'spent' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === '/api/auth/refresh') return jsonResponse({ error: 'revoked' }, 401);
        return jsonResponse({ error: 'Token expired' }, 401);
      }) as unknown as typeof fetch
    );

    await apiRequest('/nodes').catch(() => undefined);

    expect(readAccessToken()).toBeNull();
  });

  it('does not attempt a refresh for a failed sign-in', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: 'Invalid credentials' }, 401));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    await apiRequest('/auth/login', { method: 'POST', body: { username: 'a', password: 'b' } }).catch(() => undefined);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('propagates an abort without reporting the control plane as unreachable', async () => {
    storeSession({ token: 'access-1' });
    const controller = new AbortController();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        init?.signal?.throwIfAborted();
        throw new DOMException('The operation was aborted.', 'AbortError');
      }) as unknown as typeof fetch
    );
    controller.abort();

    const error = await apiRequest('/nodes', { signal: controller.signal }).catch((e: unknown) => e);

    expect((error as DOMException).name).toBe('AbortError');
    expect(getConnectionState().status).toBe('unknown');
  });
});
