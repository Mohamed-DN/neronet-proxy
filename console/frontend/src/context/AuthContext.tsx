import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

import { clearSession, readAccessToken, readActiveRole } from '../services/authToken';
import { fetchCurrentUser, rememberRole, signIn, signOut, type ConsoleUser } from '../services/session';

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
  login: (username: string, password: string) => Promise<ConsoleUser>;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [token, setToken] = useState<string | null>(() => readAccessToken());
  const [user, setUser] = useState<ConsoleUser | null>(null);
  const [role, setRole] = useState<string | null>(() => readActiveRole());
  const [loading, setLoading] = useState(true);

  const forget = useCallback(() => {
    clearSession();
    setToken(null);
    setUser(null);
    setRole(null);
  }, []);

  const verifySession = useCallback(async () => {
    const saved = readAccessToken();
    if (!saved) {
      forget();
      setLoading(false);
      return;
    }

    try {
      setLoading(true);
      const verified = await fetchCurrentUser();
      if (verified?.id) {
        setUser(verified);
        setRole(verified.role ?? 'user');
        setToken(saved);
        rememberRole(verified.role ?? 'user');
      } else {
        forget();
      }
    } catch {
      // A stored token the server will not accept is not a session. The
      // request layer has already cleared it if the refresh failed too.
      forget();
    } finally {
      setLoading(false);
    }
  }, [forget]);

  useEffect(() => {
    void verifySession();
  }, [verifySession]);

  const value = useMemo<AuthValue>(
    () => ({
      user,
      role,
      token,
      loading,
      isAuthenticated: Boolean(token && user),
      switchRole(next: string) {
        setRole(next);
        rememberRole(next);
      },
      async login(username: string, password: string) {
        const signedIn = await signIn(username, password);
        setUser(signedIn);
        setRole(signedIn.role ?? 'user');
        setToken(readAccessToken());
        return signedIn;
      },
      async logout() {
        await signOut();
        setToken(null);
        setUser(null);
        setRole(null);
      },
      async refreshUser() {
        const verified = await fetchCurrentUser();
        if (verified?.id) {
          setUser(verified);
          setRole(verified.role ?? 'user');
        }
      }
    }),
    [user, role, token, loading]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return ctx;
}

export default AuthContext;
