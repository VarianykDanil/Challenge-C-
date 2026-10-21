/**
 * Release 1.3 (r3-foundation, STABLE): the client role on the server. A `client` user is a campaign's client signed in
 * to the client portal (users.role = 'client', users.client_campaign_id = their campaign). They are not staff: every
 * staff list leaves them out with STAFF_ONLY_SQL, and the client guard (middleware/clientGuard.ts) keeps their session
 * to the portal. P6 builds the accounts (invite, PIN, deactivate) on these helpers.
 */
import { formatClientAccessCode, type UserWithTeam } from '@lm/shared';
import { get, type Db } from '../db/connection.ts';

export const CLIENT_ROLE = 'client' as const;

/** True for a client portal session (or user row). */
export function isClientUser(user: Pick<UserWithTeam, 'role'> | null | undefined): boolean {
  return user?.role === CLIENT_ROLE;
}

/** SQL predicate on a users alias that leaves client accounts out of a staff list: `${staffOnly('u')}`. */
export function staffOnly(alias = 'u'): string {
  return `${alias}.role <> '${CLIENT_ROLE}'`;
}

/** The campaign a client account belongs to (null for staff, or a client whose campaign is gone). */
export function clientCampaignIdOf(db: Db, userId: number): number | null {
  const row = get<{ c: number | null }>(db, `SELECT client_campaign_id AS c FROM users WHERE id = ? AND role = '${CLIENT_ROLE}'`, [userId]);
  return row?.c ?? null;
}

/** The next free access code ("CL-0001", "CL-0002"…), like nextEmployeeId for staff. */
export function nextClientAccessCode(db: Db): string {
  const row = get<{ n: number | null }>(db, `SELECT MAX(CAST(substr(employee_id, 4) AS INTEGER)) AS n FROM users WHERE employee_id LIKE 'CL-%'`);
  return formatClientAccessCode((row?.n ?? 0) + 1);
}

/** users.pay_plan_id is required: client accounts point at the owner's plan (they are never paid). */
export function clientPayPlanId(db: Db): number {
  const row = get<{ id: number }>(db, `SELECT id FROM pay_plans ORDER BY (position = 'owner') DESC, id ASC LIMIT 1`);
  if (!row) throw new Error('No pay plan exists to attach a client account to');
  return row.id;
}
