/**
 * Where the console keeps the session, and the only place that knows how.
 *
 * Today that is an access token and a refresh token in localStorage, which is
 * readable by any script that reaches this origin. WP-105 replaces it with an
 * HttpOnly cookie session. Everything else in the console goes through this
 * module and `apiClient`, so that replacement is a change to two files rather
 * than a search through the tree for the string 'neronet_jwt_token'.
 */

const ACCESS_KEY = 'neronet_jwt_token';
const REFRESH_KEY = 'neronet_refresh_token';
const ROLE_KEY = 'neronet_active_role';

export interface Session {
  token: string;
  refreshToken?: string | null;
  role?: string | null;
}

type Listener = (token: string | null) => void;

const listeners = new Set<Listener>();

function read(key: string): string | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage.getItem(key);
  } catch {
    // Private browsing, or storage disabled. The session then lasts as long as
    // the tab, which is a degradation rather than a failure.
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    if (typeof localStorage === 'undefined') return;
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // As above.
  }
}

function notify(): void {
  const token = readAccessToken();
  for (const listener of listeners) {
    try {
      listener(token);
    } catch (err) {
      // A broken subscriber must not take down the sign-in that triggered it.
      console.error('session listener failed', err);
    }
  }
}

export function readAccessToken(): string | null {
  return read(ACCESS_KEY);
}

export function readRefreshToken(): string | null {
  return read(REFRESH_KEY);
}

export function readActiveRole(): string | null {
  return read(ROLE_KEY);
}

export function storeActiveRole(role: string | null): void {
  write(ROLE_KEY, role);
}

export function storeSession(session: Session): void {
  write(ACCESS_KEY, session.token);
  if (session.refreshToken !== undefined) write(REFRESH_KEY, session.refreshToken ?? null);
  if (session.role !== undefined) write(ROLE_KEY, session.role ?? null);
  notify();
}

/** Replace only the access token, after a refresh. */
export function storeAccessToken(token: string | null): void {
  write(ACCESS_KEY, token);
  notify();
}

/**
 * End the session locally.
 *
 * The refresh token goes with it. Left behind it stayed exchangeable for a
 * fresh access token after sign-out, which is a session that outlives the
 * moment the operator ended it.
 */
export function clearSession(): void {
  write(ACCESS_KEY, null);
  write(REFRESH_KEY, null);
  write(ROLE_KEY, null);
  notify();
}

/** Fires whenever the access token changes, including on sign-out. */
export function subscribeToSession(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The header the control plane authenticates with. */
export function authHeader(): Record<string, string> {
  const token = readAccessToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}
