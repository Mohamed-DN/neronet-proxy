/**
 * The one way the console talks to the control plane.
 *
 * It owns the base path, the bearer header, the single shared refresh on a 401,
 * cancellation, and the error type. Nothing else in the console calls `fetch`
 * against /api. The refresh token is an HttpOnly cookie the page never sees;
 * the access token is held in memory by `authToken.ts`.
 *
 * Every failure throws. The layer this replaced returned `null` for a failed
 * read, which downstream could not tell from "the server answered, and the
 * answer is nothing"; that ambiguity is what let the console draw an empty mesh
 * and a broken mesh identically.
 */

import {
  captureSession,
  clearSession,
  isCurrentAuthority,
  isCurrentCredential,
  storeAccessToken,
  type SessionSnapshot
} from './authToken';
import { reportServerAnswered, reportTransportFailure } from './connection';
import {
  BROWSER_PROTOCOL,
  adoptedSelection,
  beginBrowserOperation,
  followSelection,
  onForeignSelection,
  browserHeaders,
  ensureBrowserContext,
  rememberSelection,
  resyncBrowserContext,
  type Selection
} from './browserContext';

export const API_BASE = '/api';

// Another tab adopted or abandoned a selection. The same session family rotated:
// follow it. Another principal, or a sign-out: this document stops acting at once
// instead of showing one account while the browser is signed in as another.
if (BROWSER_PROTOCOL) {
  onForeignSelection((selected) => {
    const mine = adoptedSelection();
    if (!mine) return;
    if (selected && selected.sid === mine.sid) {
      followSelection(selected);
      storeAccessToken(selected.issuance_id);
    } else {
      clearSession();
    }
  });
}

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
  /** The parsed error body, for answers that carry more than a message (e.g. a refused ACL save). */
  readonly details: unknown;

  constructor(message: string, status: number, code: string | null = null, details: unknown = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
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
type RefreshOutcome =
  | { kind: 'refreshed'; token: string; scope: SessionSnapshot }
  | { kind: 'refused' | 'superseded'; scope: SessionSnapshot }
  | { kind: 'unavailable'; scope: SessionSnapshot; error: ApiError };

let refreshInFlight: { snapshot: SessionSnapshot; promise: Promise<RefreshOutcome> } | null = null;
// Only version metadata is retained, never an earlier token. A late 401 can
// reuse this exact verified rotation, not an arbitrary token installed later.
let verifiedRefresh: {
  authorityVersion: number;
  intentVersion: number;
  sourceRevision: number;
  targetRevision: number;
} | null = null;

function superseded(): DOMException {
  return new DOMException('The console session changed while this request was in flight', 'AbortError');
}

function requireAuthority(snapshot: SessionSnapshot): void {
  if (!isCurrentAuthority(snapshot)) throw superseded();
}

function requireCredential(snapshot: SessionSnapshot): void {
  if (!isCurrentCredential(snapshot)) throw superseded();
}

/**
 * Browser-v2 refresh. In this protocol the value held by authToken.ts is the
 * non-secret selector of the server-selected issuance, never a token. Rotation
 * is admitted by an intent that expects exactly that issuance; a refusal never
 * leads to a replay of the consumed credential.
 */
async function performBrowserRefresh(snapshot: SessionSnapshot): Promise<RefreshOutcome> {
  const obsolete = (): RefreshOutcome => ({ kind: 'superseded', scope: snapshot });
  const refuse = (): RefreshOutcome => {
    clearSession();
    return { kind: 'refused', scope: captureSession() };
  };
  const accept = async (selected: Selection): Promise<RefreshOutcome> => {
    if (!isCurrentCredential(snapshot)) return obsolete();
    await rememberSelection(selected);
    storeAccessToken(selected.issuance_id);
    return { kind: 'refreshed', token: selected.issuance_id, scope: captureSession() };
  };
  // After a refusal, follow the server only to a successor of this document's own
  // family (another tab rotated it). An unchanged selection is the one that was
  // just refused, and another family is another principal: neither is adopted.
  const recover = async (expected: string): Promise<RefreshOutcome> => {
    const selected = await resyncBrowserContext();
    if (!isCurrentCredential(snapshot)) return obsolete();
    const family = adoptedSelection();
    if (!selected || selected.issuance_id === expected || (family && selected.sid !== family.sid)) return refuse();
    return accept(selected);
  };
  try {
    // After a reload nothing is held yet. The context names the server selection,
    // but its access cookie may have expired: resuming rotates it, exactly as the
    // legacy client resumed through a refresh, instead of trusting the old cookie.
    let expected = snapshot.token;
    if (!expected) {
      const selected = await resyncBrowserContext();
      if (!isCurrentCredential(snapshot)) return obsolete();
      if (!selected) return refuse();
      expected = selected.issuance_id;
    }
    let operation;
    try {
      operation = await beginBrowserOperation('refresh', expected);
    } catch (error) {
      if ((error as { status?: number }).status === 409) return await recover(expected);
      throw error;
    }
    const res = await fetch(`${API_BASE}/auth/refresh`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', ...browserHeaders(expected) },
      body: JSON.stringify({ operation_id: operation.operation_id })
    });
    if (!isCurrentCredential(snapshot)) return obsolete();
    if (!res.ok) {
      reportServerAnswered(res.status);
      if (res.status === 401 || res.status === 403 || res.status === 409) return await recover(expected);
      return {
        kind: 'unavailable',
        scope: snapshot,
        error: new ApiError(`Session refresh answered HTTP ${res.status}`, res.status)
      };
    }
    const body = (await res.json().catch(() => null)) as { selected?: Selection } | null;
    if (!body?.selected) return await recover(expected);
    return await accept(body.selected);
  } catch (error) {
    if (!isCurrentCredential(snapshot) || (error instanceof DOMException && error.name === 'AbortError'))
      return obsolete();
    const message = error instanceof Error ? error.message : 'Session refresh could not reach the control plane';
    reportTransportFailure(message);
    return { kind: 'unavailable', scope: snapshot, error: new ApiError(message, 0) };
  }
}

