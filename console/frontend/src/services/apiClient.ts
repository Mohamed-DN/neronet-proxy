/**
 * The one way the console talks to the control plane.
 *
 * It owns the base path, the bearer header, the single shared refresh on a 401,
 * cancellation, and the error type. Nothing else in the console calls `fetch`
 * against /api, so a change to how the session is carried - WP-105 moves it to
 * a cookie - is a change here and in `authToken.ts`.
 *
 * Every failure throws. The layer this replaced returned `null` for a failed
 * read, which downstream could not tell from "the server answered, and the
 * answer is nothing"; that ambiguity is what let the console draw an empty mesh
 * and a broken mesh identically.
 */

import { authHeader, clearSession, readRefreshToken, storeAccessToken } from './authToken';
import { reportServerAnswered, reportTransportFailure } from './connection';

export const API_BASE = '/api';

/**
 * A failure the caller can act on.
 *
 * `status` is 0 when the request never reached a server. `message` is safe to
 * put on screen: it is the server's own error text or an HTTP status, never a
 * stack and never anything carrying the token.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(message: string, status: number, code: string | null = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }

  /** True when retrying the same request cannot help. */
  get isClientError(): boolean {
    return this.status >= 400 && this.status < 500;
  }

  get isUnreachable(): boolean {
    return this.status === 0;
  }
}

export interface RequestOptions {
  method?: string;
  /** Serialised as JSON unless it is already a string or FormData. */
  body?: unknown;
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

/*
 * Access tokens last fifteen minutes. One refresh is attempted per expiry and
 * shared between concurrent callers: the overview alone fires five requests at
 * once, and each retrying on its own would spend five refresh tokens on one
 * expiry.
 */
let refreshInFlight: Promise<string | null> | null = null;

async function performRefresh(refreshToken: string): Promise<string | null> {
  try {
    const res = await fetch(`${API_BASE}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken })
    });

    if (!res.ok) {
      // The refresh token is spent, revoked or expired. Clearing the session is
      // what sends the operator back to the sign-in screen.
      clearSession();
      return null;
    }

    const body = (await res.json().catch(() => null)) as { token?: string } | null;
    if (!body?.token) return null;

    storeAccessToken(body.token);
    return body.token;
  } catch {
    // A network failure is not proof the session ended, so the tokens are kept
    // and the next request tries again.
    return null;
  }
}

async function refreshAccessToken(): Promise<string | null> {
  const refreshToken = readRefreshToken();
  if (!refreshToken) return null;

  // Released as soon as the attempt settles. Callers already awaiting hold the
  // promise itself, so nothing they see changes; a caller arriving afterwards
  // gets a new attempt, which is correct, because the previous one is over. The
  // variable used to be cleared on a timer instead, which left a window in
  // which a later 401 was answered with the outcome of an earlier refresh.
  refreshInFlight ??= performRefresh(refreshToken).finally(() => {
    refreshInFlight = null;
  });

  return refreshInFlight;
}

function isAuthEndpoint(path: string): boolean {
  return path.startsWith('/auth/');
}

async function readBody(res: Response): Promise<unknown> {
  if (res.status === 204 || res.headers.get('content-length') === '0') return undefined;
  const text = await res.text();
  if (text === '') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    // A non-JSON body from an endpoint that promises JSON is a server fault,
    // not something to hand to a page as data.
    throw new ApiError(`The control plane answered ${res.status} with a body that is not JSON`, res.status);
  }
}

export async function apiRequest<T>(path: string, options: RequestOptions = {}, isRetry = false): Promise<T> {
  const { method = 'GET', body, signal, headers: extraHeaders } = options;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...authHeader(),
    ...extraHeaders
  };

  const init: RequestInit = { method, headers };
  if (signal) init.signal = signal;
  if (body !== undefined) init.body = typeof body === 'string' ? body : JSON.stringify(body);

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, init);
  } catch (err) {
    // An aborted request is the caller's own doing, not a broken control plane:
    // reporting it as unreachable would turn every page change into an outage.
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    const message = err instanceof Error ? err.message : 'the control plane could not be reached';
    reportTransportFailure(message);
    throw new ApiError(message, 0);
  }

  if (!res.ok) {
    // Never on an /auth/ call: refreshing in response to a failed sign-in or a
    // failed refresh would loop.
    if (res.status === 401 && !isRetry && !isAuthEndpoint(path)) {
      const fresh = await refreshAccessToken();
      if (fresh) return apiRequest<T>(path, options, true);
      clearSession();
    }

    reportServerAnswered(res.status);

    const payload = (await res.json().catch(() => null)) as { error?: string; code?: string } | null;
    throw new ApiError(payload?.error || `HTTP error ${res.status}`, res.status, payload?.code ?? null);
  }

  reportServerAnswered(res.status);
  return (await readBody(res)) as T;
}
