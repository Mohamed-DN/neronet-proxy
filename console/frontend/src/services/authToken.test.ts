import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The console kept its access token and its refresh token in localStorage, where any
// script running on the origin could read them. The access token now lives in memory
// and the refresh token only in the HttpOnly cookie the control plane sets.

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('session storage', () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('keeps no token in web storage through sign-in, refresh and sign-out', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/auth/login') {
        return jsonResponse({ token: 'access-1', refreshToken: 'refresh-1', user: { id: 'u1', username: 'a' } });
      }
      if (url === '/api/auth/refresh') return jsonResponse({ token: 'access-2', refreshToken: 'refresh-2' });
      const auth = (init?.headers as Record<string, string>).Authorization;
      if (auth === 'Bearer access-1') return jsonResponse({ error: 'Token expired' }, 401);
      return jsonResponse({ ok: true });
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const { signIn, signOut } = await import('./session');
    const { apiRequest } = await import('./apiClient');
    const { readAccessToken } = await import('./authToken');

    await signIn('a', 'b');
    await apiRequest('/nodes');
    expect(readAccessToken()).toBe('access-2');
    await signOut();

    expect(setItem).not.toHaveBeenCalled();
    expect(JSON.stringify({ ...localStorage })).not.toContain('refresh-');
    expect(JSON.stringify({ ...sessionStorage })).not.toContain('access-');
  });

  it('refreshes with the cookie and sends no token in the body', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/api/auth/refresh') return jsonResponse({ token: 'fresh' });
      return jsonResponse({ error: 'Token expired' }, 401);
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const { resumeSession } = await import('./apiClient');
    const { readAccessToken } = await import('./authToken');

    expect(await resumeSession()).toBe('fresh');
    expect(readAccessToken()).toBe('fresh');

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.credentials).toBe('same-origin');
    expect(String(init.body)).toBe('{}');
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('resumes nothing when there is no refresh cookie', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ error: 'Missing token for refresh' }, 401)) as unknown as typeof fetch
    );

    const { resumeSession } = await import('./apiClient');
    const { readAccessToken } = await import('./authToken');

    expect(await resumeSession()).toBeNull();
    expect(readAccessToken()).toBeNull();
  });

  it('removes the tokens an earlier version left in localStorage', async () => {
    localStorage.setItem('neronet_jwt_token', 'old-access');
    localStorage.setItem('neronet_refresh_token', 'old-refresh');
    localStorage.setItem('neronet_active_role', 'super-admin');

    const { readAccessToken } = await import('./authToken');

    expect(localStorage.getItem('neronet_jwt_token')).toBeNull();
    expect(localStorage.getItem('neronet_refresh_token')).toBeNull();
    expect(localStorage.getItem('neronet_active_role')).toBeNull();
    expect(readAccessToken()).toBeNull();
  });
});