async function performRefresh(snapshot: SessionSnapshot): Promise<RefreshOutcome> {
  if (BROWSER_PROTOCOL) return performBrowserRefresh(snapshot);
  const obsolete = (): RefreshOutcome => ({ kind: 'superseded', scope: snapshot });
  try {
    // The refresh token travels as the HttpOnly cookie the control plane set at
    // sign-in (path /api/auth/refresh); the body carries nothing.
    const res = await fetch(`${API_BASE}/auth/refresh`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    });
    if (!isCurrentCredential(snapshot)) return obsolete();

    if (!res.ok) {
      reportServerAnswered(res.status);
      if (res.status === 401 || res.status === 403) {
        clearSession();
        return { kind: 'refused', scope: captureSession() };
      }
      return {
        kind: 'unavailable',
        scope: snapshot,
        error: new ApiError(`Session refresh answered HTTP ${res.status}`, res.status)
      };
    }

    const body = (await res.json().catch(() => null)) as { token?: string } | null;
    if (!isCurrentCredential(snapshot)) return obsolete();
    if (!body?.token)
      return {
        kind: 'unavailable',
        scope: snapshot,
        error: new ApiError('The refresh response did not include an access token', res.status)
      };

    storeAccessToken(body.token);
    const scope = captureSession();
    verifiedRefresh = {
      authorityVersion: snapshot.authorityVersion,
      intentVersion: snapshot.intentVersion,
      sourceRevision: snapshot.credentialRevision,
      targetRevision: scope.credentialRevision
    };
    return { kind: 'refreshed', token: body.token, scope };
  } catch (error) {
    // A network failure is not proof the session ended, so nothing is cleared
    // and the next request tries again.
    if (!isCurrentCredential(snapshot) || (error instanceof DOMException && error.name === 'AbortError'))
      return obsolete();
    const message = error instanceof Error ? error.message : 'Session refresh could not reach the control plane';
    reportTransportFailure(message);
    return { kind: 'unavailable', scope: snapshot, error: new ApiError(message, 0) };
  }
}

async function refreshAccessToken(snapshot = captureSession()): Promise<RefreshOutcome> {
  // Released as soon as the attempt settles. Callers already awaiting hold the
  // promise itself, so nothing they see changes; a caller arriving afterwards
  // gets a new attempt, which is correct, because the previous one is over. The
  // variable used to be cleared on a timer instead, which left a window in
  // which a later 401 was answered with the outcome of an earlier refresh.
  requireAuthority(snapshot);
  const current = captureSession();
  if (current.credentialRevision !== snapshot.credentialRevision) {
    if (
      current.token &&
      verifiedRefresh?.authorityVersion === snapshot.authorityVersion &&
      verifiedRefresh.intentVersion === snapshot.intentVersion &&
      verifiedRefresh.sourceRevision === snapshot.credentialRevision &&
      verifiedRefresh.targetRevision === current.credentialRevision
    ) {
      return { kind: 'refreshed', token: current.token, scope: current };
    }
    return { kind: 'superseded', scope: snapshot };
  }
  if (
    refreshInFlight &&
    refreshInFlight.snapshot.authorityVersion === snapshot.authorityVersion &&
    refreshInFlight.snapshot.intentVersion === snapshot.intentVersion &&
    refreshInFlight.snapshot.credentialRevision === snapshot.credentialRevision
  )
    return refreshInFlight.promise;
  const flight = { snapshot, promise: performRefresh(snapshot) };
  refreshInFlight = flight;
  void flight.promise.finally(() => {
    if (refreshInFlight === flight) refreshInFlight = null;
  });
  return flight.promise;
}

