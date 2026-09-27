/**
 * Where the console keeps the session, and the only place that knows how.
 *
 * The access token lives in this module's memory and nowhere else. The refresh
 * token is never visible to the page: the control plane sets it as an HttpOnly,
 * SameSite=Strict cookie scoped to /api/auth/refresh, and a reload gets a new
 * access token by calling that endpoint (see `resumeSession` in apiClient).
 *
 * Both tokens used to sit in localStorage, where any script that ran on this
 * origin could read them, and a stolen refresh token stayed valid for a week.
 */

// Keys the console wrote before the session moved out of storage. Removed on load,
// so an upgrade does not leave a readable token behind.
const LEGACY_KEYS = ['neronet_jwt_token', 'neronet_refresh_token', 'neronet_active_role'];

export interface Session {
  token: string;
  role?: string | null;
}

type Listener = (token: string | null) => void;

const listeners = new Set<Listener>();

let accessToken: string | null = null;
let activeRole: string | null = null;

function purgeLegacyStorage(): void {
  try {
    if (typeof localStorage === 'undefined') return;
    for (const key of LEGACY_KEYS) localStorage.removeItem(key);
  } catch {
    // Storage disabled: there is nothing to remove either.
  }
}

purgeLegacyStorage();

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
  return accessToken;
}

export function readActiveRole(): string | null {
  return activeRole;
}

export function storeActiveRole(role: string | null): void {
  activeRole = role;
}

export function storeSession(session: Session): void {
  accessToken = session.token;
  if (session.role !== undefined) activeRole = session.role ?? null;
  notify();
}

/** Replace only the access token, after a refresh. */
export function storeAccessToken(token: string | null): void {
  accessToken = token;
  notify();
}

/**
 * End the session locally. The refresh cookie is cleared by the server on
 * sign-out and whenever a refresh is refused.
 */
export function clearSession(): void {
  accessToken = null;
  activeRole = null;
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
