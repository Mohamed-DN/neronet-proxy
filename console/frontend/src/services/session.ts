import { apiRequest } from './apiClient';
import { clearSession, storeActiveRole, storeSession } from './authToken';

/**
 * Sign-in, sign-out and "who am I".
 *
 * Separate from `apiClient` because these three are the only calls that touch
 * the session rather than merely carry it, and separate from the pages because
 * WP-105 replaces all three with a cookie exchange.
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

  storeSession({
    token: body.token,
    // Issued by the server since sign-in was built and dropped on the floor by
    // the layer this replaced, which is why sessions ended after fifteen
    // minutes whatever the operator was doing.
    refreshToken: body.refreshToken ?? null,
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
