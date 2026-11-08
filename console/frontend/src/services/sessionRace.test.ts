import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError, apiRequest, resumeSession } from './apiClient';
import { clearSession, readAccessToken, storeAccessToken, storeSession } from './authToken';
import { signIn, signOut } from './session';
import { getConnectionState, resetConnectionState } from './connection';

const accountB = { id: 'account-b', username: 'Account B', role: 'user', organization_id: 'org-b' };
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('Credential changes reject obsolete network results', () => {
  beforeEach(() => {
    clearSession();
    resetConnectionState();
    storeSession({ token: 'fixture-access-a', role: 'user' });
  });
  afterEach(() => {
    clearSession();
    vi.unstubAllGlobals();
  });

  for (const success of [true, false]) {
    it(`does not ${success ? 'overwrite' : 'clear'} B after a late refresh for A`, async () => {
      const response = deferred<Response>();
      const entered = deferred<void>();
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL) => {
          if (String(input) === '/api/auth/refresh') {
            entered.resolve();
            return response.promise;
          }
          if (String(input) === '/api/auth/login') return json({ token: 'fixture-access-b', user: accountB });
          return json({ error: 'Unexpected credential fixture endpoint' }, 404);
        })
      );
      const oldRefresh = resumeSession().catch(() => null);
      await entered.promise;
      // This changes the admitted credential directly, like another completed
      // session adoption. The test asserts memory isolation, not HttpOnly cookies.
      storeSession({ token: 'fixture-access-b', role: 'user' });
      response.resolve(success ? json({ token: 'fixture-refreshed-a' }) : json({ error: 'A revoked' }, 401));
      await oldRefresh;
      expect(readAccessToken()).toBe('fixture-access-b');
    });
  }

  it('does not retry a POST started under A using the newly admitted B credential', async () => {
    const response = deferred<Response>();
    const sent = deferred<void>();
    const postCredentials: string[] = [];
    let refreshes = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === '/api/auth/refresh') {
          refreshes++;
          return json({ token: 'fixture-refreshed-b' });
        }
        if (url === '/api/resource-operation') {
          postCredentials.push((init?.headers as Record<string, string>).Authorization ?? 'none');
          if (postCredentials.length === 1) {
            sent.resolve();
            return response.promise;
          }
          return json({ mutated: true });
        }
        return json({ error: 'Unexpected credential fixture endpoint' }, 404);
      })
    );
    const oldPost = apiRequest('/resource-operation', { method: 'POST', body: { target_id: 'resource-a' } }).catch(
      (error: unknown) => error
    );
    await sent.promise;
    storeSession({ token: 'fixture-access-b', role: 'user' });
    response.resolve(json({ error: 'A expired' }, 401));
    await oldPost;
    expect(postCredentials).toEqual(['Bearer fixture-access-a']);
    expect(refreshes).toBe(0);
    expect(readAccessToken()).toBe('fixture-access-b');
  });

  it('does not clear B when an earlier logout response arrives after B signed in', async () => {
    const response = deferred<Response>();
    const entered = deferred<void>();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input) === '/api/auth/logout') {
          entered.resolve();
          return response.promise;
        }
        if (String(input) === '/api/auth/login') return json({ token: 'fixture-access-b', user: accountB });
        return json({ error: 'Unexpected credential fixture endpoint' }, 404);
      })
    );
    const oldLogout = signOut();
    await entered.promise;
    await signIn('account-b', 'fixture-password');
    response.resolve(json({ success: true }));
    await oldLogout;
    expect(readAccessToken()).toBe('fixture-access-b');
  });

  it('admits the latest sign-in when two credential responses arrive in request order', async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
        JSON.parse(String(init?.body)).username === 'account-a' ? first.promise : second.promise
      )
    );
    const signingA = signIn('account-a', 'fixture-password').catch((error: unknown) => error);
    const signingB = signIn('account-b', 'fixture-password').catch((error: unknown) => error);
    first.resolve(json({ token: 'fixture-new-access-a', user: { ...accountB, id: 'account-a' } }));
    const oldResult = await signingA;
    second.resolve(json({ token: 'fixture-access-b', user: accountB }));
    const accepted = await signingB;
    expect(oldResult).toBeInstanceOf(DOMException);
    expect(accepted).toEqual(accountB);
    expect(readAccessToken()).toBe('fixture-access-b');
  });

  it('does not publish an obsolete A credential when the later B login fails', async () => {
    clearSession();
    const first = deferred<Response>();
    const second = deferred<Response>();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
        JSON.parse(String(init?.body)).username === 'account-a' ? first.promise : second.promise
      )
    );
    const signingA = signIn('account-a', 'fixture-password').catch((error: unknown) => error);
    const signingB = signIn('account-b', 'fixture-password').catch((error: unknown) => error);
    first.resolve(json({ token: 'fixture-new-access-a', user: { ...accountB, id: 'account-a' } }));
    await signingA;
    second.resolve(json({ error: 'B credentials refused' }, 401));
    await signingB;
    // This proves only the JS credential state. Browser Set-Cookie/reload is a
    // separate gate and cannot be inferred from this Response fixture.
    expect(readAccessToken()).toBeNull();
  });

  it('ends local credentials when logout begins rather than waiting for its response', async () => {
    const response = deferred<Response>();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => response.promise)
    );
    const ending = signOut();
    try {
      expect(readAccessToken()).toBeNull();
    } finally {
      response.resolve(json({ success: true }));
      await ending;
    }
  });

  for (const success of [true, false]) {
    it(`keeps a newer same-authority credential when an older API refresh ${success ? 'succeeds' : 'is refused'}`, async () => {
      const refresh = deferred<Response>();
      const entered = deferred<void>();
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL) => {
          if (String(input) === '/api/auth/refresh') {
            entered.resolve();
            return refresh.promise;
          }
          return json({ error: 'Old access expired' }, 401);
        })
      );
      const oldRequest = apiRequest('/same-authority-operation').catch((error: unknown) => error);
      await entered.promise;
      storeAccessToken('fixture-a-revision-2');
      refresh.resolve(success ? json({ token: 'fixture-refreshed-a' }) : json({ error: 'Old refresh refused' }, 401));
      const outcome = await oldRequest;
      expect(readAccessToken()).toBe('fixture-a-revision-2');
      expect(outcome).toBeInstanceOf(DOMException);
      expect((outcome as DOMException).name).toBe('AbortError');
    });
  }

  it('reuses one verified refresh for a late 401 from the same original credential', async () => {
    const refresh = deferred<Response>();
    const refreshStarted = deferred<void>();
    const late401 = deferred<Response>();
    let refreshes = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === '/api/auth/refresh') {
          refreshes++;
          refreshStarted.resolve();
          return refresh.promise;
        }
        const auth = (init?.headers as Record<string, string>).Authorization;
        if (auth === 'Bearer fixture-access-a')
          return url.endsWith('/one') ? json({ error: 'Expired' }, 401) : late401.promise;
        return json({ requested: url });
      })
    );
    const first = apiRequest<{ requested: string }>('/one');
    await refreshStarted.promise;
    const second = apiRequest<{ requested: string }>('/two');
    refresh.resolve(json({ token: 'fixture-refreshed-a' }));
    expect(await first).toEqual({ requested: '/api/one' });
    late401.resolve(json({ error: 'Earlier credential expired' }, 401));
    expect(await second).toEqual({ requested: '/api/two' });
    expect(refreshes).toBe(1);
  });

  it('preserves the credential and reports the transport failure when refresh cannot reach the server', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input) === '/api/auth/refresh') throw new TypeError('Fixture refresh network unavailable');
        return json({ error: 'Access expired' }, 401);
      })
    );
    const result = await apiRequest('/network-interruption').catch((error: unknown) => error);
    expect(readAccessToken()).toBe('fixture-access-a');
    expect(result).toBeInstanceOf(ApiError);
    expect((result as ApiError).status).toBe(0);
    expect(getConnectionState().status).toBe('offline');
  });

  it.each([503, 429])(
    'does not erase credentials when refresh answers HTTP %s without refusing authentication',
    async (status) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL) =>
          String(input) === '/api/auth/refresh'
            ? json({ error: 'Refresh temporarily unavailable' }, status)
            : json({ error: 'Access expired' }, 401)
        )
      );
      const result = await apiRequest('/refresh-interruption').catch((error: unknown) => error);
      expect(readAccessToken()).toBe('fixture-access-a');
      expect(result).toBeInstanceOf(ApiError);
      expect((result as ApiError).status).toBe(status);
    }
  );
});
