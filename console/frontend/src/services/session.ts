import { apiRequest } from './apiClient';
import {
  beginSessionIntent,
  captureSession,
  clearSession,
  isCurrentAuthority,
  readAccessToken,
  storeActiveRole,
  storeSession
} from './authToken';
import {
  BROWSER_PROTOCOL,
  adoptedSelection,
  beginBrowserOperation,
  browserHeaders,
  ensureBrowserContext,
  expectedForIntent,
  forgetSelection,
  resyncBrowserContext,
  isLatestOperation,
  selectCandidate,
  type BrowserOperation,
  type Selection
} from './browserContext';

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
  /** Browser-v2: a candidate issuance, adopted only by an explicit selection. */
  candidate?: Selection;
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

// Browser-v2: the admitted sign-in operation travels with its in-memory MFA
// challenge so that the second factor completes that exact intent.
const pendingMfaOperations = new Map<string, BrowserOperation>();

/**
 * Admit an intent expecting the server's current selection. Another tab may change
 * it at any moment (a new tab resumes by rotating): on that marked refusal the
 * context was resynchronised, so one more attempt names the fresh predecessor.
 */
async function beginWithCurrentExpectation(kind: BrowserOperation['kind']): Promise<BrowserOperation> {
  try {
    return await beginBrowserOperation(kind, await expectedForIntent());
  } catch (error) {
    if ((error as { status?: number }).status !== 409) throw error;
    return beginBrowserOperation(kind, await expectedForIntent());
  }
}

/**
 * Adopt a v2 candidate only if no later intent exists in this browser, then let
 * the server compare-and-set it. A late response (its cookies already stored by
 * the browser) is simply never selected, so it grants nothing.
 */
async function adoptCandidate(
  operation: BrowserOperation,
  body: LoginResponse | undefined,
  snapshot: ReturnType<typeof captureSession>
): Promise<ConsoleUser> {
  if (!body?.candidate || !body.user) throw new Error(body?.error || 'The control plane did not return a session');
  if (!isCurrentAuthority(snapshot) || !(await isLatestOperation(operation)))
    throw new DOMException('A newer sign-in replaced this one', 'AbortError');
  const selected = await selectCandidate(operation);
  storeSession({ token: selected.issuance_id, role: body.user.role ?? 'user' });
  return body.user;
}

async function signInBrowser(username: string, password: string): Promise<ConsoleUser> {
  beginSessionIntent();
  const snapshot = captureSession();
  const operation = await beginWithCurrentExpectation('login');
  const body = await apiRequest<LoginResponse>('/auth/login', {
    method: 'POST',
    body: { username, password, operation_id: operation.operation_id }
  });
  if (body?.mfa_required && body.mfa_token) {
    pendingMfaOperations.set(body.mfa_token, operation);
    throw new MfaChallenge(body.mfa_token, Boolean(body.mfa_setup_required));
  }
  return adoptCandidate(operation, body, snapshot);
}

/** Throws MfaChallenge when the account needs a TOTP code to finish signing in. */
export async function signIn(username: string, password: string): Promise<ConsoleUser> {
  if (BROWSER_PROTOCOL) return signInBrowser(username, password);
  beginSessionIntent();
  const snapshot = captureSession();
  const body = await apiRequest<LoginResponse>('/auth/login', {
    method: 'POST',
    body: { username, password }
  });
  if (!isCurrentAuthority(snapshot)) throw new DOMException('The console session changed during sign-in', 'AbortError');

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
  if (BROWSER_PROTOCOL) {
    const operation = pendingMfaOperations.get(mfaToken);
    if (!operation) throw new DOMException('This sign-in is no longer current', 'AbortError');
    const snapshot = captureSession();
    const body = await apiRequest<LoginResponse>('/auth/mfa/verify', {
      method: 'POST',
      body: { mfa_token: mfaToken, ...proof, operation_id: operation.operation_id }
    });
    pendingMfaOperations.delete(mfaToken);
    return adoptCandidate(operation, body, snapshot);
  }
  beginSessionIntent();
  const snapshot = captureSession();
  const body = await apiRequest<LoginResponse>('/auth/mfa/verify', {
    method: 'POST',
    body: { mfa_token: mfaToken, ...proof }
  });
  if (!isCurrentAuthority(snapshot)) throw new DOMException('The console session changed during MFA', 'AbortError');
  return adoptSession(body);
}

export async function fetchCurrentUser(): Promise<ConsoleUser | null> {
  const body = await apiRequest<{ user?: ConsoleUser }>('/auth/me');
  return body?.user ?? null;
}

export async function signOut(): Promise<void> {
  if (BROWSER_PROTOCOL) {
    // After a reload nothing is held in memory yet; the adopted selection still names it.
    const family = adoptedSelection();
    const issuance = readAccessToken() ?? family?.issuance_id ?? null;
    beginSessionIntent();
    clearSession();
    pendingMfaOperations.clear();
    // Locally first: a tombstone keeps a reload from resuming this session even if
    // the server cannot be told below.
    await forgetSelection(issuance).catch(() => undefined);
    try {
      let target = issuance;
      for (let attempt = 0; target && attempt < 2; attempt++) {
        try {
          const operation = await beginBrowserOperation('logout', target);
          const response = await fetch('/api/auth/logout', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json', ...browserHeaders(target) },
            body: JSON.stringify({ operation_id: operation.operation_id })
          });
          if (response.status !== 409) break;
        } catch (error) {
          if ((error as { status?: number }).status !== 409) throw error;
        }
        // Another tab rotated this same family meanwhile: sign out its current issuance.
        await resyncBrowserContext();
        const record = await ensureBrowserContext();
        const now = record.selected ?? record.hidden ?? null;
        target = now && family && now.sid === family.sid && now.issuance_id !== target ? now.issuance_id : null;
        if (target) await forgetSelection(target);
      }
    } catch {
      // As below: the local session ends whether or not the server was told.
    }
    return;
  }
  const bearer = readAccessToken();
  beginSessionIntent();
  clearSession();
  try {
    await apiRequest('/auth/logout', { method: 'POST', headers: bearer ? { Authorization: `Bearer ${bearer}` } : {} });
  } catch {
    // The local session ends whether or not the server was told. A network
    // failure that left the token in place would keep an operator signed in
    // after they asked not to be.
  }
}

export function rememberRole(role: string): void {
  storeActiveRole(role);
}
