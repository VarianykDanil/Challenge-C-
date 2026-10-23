/**
 * Release 1.4 — OWNED BY package S (security: two-step for everyone, 14-hour sessions). This package's audit specs,
 * in the shape of lib/auditSpecs.ts (AuditRouteSpec), registered through ./registry.ts:
 *
 *   POST /client-accounts/:id/reset-2fa   "Reset the two-step verification of Hannah Price (Breast Cancer Now); they
 *                                         set it up again at their next sign-in" — filed under the client account,
 *                                         the admin as the actor, with before/after snapshots (twoFactor true → false).
 *
 * The other writes this package changed keep their 1.2 / 1.3 specs: PUT /auth/security-settings (lib/auditSpecs.ts,
 * whose snapshot takes any setting, so the new `sessionMaxHours` is recorded as "Sign out after (hours from sign-in)"),
 * POST /users/:id/2fa/reset, the sign-in and two-step routes. The automatic sign-out at the hours-from-sign-in limit
 * is not a route: middleware/auth.ts records it (lib/audit/sessions.ts recordMaxAgeSignOut), like the idle one.
 * Snapshots never hold a secret, a code or a hash: two-step is only ever `twoFactor: true | false`.
 */
import { get, type Db } from '../../db/connection.ts';
import type { AuditCall, AuditRouteSpec } from '../auditSpecs.ts';

type Snap = Record<string, unknown>;

const toId = (v: unknown): number | null => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : null;
};
const paramId = (call: AuditCall) => toId(call.params.id);
const str = (v: unknown, fallback: string): string => (typeof v === 'string' && v ? v : fallback);

/** A client account as the trail shows it: name, email, access code, campaign, PIN set, two-step on. */
export function clientSecuritySnapshot(db: Db, id: number): Snap | null {
  const row = get<Snap>(
    db,
    `SELECT u.id, TRIM(u.first_name || ' ' || u.last_name) AS name, u.email, u.employee_id AS accessCode, u.status,
            (u.pin_hash IS NOT NULL) AS pinSet, (u.totp_enabled_at IS NOT NULL) AS twoFactor, u.client_campaign_id AS campaignId,
            c.name AS campaignName
     FROM users u LEFT JOIN campaigns c ON c.id = u.client_campaign_id WHERE u.id = ? AND u.role = 'client'`,
    [id],
  );
  return row ? { ...row, pinSet: row.pinSet === 1 || row.pinSet === true, twoFactor: row.twoFactor === 1 || row.twoFactor === true } : null;
}

const personOf = (s: Snap | null) => `${str(s?.name, 'a client')}${s?.campaignName ? ` (${str(s.campaignName, '')})` : ''}`;

interface Before {
  id: number | null;
  before: Snap | null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const AUDIT_SPECS: readonly AuditRouteSpec<any>[] = [
  {
    method: 'POST',
    pattern: '/client-accounts/:id/reset-2fa',
    before(db, call) {
      const id = paramId(call);
      return { id, before: id ? clientSecuritySnapshot(db, id) : null };
    },
    after(db, _done, state) {
      const id = state?.id ?? null;
      if (!id) return [];
      const after = clientSecuritySnapshot(db, id);
      return [{
        entity: 'client_account',
        entityId: id,
        summary: `Reset the two-step verification of ${personOf(after ?? state?.before ?? null)}; they set it up again at their next sign-in`,
        before: state?.before ?? null,
        after,
      }];
    },
  } satisfies AuditRouteSpec<Before>,
];
