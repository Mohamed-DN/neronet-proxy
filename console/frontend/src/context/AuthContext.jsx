import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { api } from '../services/api';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [token, setToken] = useState(() => {
    return localStorage.getItem('neronet_jwt_token') || null;
  });
  const [user, setUser] = useState(null);
  const [role, setRole] = useState(() => {
    return localStorage.getItem('neronet_active_role') || null;
  });
  const [loading, setLoading] = useState(true);

  const clearAuth = useCallback(() => {
    localStorage.removeItem('neronet_jwt_token');
    localStorage.removeItem('neronet_active_role');
    setToken(null);
    setUser(null);
    setRole(null);
  }, []);

  const verifySession = useCallback(async () => {
    const savedToken = localStorage.getItem('neronet_jwt_token');
    if (!savedToken) {
      setToken(null);
      setUser(null);
      setRole(null);
      setLoading(false);
      return;
    }

    try {
      setLoading(true);
      const verifiedUser = await api.auth.me();
      if (verifiedUser && verifiedUser.id) {
        setUser(verifiedUser);
        setRole(verifiedUser.role || 'user');
        setToken(savedToken);
        localStorage.setItem('neronet_active_role', verifiedUser.role || 'user');
      } else {
        clearAuth();
      }
    } catch (err) {
      clearAuth();
    } finally {
      setLoading(false);
    }
  }, [clearAuth]);

  useEffect(() => {
    verifySession();
  }, [verifySession]);

  const switchRole = (newRole) => {
    setRole(newRole);
    localStorage.setItem('neronet_active_role', newRole);
  };

  const login = async (username, password) => {
    const res = await api.auth.login(username, password);
    if (res && res.user && res.token) {
      localStorage.setItem('neronet_jwt_token', res.token);
      localStorage.setItem('neronet_active_role', res.user.role || 'user');
      setUser(res.user);
      setRole(res.user.role || 'user');
      setToken(res.token);
      return res;
    }
    throw new Error(res?.error || 'Authentication failed');
  };

  const logout = async () => {
    try {
      await api.auth.logout();
    } catch (err) {
      // Ignore network errors on logout
    }
    clearAuth();
  };

  const refreshUser = async () => {
    try {
      const verifiedUser = await api.auth.me();
      if (verifiedUser && verifiedUser.id) {
        setUser(verifiedUser);
        setRole(verifiedUser.role || 'user');
      }
    } catch (e) {
      // ignore
    }
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        role,
        token,
        loading,
        isAuthenticated: !!token && !!user,
        switchRole,
        login,
        logout,
        refreshUser
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return ctx;
}

export default AuthContext;