/**
 * Get an access token after a reload, from the refresh cookie. Null when there
 * is no session to resume.
 */
export async function resumeSession(): Promise<string | null> {
  const result = await refreshAccessToken();
  return result.kind === 'refreshed' && isCurrentCredential(result.scope) ? result.token : null;
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
  if (BROWSER_PROTOCOL) await ensureBrowserContext();
  const snapshot = captureSession();

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    // v2 never sends a bearer token: it names the selected issuance instead.
    ...(BROWSER_PROTOCOL
      ? browserHeaders(snapshot.token)
      : snapshot.token
        ? { Authorization: `Bearer ${snapshot.token}` }
        : {}),
    ...extraHeaders
  };

  const init: RequestInit = { method, headers, credentials: 'same-origin' };
  if (signal) init.signal = signal;
  if (body !== undefined) init.body = typeof body === 'string' ? body : JSON.stringify(body);

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, init);
  } catch (err) {
    requireAuthority(snapshot);
    // An aborted request is the caller's own doing, not a broken control plane:
    // reporting it as unreachable would turn every page change into an outage.
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    const message = err instanceof Error ? err.message : 'the control plane could not be reached';
    reportTransportFailure(message);
    throw new ApiError(message, 0);
  }

  requireAuthority(snapshot);

  if (!res.ok) {
    // The server says this document's selection is no longer current (another tab
    // refreshed, switched account or signed out). Only that marked 409 is a session
    // change; an ordinary conflict of a resource is reported to the page below.
    if (BROWSER_PROTOCOL && res.status === 409 && snapshot.token && !isAuthEndpoint(path)) {
      const marked = (await res
        .clone()
        .json()
        .catch(() => null)) as { code?: string } | null;
      if (marked?.code === 'browser_selection_changed') {
        const selected = await resyncBrowserContext();
        requireCredential(snapshot);
        const family = adoptedSelection();
        if (selected && family && selected.sid === family.sid && !isRetry) {
          // Same session family rotated elsewhere: follow it and try once more.
          await rememberSelection(selected);
          storeAccessToken(selected.issuance_id);
          return apiRequest<T>(path, options, true);
        }
        // Another principal, or none: never act on it from this document's state.
        clearSession();
        throw superseded();
      }
    }
    let responseScope = snapshot;
    // Never on an /auth/ call: refreshing in response to a failed sign-in or a
    // failed refresh would loop.
    if (res.status === 401 && !isRetry && !isAuthEndpoint(path)) {
      const fresh = await refreshAccessToken(snapshot);
      if (fresh.kind === 'superseded') throw superseded();
      requireCredential(fresh.scope);
      if (fresh.kind === 'unavailable') throw fresh.error;
      if (fresh.kind === 'refreshed') return apiRequest<T>(path, options, true);
      responseScope = fresh.scope;
    }

    reportServerAnswered(res.status);

    const payload = (await res.json().catch(() => null)) as { error?: string; code?: string } | null;
    // A refused refresh may intentionally end the original authority. Capture
    // that exact transition too: a newer admission must not receive its error.
    requireCredential(responseScope);
    throw new ApiError(payload?.error || `HTTP error ${res.status}`, res.status, payload?.code ?? null, payload);
  }

  reportServerAnswered(res.status);
  const result = await readBody(res);
  requireAuthority(snapshot);
  return result as T;
}

export const apiGet = <T>(path: string, options?: RequestOptions) => apiRequest<T>(path, { ...options, method: 'GET' });

export const apiPost = <T>(path: string, body?: unknown, options?: RequestOptions) =>
  apiRequest<T>(path, { ...options, method: 'POST', body });

export const apiPut = <T>(path: string, body?: unknown, options?: RequestOptions) =>
  apiRequest<T>(path, { ...options, method: 'PUT', body });

export const apiDelete = <T>(path: string, options?: RequestOptions) =>
  apiRequest<T>(path, { ...options, method: 'DELETE' });
