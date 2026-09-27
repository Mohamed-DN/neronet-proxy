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
  mfa_required?: boolean;
  mfa_setup_required?: boolean;
  mfa_token?: string;
}

/**
 * The password was right, and the account needs a TOTP code before a session is
 * issued. `setupRequired` means it has no authenticator yet and must enrol one now.
 * The token proves the password step only and is spent by the sign-in it completes.
 */
export class MfaChallenge extends Error {
  readonly mfaToken: string;
  readonly setupRequired: boolean;

  constructor(mfaToken: string, setupRequired: boolean) {
    super('A code from your authenticator is required');
    this.name = 'MfaChallenge';
    this.mfaToken = mfaToken;
    this.setupRequired = setupRequired;
  }
}

export interface MfaEnrolment {
  secret: string;
  qrDataUrl: string;
  otpauthUri: string;
  recoveryCodes: string[];
}

function adoptSession(body: LoginResponse | undefined): ConsoleUser {
  if (!body?.token || !body.user) {
    throw new Error(body?.error || 'The control plane did not return a session');
  }
  // The refresh token in the body is for API clients; the console relies on the
  // HttpOnly cookie set with the same response and keeps nothing else.
  storeSession({ token: body.token, role: body.user.role ?? 'user' });
  return body.user;
}

/** Throws MfaChallenge when the account needs a TOTP code to finish signing in. */
export async function signIn(username: string, password: string): Promise<ConsoleUser> {
  const body = await apiRequest<LoginResponse>('/auth/login', {
    method: 'POST',
    body: { username, password }
  });

  if (body?.mfa_required && body.mfa_token) {
    throw new MfaChallenge(body.mfa_token, Boolean(body.mfa_setup_required));
  }
  return adoptSession(body);
}

/** Start enrolling an authenticator, during a sign-in that requires one. */
export async function startMfaEnrolment(mfaToken: string): Promise<MfaEnrolment> {
  return apiRequest<MfaEnrolment>('/auth/mfa/setup', { method: 'POST', body: { mfa_token: mfaToken } });
}

/** Finish a sign-in with a TOTP code, or a recovery code for an enrolled account. */
export async function completeMfa(
  mfaToken: string,
  proof: { code: string } | { recovery_code: string }
): Promise<ConsoleUser> {
  const body = await apiRequest<LoginResponse>('/auth/mfa/verify', {
    method: 'POST',
    body: { mfa_token: mfaToken, ...proof }
  });
  return adoptSession(body);
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
