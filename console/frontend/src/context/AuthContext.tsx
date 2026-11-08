import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';

import { resumeSession } from '../services/apiClient';
import {
  captureSession,
  clearSession,
  isCurrentCredential,
  readAccessToken,
  readActiveRole,
  subscribeToSession
} from '../services/authToken';
import { completeMfa, fetchCurrentUser, rememberRole, signIn, signOut, type ConsoleUser } from '../services/session';
import { createQueryClient } from '../services/queries/client';

/**
 * The session, as the console sees it.
 *
 * Nothing outside this file and `authToken.ts` reads or writes a token. Pages
 * ask `useAuth()` whether there is a user and what role is in scope; WP-105
 * changes how the session is carried without touching any of them.
 */

export interface AuthValue {
  user: ConsoleUser | null;
  role: string | null;
  /** Present so existing pages that read it keep working. Prefer isAuthenticated. */
  token: string | null;
  loading: boolean;
  isAuthenticated: boolean;
  switchRole: (role: string) => void;
  /** Throws MfaChallenge when the account needs a TOTP code; finish with completeMfaSignIn. */
  login: (username: string, password: string) => Promise<ConsoleUser>;
  completeMfaSignIn: (mfaToken: string, proof: { code: string } | { recovery_code: string }) => Promise<ConsoleUser>;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

function SessionQueries({ children }: { children: React.ReactNode }) {
  const [client] = useState(createQueryClient);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // StrictMode immediately mounts effects again on the same instance. A real
      // session replacement leaves this old instance unmounted; only its client
      // is cancelled and cleared, never the new session's cache.
      queueMicrotask(() => {
        if (!mounted.current) {
          void client.cancelQueries();
          client.clear();
        }
      });
    };
  }, [client]);
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [token, setToken] = useState<string | null>(() => readAccessToken());
  const [user, setUser] = useState<ConsoleUser | null>(null);
  const [role, setRole] = useState<string | null>(() => readActiveRole());
  const [loading, setLoading] = useState(true);
  const [sessionGeneration, setSessionGeneration] = useState(0);
  const admissionTicket = useRef(0);
  const readTicket = useRef(0);

  const forget = useCallback((clearCredential = true) => {
    if (clearCredential) clearSession();
    setToken(null);
    setUser(null);
    setRole(null);
    setSessionGeneration((generation) => generation + 1);
  }, []);

  useEffect(
    () =>
      subscribeToSession((current) => {
        if (current !== null) return;
        admissionTicket.current++;
        readTicket.current++;
        forget(false);
        setLoading(false);
      }),
    [forget]
  );

  const verifySession = useCallback(async () => {
    // The access token is held in memory only, so after a reload there is none:
    // the refresh cookie, if the browser still has one, gets a new one.
    const ticket = ++readTicket.current;
    const intent = admissionTicket.current;
    const currentRead = () => ticket === readTicket.current && intent === admissionTicket.current;
    let scope = captureSession();
    try {
      setLoading(true);
      const saved = scope.token ?? (await resumeSession());
      if (!currentRead()) return;
      if (!saved) {
        if (!readAccessToken()) forget();
        return;
      }
      scope = captureSession();
      if (scope.token !== saved) return;
      const verified = await fetchCurrentUser();
      if (!currentRead() || !isCurrentCredential(scope)) return;
      if (verified?.id) {
        setUser(verified);
        setRole(verified.role ?? 'user');
        setToken(readAccessToken());
        rememberRole(verified.role ?? 'user');
        setSessionGeneration((generation) => generation + 1);
      } else {
        forget();
      }
    } catch {
      // A stored token the server will not accept is not a session. The
      // request layer has already cleared it if the refresh failed too.
      if (currentRead() && isCurrentCredential(scope)) forget();
    } finally {
      if (currentRead()) setLoading(false);
    }
  }, [forget]);

  useEffect(() => {
    void verifySession();
    return () => {
      admissionTicket.current++;
      readTicket.current++;
    };
  }, [verifySession]);

  const value = useMemo<AuthValue>(
    () => ({
      user,
      role,
      token,
      loading,
      isAuthenticated: Boolean(token && user),
      switchRole(next: string) {
        if (next === role) return;
        setRole(next);
        rememberRole(next);
        setSessionGeneration((generation) => generation + 1);
      },
      async login(username: string, password: string) {
        const ticket = ++admissionTicket.current;
        try {
          const signedIn = await signIn(username, password);
          if (ticket !== admissionTicket.current) throw new DOMException('The sign-in was superseded', 'AbortError');
          setUser(signedIn);
          setRole(signedIn.role ?? 'user');
          setToken(readAccessToken());
          setSessionGeneration((generation) => generation + 1);
          return signedIn;
        } finally {
          if (ticket === admissionTicket.current) setLoading(false);
        }
      },
      async completeMfaSignIn(mfaToken: string, proof: { code: string } | { recovery_code: string }) {
        const ticket = ++admissionTicket.current;
        try {
          const signedIn = await completeMfa(mfaToken, proof);
          if (ticket !== admissionTicket.current)
            throw new DOMException('The MFA sign-in was superseded', 'AbortError');
          setUser(signedIn);
          setRole(signedIn.role ?? 'user');
          setToken(readAccessToken());
          setSessionGeneration((generation) => generation + 1);
          return signedIn;
        } finally {
          if (ticket === admissionTicket.current) setLoading(false);
        }
      },
      async logout() {
        admissionTicket.current++;
        const ending = signOut();
        forget(false);
        setLoading(false);
        await ending;
      },
      async refreshUser() {
        const ticket = ++readTicket.current;
        const intent = admissionTicket.current;
        const currentRead = () => ticket === readTicket.current && intent === admissionTicket.current;
        const scope = captureSession();
        try {
          const verified = await fetchCurrentUser();
          if (!currentRead() || !isCurrentCredential(scope)) return;
          if (verified?.id) {
            setUser(verified);
            setRole(verified.role ?? 'user');
            // A public account DTO need not expose every membership/permission
            // change. Revalidation always retires data from the previous scope.
            setSessionGeneration((generation) => generation + 1);
          } else {
            forget();
          }
        } catch (error) {
          if (!currentRead() || !isCurrentCredential(scope)) return;
          forget();
          throw error;
        } finally {
          if (currentRead()) setLoading(false);
        }
      }
    }),
    [user, role, token, loading, forget]
  );

  return (
    <AuthContext.Provider value={value}>
      <SessionQueries key={sessionGeneration}>{children}</SessionQueries>
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return ctx;
}

export default AuthContext;
