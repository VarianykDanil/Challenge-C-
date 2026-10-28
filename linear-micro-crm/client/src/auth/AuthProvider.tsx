// Owned by the Frontend Developer. Contract: useAuth() shape is used by Login (Designer) and AppShell.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { AuthResponse, LoginInput, LoginPinChallenge, TwoFactorChallenge, UserWithTeam } from '@lm/shared';
import { api, ApiError, NETWORK_EVENT, isNetworkError, type NetworkEventDetail } from '@/api/client';
import { AUTH_PROBE_TIMEOUT_MS } from '@/api/requestRules';
import { forgetSession, rememberSession } from '@/api/sessionEnd';
import { forgetKit, offlineUser, rememberKitUser } from '@/offline/fieldKit';

/**
 * What `login()` resolves to. A plain credentials match signs the user in straight away; an account with
 * two-step verification on gets a short-lived challenge instead and must finish with `completeTwoFactor()`.
 * Release 1.2 (U1): an account with a PIN signed in without one gets `requiresPin` (no session yet) and calls
 * `login()` again with the same details plus `pin`.
 * Every member carries `requiresTwoFactor` and `requiresPin`, so `if (result.requiresPin)` / `if (result.requiresTwoFactor)`
 * narrow cleanly.
 */
export type LoginResult =
  | { ok: true; requiresTwoFactor: false; requiresPin: false }
  | { ok: false; requiresTwoFactor: true; requiresPin: false; challengeToken: string }
  | { ok: false; requiresTwoFactor: false; requiresPin: true; attemptsLeft: number };

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

/** A tab coming back to the front re-reads /auth/me at most this often. */
const VISIBLE_REFRESH_MS = 60_000;
/** While Linear Hub cannot be reached, the session is checked again this often (and as soon as anything answers). */
const UNREACHABLE_RETRY_MS = 15_000;

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [user, setUser] = useState<UserWithTeam | null>(null);
  const [loading, setLoading] = useState(true);
  // the last session check could not reach Linear Hub (no signal, no answer in time, the proxy says it is down)
  const [unreachable, setUnreachable] = useState(false);
  const firstCheck = useRef(true);

  const refresh = useCallback(async () => {
    // The check when the app opens waits only a few seconds: on a weak signal the app then opens as the person last
    // signed in here instead of showing "Loading…" for as long as the connection hangs.
    const timeoutMs = firstCheck.current ? AUTH_PROBE_TIMEOUT_MS : undefined;
    firstCheck.current = false;
    try {
      const res = await api<AuthResponse>('/auth/me', { timeoutMs });
      // Release 1.4: when this session ends, so the sign-in page can say why once it has (api/sessionEnd.ts)
      rememberSession(res.session);
      setUser(res.user);
      rememberKitUser(res.user, res.session);
      setUnreachable(false);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        setUser(null);
        forgetKit();
        setUnreachable(false);
      }
      // No signal when the app opens: carry on as the person last signed in on this phone (src/offline/fieldKit.ts),
      // so they can log gauges and check in; it all waits on the phone and sends once they are signed in online. The
      // kit only lasts as long as their session would have. Linear Hub is asked again in the background (below).
      else if (isNetworkError(e)) {
        setUser((current) => current ?? offlineUser());
        setUnreachable(true);
      }
      // Other server errors keep the current user and let pages surface the error.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Could not reach Linear Hub: ask again every 15 s, and as soon as the phone's signal returns or any request gets an
  // answer. Then the real session takes over: the person carries on, or meets the sign-in page if it has ended.
  useEffect(() => {
    if (!unreachable) return;
    let busy = false;
    const again = () => {
      if (busy) return;
      busy = true;
      void refresh().finally(() => {
        busy = false;
      });
    };
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') again();
    }, UNREACHABLE_RETRY_MS);
    const onNetwork = (e: Event) => {
      if ((e as CustomEvent<NetworkEventDetail>).detail?.online) again();
    };
    window.addEventListener('online', again);
    window.addEventListener(NETWORK_EVENT, onNetwork);
    return () => {
      window.clearInterval(id);
      window.removeEventListener('online', again);
      window.removeEventListener(NETWORK_EVENT, onNetwork);
    };
  }, [unreachable, refresh]);

  // Release 1.2 (U1): re-read /auth/me when a signed-in tab comes back to the front (at most once a minute), so a
  // session that ended while the phone was in a pocket — the idle timeout, a PIN reset, a new sign-in rule — shows the
  // sign-in page or the "Create your PIN" step straight away instead of a page of stale cards.
  const signedInRef = useRef(false);
  useEffect(() => {
    signedInRef.current = user !== null;
  }, [user]);
  useEffect(() => {
    let last = Date.now();
    const onVisible = () => {
      if (document.visibilityState !== 'visible' || !signedInRef.current || Date.now() - last < VISIBLE_REFRESH_MS) return;
      last = Date.now();
      void refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [refresh]);

  const signedIn = useCallback(
    (res: AuthResponse) => {
      // Drop anything cached for a previous session before the new user's pages mount.
      qc.clear();
      rememberSession(res.session);
      setUser(res.user);
      rememberKitUser(res.user, res.session);
      setUnreachable(false);
    },
    [qc],
  );

  const login = useCallback(
    async (input: LoginInput): Promise<LoginResult> => {
      const res = await api<AuthResponse | TwoFactorChallenge | LoginPinChallenge>('/auth/login', { method: 'POST', json: input });
      if ('requiresPin' in res && res.requiresPin) {
        // No session cookie yet: the account has a PIN and none was sent.
        return { ok: false, requiresTwoFactor: false, requiresPin: true, attemptsLeft: res.attemptsLeft };
      }
      if ('requiresTwoFactor' in res && res.requiresTwoFactor) {
        // No session cookie yet: the user has to prove the second factor first.
        return { ok: false, requiresTwoFactor: true, requiresPin: false, challengeToken: res.challengeToken };
      }
      signedIn(res as AuthResponse);
      return { ok: true, requiresTwoFactor: false, requiresPin: false };
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
      forgetSession(); // signed out by hand: nothing to explain at the next sign-in
      forgetKit();
      setUser(null);
      qc.clear();
    }
  }, [qc]);

  const clearSession = useCallback(() => {
    forgetKit();
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
