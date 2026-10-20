// Owned by the Frontend Developer. Role gate: renders the friendly NoAccess page for other roles.
import type { ReactNode } from 'react';
import type { Role } from '@lm/shared';
import { useAuth } from './AuthProvider';
import { NoAccessPage } from '@/pages/NoAccess';

export const RECRUITMENT_ROLES: Role[] = ['admin', 'leader', 'recruiter'];
export const CAMPAIGN_ROLES: Role[] = ['admin', 'leader'];
export const GAUGE_ROLES: Role[] = ['admin', 'leader', 'rep'];
/** Release 1.2: /audit (U3). */
export const AUDIT_ROLES: Role[] = ['admin'];
/** Release 1.2: /gauges/bulk (U2) — leaders for their own team, admins for any. */
export const BULK_GAUGE_ROLES: Role[] = ['admin', 'leader'];

export function RequireRole({ roles, children }: { roles: Role[]; children: ReactNode }) {
  const { user } = useAuth();
  if (!user || !roles.includes(user.role)) return <NoAccessPage roles={roles} />;
  return <>{children}</>;
}

export function hasRole(role: Role | undefined, roles: Role[]): boolean {
  return role != null && roles.includes(role);
}
