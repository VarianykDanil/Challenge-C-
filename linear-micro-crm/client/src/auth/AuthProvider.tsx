// Owned by the Frontend Developer. Contract: useAuth() shape is used by Login (Designer) and AppShell.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { AuthResponse, LoginInput, TwoFactorChallenge, UserWithTeam } from '@lm/shared';
import { api, ApiError } from '@/api/client';

/**
 * What `login()` resolves to. A plain credentials match signs the user in straight away; an account with
 * two-step verification on gets a short-lived challenge instead and must finish with `completeTwoFactor()`.
 * Both members carry `requiresTwoFactor`, so `if (result.requiresTwoFactor)` narrows cleanly.
 */
export type LoginResult =
  | { ok: true; requiresTwoFactor: false }
  | { ok: false; requiresTwoFactor: true; challengeToken: string };

export interface TwoFactorCompletion {
  challengeToken: string;
  /** Six digits from the authenticator app. */
  code?: string;
  /** One of the `xxxx-xxxx` recovery codes (single use). */
  recoveryCode?: string;
}

export interface AuthContextValue {
  user: UserWithTeam | null;
  loading: boolean;
  /** Callers that only `await login(...)` keep working; the result tells the Login page whether a second step is needed. */
  login: (input: LoginInput) => Promise<LoginResult>;
  /** Second sign-in step: POST /auth/login/2fa with the challenge from `login()`. Throws ApiError 401/410/429 like the contract says. */
  completeTwoFactor: (input: TwoFactorCompletion) => Promise<void>;
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

  const signedIn = useCallback(
    (res: AuthResponse) => {
      // Drop anything cached for a previous session before the new user's pages mount.
      qc.clear();
      setUser(res.user);
    },
    [qc],
  );

  const login = useCallback(
    async (input: LoginInput): Promise<LoginResult> => {
      const res = await api<AuthResponse | TwoFactorChallenge>('/auth/login', { method: 'POST', json: input });
      if ('requiresTwoFactor' in res && res.requiresTwoFactor) {
        // No session cookie yet: the user has to prove the second factor first.
        return { ok: false, requiresTwoFactor: true, challengeToken: res.challengeToken };
      }
      signedIn(res as AuthResponse);
      return { ok: true, requiresTwoFactor: false };
    },
    [signedIn],
  );

  const completeTwoFactor = useCallback(
    async (input: TwoFactorCompletion) => {
      const res = await api<AuthResponse>('/auth/login/2fa', { method: 'POST', json: input });
      signedIn(res);
    },
    [signedIn],
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

  const value = useMemo(
    () => ({ user, loading, login, completeTwoFactor, logout, refresh, clearSession }),
    [user, loading, login, completeTwoFactor, logout, refresh, clearSession],
  );
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
