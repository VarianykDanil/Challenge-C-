/**
 * Release 1.3 (r3-foundation, STABLE): the client role on the server. A `client` user is a campaign's client signed in
 * to the client portal (users.role = 'client', users.client_campaign_id = their campaign). They are not staff: every
 * staff list leaves them out with STAFF_ONLY_SQL, and the client guard (middleware/clientGuard.ts) keeps their session
 * to the portal. P6 builds the accounts (invite, PIN, deactivate) on these helpers and may add functions here.
 *
 * The DEMO client account (db/seed.ts, from seed-data.ts CLIENT_ACCOUNTS) is recognised by a marker the core demo seed
 * writes (meta `seed_demo_clients`), never by its access code alone. An upgraded database has no marker unless the 1.3.1
 * start-up step (db/extensions/client.ts addDemoClientAccount) inserted the demo client on a database that is still the
 * demo, so a real client is never treated as the demo one (listed on the sign-in page, or let in without a PIN).
 */
import { formatClientAccessCode, type UserWithTeam } from '@lm/shared';
import { get, run, type Db } from '../db/connection.ts';
import { CLIENT_ACCOUNTS, type ClientAccountSeed } from '../db/seed-data.ts';
import type { SeedClientRef } from '../db/extensions/types.ts';
import { addDays, mondayOf } from './dates.ts';

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

/**
 * The access codes the demo seed gives its client accounts (seed-data.ts CLIENT_ACCOUNTS; a contract test keeps the two
 * in step). They are reserved: nextClientAccessCode never hands one out, even on a database without the demo client.
 */
export const DEMO_CLIENT_ACCESS_CODES: readonly string[] = ['CL-0001'];

/** The next free access code ("CL-0002", "CL-0003"…), like nextEmployeeId for staff. Never a reserved demo code. */
export function nextClientAccessCode(db: Db): string {
  const row = get<{ n: number | null }>(db, `SELECT MAX(CAST(substr(employee_id, 4) AS INTEGER)) AS n FROM users WHERE employee_id LIKE 'CL-%'`);
  const reserved = Math.max(0, ...DEMO_CLIENT_ACCESS_CODES.map((c) => Number(c.slice(3))));
  return formatClientAccessCode(Math.max(row?.n ?? 0, reserved) + 1);
}

/** users.pay_plan_id is required: client accounts point at the owner's plan (they are never paid). */
export function clientPayPlanId(db: Db): number {
  const row = get<{ id: number }>(db, `SELECT id FROM pay_plans ORDER BY (position = 'owner') DESC, id ASC LIMIT 1`);
  if (!row) throw new Error('No pay plan exists to attach a client account to');
  return row.id;
}

// ── the demo client account(s) ──

/** meta key the core demo seed writes: JSON `DemoClientMarker[]`, the demo client accounts it inserted. */
export const DEMO_CLIENTS_META_KEY = 'seed_demo_clients';

/** One demo client account as the seed inserted it. The account stops being "the demo" once its code or email change. */
export interface DemoClientMarker {
  id: number;
  employeeId: string;
  email: string;
}

/**
 * Inserts the demo client accounts (seed-data.ts CLIENT_ACCOUNTS) whose campaign exists: role/position 'client', no
 * team, `payPlanId` (the owner's plan: users.pay_plan_id is required, and lib/pay.ts never pays a client), no PIN, joined
 * four weeks before this week's Monday. Shared by the fresh demo seed (db/seed.ts) and the start-up step that gives an
 * older demo database its charity account (db/extensions/client.ts), so both make the same rows. The caller writes
 * the marker (writeDemoClientMarkers) for what this returns.
 */
export function insertDemoClientAccounts(
  db: Db,
  opts: { today: string; payPlanId: number; accounts?: readonly ClientAccountSeed[] },
): SeedClientRef[] {
  const startDate = addDays(mondayOf(opts.today), -28);
  return (opts.accounts ?? CLIENT_ACCOUNTS).flatMap((c) => {
    const campaign = get<{ id: number }>(db, `SELECT id FROM campaigns WHERE code = ?`, [c.campaign]);
    if (!campaign) return [];
    const r = run(
      db,
      `INSERT INTO users (employee_id, email, first_name, last_name, role, position, team_id, pay_plan_id, start_date, status, phone, avatar_color, city, client_campaign_id)
       VALUES (?, ?, ?, ?, 'client', 'client', NULL, ?, ?, 'active', NULL, ?, NULL, ?)`,
      [c.code, c.email, c.firstName, c.lastName, opts.payPlanId, startDate, c.color, campaign.id],
    );
    return [{ id: Number(r.lastInsertRowid), employeeId: c.code, firstName: c.firstName, lastName: c.lastName, email: c.email, campaignId: campaign.id }];
  });
}

/** Written by db/seed.ts and the client extension's start-up step only, right after they insert the demo client accounts. */
export function writeDemoClientMarkers(db: Db, clients: readonly DemoClientMarker[]): void {
  const value = JSON.stringify(clients.map(({ id, employeeId, email }) => ({ id, employeeId, email })));
  run(db, `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [DEMO_CLIENTS_META_KEY, value]);
}

/** The demo client accounts the seed recorded ([] on a database the demo seed did not create, or an unreadable value). */
export function demoClientMarkers(db: Db): DemoClientMarker[] {
  const raw = get<{ value: string }>(db, `SELECT value FROM meta WHERE key = ?`, [DEMO_CLIENTS_META_KEY])?.value;
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (m): m is DemoClientMarker =>
        typeof m === 'object' && m !== null && Number.isInteger((m as DemoClientMarker).id) &&
        typeof (m as DemoClientMarker).employeeId === 'string' && typeof (m as DemoClientMarker).email === 'string',
    );
  } catch {
    return [];
  }
}

/** True when this user row is the marker's account: same id, access code and email (case-insensitive), role client. */
export function matchesDemoClient(marker: DemoClientMarker, user: Pick<UserWithTeam, 'id' | 'role' | 'email' | 'employeeId'>): boolean {
  return (
    isClientUser(user) && marker.id === user.id &&
    marker.employeeId.toLowerCase() === user.employeeId.toLowerCase() && marker.email.toLowerCase() === user.email.toLowerCase()
  );
}

/**
 * True only for a demo client account the core demo seed inserted (and whose code and email are unchanged). Staff, and
 * every client P6 invites, are false. P6's client PIN rule exempts this account so the demo sign-in button works.
 */
export function isDemoClientAccount(db: Db, user: Pick<UserWithTeam, 'id' | 'role' | 'email' | 'employeeId'> | null | undefined): boolean {
  if (!user || !isClientUser(user)) return false;
  return demoClientMarkers(db).some((m) => matchesDemoClient(m, user));
}

// ── what a client session carries ──

/** The office fields a client account's own user payload leaves out (/auth/me and the sign-in responses). */
export const CLIENT_HIDDEN_USER_FIELDS = ['teamId', 'teamName', 'payPlanId', 'payPlanName'] as const;

/**
 * A client account's own payload without the office's details (the owner's pay plan it is attached to, team fields);
 * staff rows are returned unchanged. Used by middleware/auth.ts (req.user, /auth/me) and routes/auth.ts (sign-in).
 * The shared UserWithTeam type still declares those fields: a client session's code never reads them.
 */
export function clientSafeUser<T extends UserWithTeam>(user: T): T {
  if (!isClientUser(user)) return user;
  const out: Partial<T> = { ...user };
  for (const k of CLIENT_HIDDEN_USER_FIELDS) delete out[k];
  return out as T;
}
