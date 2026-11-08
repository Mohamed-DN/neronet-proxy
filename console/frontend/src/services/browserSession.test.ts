import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Browser-v2 client behaviour against a scripted control plane. The server's
// own guarantees are proven by console/backend/tests/browser_v2_protocol.test.js;
// this proves the console never adopts a late candidate and never sends a token.

type Handler = (body: Record<string, unknown>, init: RequestInit) => Promise<Response> | Response;
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

async function loadV2() {
  vi.resetModules();
  vi.stubEnv('VITE_BROWSER_PROTOCOL', '2');
  const browser = await import('./browserContext');
  browser.resetBrowserContextForTests();
  const session = await import('./session');
  const token = await import('./authToken');
  return { browser, session, token };
}

describe('Browser-v2 console session', () => {
  let routes: Record<string, Handler>;
  let calls: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[];

  beforeEach(() => {
    // jsdom has no IndexedDB: the module falls back to localStorage, shared by tests.
    localStorage.removeItem('neronet-browser-context');
    calls = [];
    routes = {
      '/api/auth/browser/context': () => json(200, { context_id: 'ctx', latest_intent: '0', selected: null }),
      '/api/auth/browser/intent': () => json(200, { state: 'registered' }),
      '/api/auth/browser/select': (body) =>
        json(200, { selected: { sid: 'sid-' + String(body.issuance_id), issuance_id: body.issuance_id } })
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit = {}) => {
        const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ url, headers: (init.headers ?? {}) as Record<string, string>, body });
        const handler = routes[url];
        if (!handler) return json(404, { error: 'unexpected ' + url });
        return handler(body, init);
      })
    );
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('selects the candidate of the latest intent and never sends Authorization', async () => {
    const { session, token } = await loadV2();
    routes['/api/auth/login'] = (body) =>
      json(200, {
        candidate: { sid: 's1', issuance_id: 'issued-for-' + String(body.operation_id) },
        user: { id: 'u1', username: 'u1' }
      });
    const user = await session.signIn('u1', 'pw');
    expect(user.id).toBe('u1');
    const select = calls.find((call) => call.url === '/api/auth/browser/select');
    expect(select).toBeDefined();
    expect(token.readAccessToken()).toBe(select!.body.issuance_id);
    const login = calls.find((call) => call.url === '/api/auth/login')!;
    expect(login.headers.Authorization).toBeUndefined();
    expect(login.headers['X-NeroNet-Browser-Protocol']).toBe('2');
    expect(login.body.operation_id).toBeTruthy();
  });

  it('never selects a late A after B failed (A200 held, B401, A arrives)', async () => {
    const { session, token } = await loadV2();
    let releaseA!: () => void;
    const heldA = new Promise<void>((resolve) => (releaseA = resolve));
    let attempt = 0;
    routes['/api/auth/login'] = async (body) => {
      attempt += 1;
      if (attempt === 1) {
        await heldA;
        return json(200, {
          candidate: { sid: 'sA', issuance_id: 'A-' + String(body.operation_id) },
          user: { id: 'A' }
        });
      }
      return json(401, { error: 'Invalid username or password' });
    };
    const lateA = session.signIn('A', 'pw');
    await vi.waitFor(() => expect(attempt).toBe(1));
    await expect(session.signIn('A', 'wrong')).rejects.toMatchObject({ status: 401 });
    releaseA();
    await expect(lateA).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls.some((call) => call.url === '/api/auth/browser/select')).toBe(false);
    expect(token.readAccessToken()).toBeNull();
  });

  it('completes MFA for the exact admitted intent and logs out the selected issuance only', async () => {
    const { session, token } = await loadV2();
    routes['/api/auth/login'] = () => json(200, { mfa_required: true, mfa_token: 'challenge' });
    routes['/api/auth/mfa/verify'] = (body) =>
      json(200, { candidate: { sid: 's', issuance_id: 'mfa-' + String(body.operation_id) }, user: { id: 'm' } });
    routes['/api/auth/logout'] = () => json(200, { success: true });
    const challenge = await session.signIn('m', 'pw').catch((error: unknown) => error);
    expect(challenge).toBeInstanceOf(session.MfaChallenge);
    const loginOperation = calls.find((call) => call.url === '/api/auth/login')!.body.operation_id;
    await session.completeMfa('challenge', { code: '123456' });
    const verify = calls.find((call) => call.url === '/api/auth/mfa/verify')!;
    expect(verify.body.operation_id).toBe(loginOperation);
    const issuance = token.readAccessToken();
    const login = calls.filter((call) => call.url === '/api/auth/browser/intent')[0]!.body;
    expect(login.operation_id).toBe(loginOperation);
    expect(issuance).toBe(login.successor_issuance_id);
    await session.signOut();
    const intents = calls.filter((call) => call.url === '/api/auth/browser/intent').map((call) => call.body);
    expect(intents.at(-1)).toMatchObject({
      kind: 'logout',
      expected_issuance_id: issuance,
      successor_issuance_id: null
    });
    const logout = calls.find((call) => call.url === '/api/auth/logout')!;
    expect(logout.headers['X-NeroNet-Browser-Issuance']).toBe(issuance);
    expect(token.readAccessToken()).toBeNull();
  });

  it('resumes after a reload by rotating the server selection, never by trusting a possibly expired cookie', async () => {
    routes['/api/auth/browser/context'] = () =>
      json(200, { context_id: 'ctx', latest_intent: '7', selected: { sid: 's', issuance_id: 'S1' } });
    routes['/api/auth/refresh'] = (body) =>
      json(200, { selected: { sid: 's', issuance_id: 'S2-' + String(body.operation_id) }, user: { id: 'u' } });
    const { token } = await loadV2();
    const { resumeSession } = await import('./apiClient');
    const resumed = await resumeSession();
    const intent = calls.find((call) => call.url === '/api/auth/browser/intent')!.body;
    expect(intent).toMatchObject({ kind: 'refresh', expected_issuance_id: 'S1', intent: '8' });
    expect(resumed).toBe('S2-' + String(intent.operation_id));
    expect(token.readAccessToken()).toBe(resumed);
  });

  async function signedIn() {
    const loaded = await loadV2();
    routes['/api/auth/login'] = () => json(200, { candidate: { sid: 'x', issuance_id: 'x' }, user: { id: 'u1' } });
    await loaded.session.signIn('u1', 'pw');
    const issuance = loaded.token.readAccessToken()!;
    const api = await import('./apiClient');
    return { ...loaded, api, issuance, sid: 'sid-' + issuance };
  }

  it('never adopts another principal after a marked selection change: it signs this document out', async () => {
    const { api, token } = await signedIn();
    routes['/api/auth/browser/context'] = () =>
      json(200, { context_id: 'ctx', latest_intent: '9', selected: { sid: 'other-family', issuance_id: 'B' } });
    // A retry under B would succeed: only the family check keeps this document from adopting B.
    let first = true;
    routes['/api/nodes'] = () => {
      if (first) {
        first = false;
        return json(409, { error: 'Browser selection changed', code: 'browser_selection_changed' });
      }
      return json(200, { nodes: ['visible to B'] });
    };
    await expect(api.apiRequest('/nodes')).rejects.toMatchObject({ name: 'AbortError' });
    expect(token.readAccessToken()).toBeNull();
    expect(calls.filter((call) => call.url === '/api/nodes')).toHaveLength(1);
  });

  it('follows a rotation of its own family made by another tab and retries once', async () => {
    const { api, token, sid } = await signedIn();
    routes['/api/auth/browser/context'] = () =>
      json(200, { context_id: 'ctx', latest_intent: '9', selected: { sid, issuance_id: 'S2' } });
    let first = true;
    routes['/api/nodes'] = () => {
      if (first) {
        first = false;
        return json(409, { error: 'Browser selection changed', code: 'browser_selection_changed' });
      }
      return json(200, { nodes: [] });
    };
    await expect(api.apiRequest('/nodes')).resolves.toEqual({ nodes: [] });
    expect(token.readAccessToken()).toBe('S2');
    expect(calls.filter((call) => call.url === '/api/nodes').at(-1)!.headers['X-NeroNet-Browser-Issuance']).toBe('S2');
  });

  it('reports an ordinary 409 conflict to the page instead of treating it as a session change', async () => {
    const { api, token, issuance } = await signedIn();
    routes['/api/users'] = () => json(409, { error: 'Username already exists' });
    await expect(api.apiRequest('/users', { method: 'POST', body: {} })).rejects.toMatchObject({
      status: 409,
      message: 'Username already exists'
    });
    expect(token.readAccessToken()).toBe(issuance);
  });

  it('keeps a local sign-out even when the server could not be told, across a reload', async () => {
    const { session, issuance, sid } = await signedIn();
    routes['/api/auth/logout'] = () => {
      throw new TypeError('network down');
    };
    await session.signOut();
    // Reload: the server still names the old selection.
    routes['/api/auth/browser/context'] = () =>
      json(200, { context_id: 'ctx', latest_intent: '9', selected: { sid, issuance_id: issuance } });
    const { browser } = await loadV2();
    const api = await import('./apiClient');
    const before = calls.length;
    expect(await api.resumeSession()).toBeNull();
    expect(calls.slice(before).some((call) => call.url === '/api/auth/browser/intent')).toBe(false);
    expect((await browser.ensureBrowserContext()).selected).toBeNull();
  });

  it('declares the issuance it refreshes and signs out when the refused selection is unchanged', async () => {
    const { api, token, issuance, sid } = await signedIn();
    routes['/api/auth/refresh'] = () => json(401, { error: 'Refresh token expired' });
    routes['/api/auth/browser/context'] = () =>
      json(200, { context_id: 'ctx', latest_intent: '9', selected: { sid, issuance_id: issuance } });
    routes['/api/nodes'] = () => json(401, { error: 'expired' });
    await expect(api.apiRequest('/nodes')).rejects.toBeTruthy();
    const refresh = calls.find((call) => call.url === '/api/auth/refresh')!;
    expect(refresh.headers['X-NeroNet-Browser-Issuance']).toBe(issuance);
    expect(token.readAccessToken()).toBeNull();
  });

  it('signs out the rotated issuance of its own family when another tab refreshed meanwhile', async () => {
    const { session, issuance, sid } = await signedIn();
    const loggedOut: string[] = [];
    routes['/api/auth/browser/intent'] = (body) =>
      body.kind === 'logout' && body.expected_issuance_id === issuance
        ? json(409, { error: 'Browser selection changed', code: 'browser_selection_changed' })
        : json(200, { state: 'registered' });
    routes['/api/auth/browser/context'] = () =>
      json(200, { context_id: 'ctx', latest_intent: '9', selected: { sid, issuance_id: 'S9' } });
    routes['/api/auth/logout'] = (_body, init) => {
      loggedOut.push((init.headers as Record<string, string>)['X-NeroNet-Browser-Issuance']!);
      return json(200, { success: true });
    };
    await session.signOut();
    expect(loggedOut).toEqual(['S9']);
  });

  it('expects the server selection hidden by an unsent sign-out when signing in again', async () => {
    const { session, issuance, sid } = await signedIn();
    routes['/api/auth/logout'] = () => {
      throw new TypeError('network down');
    };
    await session.signOut();
    routes['/api/auth/browser/context'] = () =>
      json(200, { context_id: 'ctx', latest_intent: '9', selected: { sid, issuance_id: issuance } });
    const reloaded = await loadV2();
    routes['/api/auth/login'] = () => json(200, { candidate: { sid: 'n', issuance_id: 'n' }, user: { id: 'u2' } });
    await reloaded.session.signIn('u2', 'pw');
    const login = calls.filter((call) => call.url === '/api/auth/browser/intent' && call.body.kind === 'login').at(-1)!;
    expect(login.body.expected_issuance_id).toBe(issuance);
  });

  it('stops acting at once when another tab adopts another principal, and follows its own family', async () => {
    const { token, sid } = await signedIn();
    const otherTab = new BroadcastChannel('neronet-browser-selection');
    try {
      otherTab.postMessage({ selected: { sid, issuance_id: 'S3' } });
      await vi.waitFor(() => expect(token.readAccessToken()).toBe('S3'));
      otherTab.postMessage({ selected: { sid: 'another-principal', issuance_id: 'B' } });
      await vi.waitFor(() => expect(token.readAccessToken()).toBeNull());
    } finally {
      otherTab.close();
    }
  });

  it('allocates strictly increasing intents and starts after the server latest intent', async () => {
    routes['/api/auth/browser/context'] = () => json(200, { context_id: 'ctx', latest_intent: '41', selected: null });
    const { browser } = await loadV2();
    const first = await browser.beginBrowserOperation('login', null);
    const second = await browser.beginBrowserOperation('login', null);
    expect(first.intent).toBe('42');
    expect(second.intent).toBe('43');
    expect(await browser.isLatestOperation(first)).toBe(false);
    expect(await browser.isLatestOperation(second)).toBe(true);
  });
});
