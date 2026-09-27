import { apiRequest } from './apiClient';
import { clearSession, storeActiveRole, storeSession } from './authToken';

/**
 * Sign-in, sign-out and "who am I".
 *
 * Separate from `apiClient` because these three are the only calls that touch
 * the session rather than merely carry it.
 */

export interface ConsoleUser {
  id: string;
  username: string;
  role?: string;
  [key: string]: unknown;
}

interface LoginResponse {
  token?: string;
  refreshToken?: string;
  user?: ConsoleUser;
  error?: string;
}

export async function signIn(username: string, password: string): Promise<ConsoleUser> {
  const body = await apiRequest<LoginResponse>('/auth/login', {
    method: 'POST',
    body: { username, password }
  });

  if (!body?.token || !body.user) {
    throw new Error(body?.error || 'The control plane did not return a session');
  }

  // The refresh token in the body is for API clients; the console relies on the
  // HttpOnly cookie set with the same response and keeps nothing else.
  storeSession({
    token: body.token,
    role: body.user.role ?? 'user'
  });

  return body.user;
}

export async function fetchCurrentUser(): Promise<ConsoleUser | null> {
  const body = await apiRequest<{ user?: ConsoleUser }>('/auth/me');
  return body?.user ?? null;
}

export async function signOut(): Promise<void> {
  try {
    await apiRequest('/auth/logout', { method: 'POST' });
  } catch {
    // The local session ends whether or not the server was told. A network
    // failure that left the token in place would keep an operator signed in
    // after they asked not to be.
  }
  clearSession();
}

export function rememberRole(role: string): void {
  storeActiveRole(role);
}
