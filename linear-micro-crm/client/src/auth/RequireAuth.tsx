// Owned by the Frontend Developer. Route guard: spinner while the session loads, redirect to /login otherwise.
import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from './AuthProvider';
import { FullPageSpinner } from '@/features/common/FullPageSpinner';

export function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <FullPageSpinner label="Signing you in…" />;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  return <>{children}</>;
}

/** Inverse guard for /login: send signed-in users to the app. */
export function RedirectIfAuthed({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <FullPageSpinner label="Loading…" />;
  if (user) {
    const state = location.state as { from?: string } | null;
    return <Navigate to={state?.from && state.from !== '/login' ? state.from : '/'} replace />;
  }
  return <>{children}</>;
}
