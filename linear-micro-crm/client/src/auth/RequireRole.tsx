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
/** Release 1.3: every staff role (venues P8, learning videos P5, the campaign page P6 — the server trims what each sees). */
export const STAFF_ROLES_ALL: Role[] = ['admin', 'leader', 'recruiter', 'rep'];
/** Release 1.3: /venues, /venues/:key (P8). */
export const VENUE_ROLES: Role[] = STAFF_ROLES_ALL;
/** Release 1.3: /finance/statements (P3). */
export const STATEMENT_ROLES: Role[] = ['admin'];
/** Release 1.3: /campaigns/:id (P6): admins and leaders in full, reps and recruiters the brief without money. */
export const CAMPAIGN_PAGE_ROLES: Role[] = STAFF_ROLES_ALL;
/** Release 1.3: /client, /client/security (P6) — client portal accounts only. */
export const CLIENT_ROLES: Role[] = ['client'];
/** Release 1.4: /finance/pay, /finance/pay/batches/:id (F payments). */
export const PAYMENT_ROLES: Role[] = ['admin'];

export function RequireRole({ roles, children }: { roles: Role[]; children: ReactNode }) {
  const { user } = useAuth();
  if (!user || !roles.includes(user.role)) return <NoAccessPage roles={roles} />;
  return <>{children}</>;
}

export function hasRole(role: Role | undefined, roles: Role[]): boolean {
  return role != null && roles.includes(role);
}
