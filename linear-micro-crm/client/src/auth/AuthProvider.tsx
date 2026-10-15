// Owned by the Frontend Developer. Contract: useAuth() shape is used by Login (Designer) and AppShell.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { AuthResponse, LoginInput, UserWithTeam } from '@lm/shared';
import { api, ApiError } from '@/api/client';

export interface AuthContextValue {
  user: UserWithTeam | null;
  loading: boolean;
  login: (input: LoginInput) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  /** Drop the signed-in user and every cached query without calling the server (session already gone). */
  clearSession: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [user, setUser] = useState<UserWithTeam | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const res = await api<AuthResponse>('/auth/me');
      setUser(res.user);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setUser(null);
      // Network / server errors keep the current user and let pages surface the error.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const login = useCallback(
    async (input: LoginInput) => {
      const res = await api<AuthResponse>('/auth/login', { method: 'POST', json: input });
      // Drop anything cached for a previous session before the new user's pages mount.
      qc.clear();
      setUser(res.user);
    },
    [qc],
  );

  const logout = useCallback(async () => {
    try {
      await api<void>('/auth/logout', { method: 'POST' });
    } finally {
      setUser(null);
      qc.clear();
    }
  }, [qc]);

  const clearSession = useCallback(() => {
    setUser(null);
    qc.clear();
  }, [qc]);

  const value = useMemo(() => ({ user, loading, login, logout, refresh, clearSession }), [user, loading, login, logout, refresh, clearSession]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

/** Convenience: the signed-in user, asserting a page is behind RequireAuth. */
export function useCurrentUser(): UserWithTeam {
  const { user } = useAuth();
  if (!user) throw new Error('useCurrentUser must be used behind RequireAuth');
  return user;
}
