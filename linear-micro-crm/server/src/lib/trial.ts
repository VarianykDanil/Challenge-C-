/**
 * What trial mode means for the people signed in (lib/trialMode.ts keeps the flag itself):
 *  - trialStatus: what the admins' banner and Needs-attention item say;
 *  - isRestrictedDemo / assertNotDemo: a one-tap demo sign-in account (anyone on the network can open one) or one of
 *    the demo company's people never sees or changes a real person's bank details, makes or promotes an admin, resets
 *    anyone's sign-in, hands out setup codes, switches a payment connection to live or approves a payment;
 *  - assertStepUp: those sensitive admin actions also need the acting admin's fresh two-step code.
 */
import type { Request } from 'express';
import { ACCESS_MESSAGES, type TrialStatus, type UserWithTeam } from '@lm/shared';
import { get, type Db } from '../db/connection.ts';
import { currentDataVersion } from './cache.ts';
import { HttpError } from './errors.ts';
import { DEMO_STAFF, demoAccountsAllowed, isDemoSignInAccount } from './demoTeams.ts';
import { assertFreshCode, codeSource } from './payments/code.ts';
import { isTwoFactorEnabled } from './twofactor.ts';
import { TRIAL_MODE_KEY, isDemoPerson, isTrialMode } from './trialMode.ts';

export { isTrialMode } from './trialMode.ts';

const statusCache = new WeakMap<Db, { version: number; status: TrialStatus }>();

/**
 * The banner's facts (trialMode false: no banner). One statement, cached per data version: the Needs-attention feed
 * asks on every dashboard load and has a budget. The same rule as lib/demoTeams.ts demoSignInsOn: trial mode, a
 * database the demo seed built, its four demo staff intact (role kept, not left), and demoAccountsAllowed.
 */
export function trialStatus(db: Db): TrialStatus {
  const version = currentDataVersion();
  const hit = statusCache.get(db);
  if (hit && hit.version === version) return withEnv(hit.status);
  const staff = DEMO_STAFF.map(() => `(upper(employee_id) = ? AND role = ?)`).join(' OR ');
  const row = get<{ trial: string | null; seeded: number; staff: number }>(
    db,
    `SELECT (SELECT value FROM meta WHERE key = '${TRIAL_MODE_KEY}') AS trial,
            (SELECT COUNT(*) FROM meta WHERE key IN ('seeded_at', 'seed_today') AND COALESCE(value, '') <> '') AS seeded,
            (SELECT COUNT(*) FROM users WHERE status <> 'left' AND (${staff})) AS staff`,
    DEMO_STAFF.flatMap((d) => [d.employeeId, d.role]),
  );
  const trialMode = row?.trial === '1';
  const status: TrialStatus = { trialMode, demoSignIns: trialMode && Number(row?.seeded) === 2 && Number(row?.staff) === DEMO_STAFF.length };
  statusCache.set(db, { version, status });
  return withEnv(status);
}

/** The environment (lib/demoTeams.ts demoAccountsAllowed) is read on every call, never cached. */
const withEnv = (s: TrialStatus): TrialStatus => (demoAccountsAllowed() ? s : { ...s, demoSignIns: false });

/** A one-tap demo account or a demo person, while in trial mode. Never anyone once the database has gone live. */
export function isRestrictedDemo(db: Db, user: Pick<UserWithTeam, 'id' | 'role' | 'email' | 'employeeId'>): boolean {
  if (!isTrialMode(db)) return false;
  return isDemoPerson(db, user.id) || isDemoSignInAccount(db, user);
}

/** 403 with `details.code: 'demo_account'` and a sentence saying what is refused ("create an administrator"). */
export function demoRefusal(what: string): HttpError {
  return new HttpError(403, ACCESS_MESSAGES.demoRefused(what), { code: 'demo_account', trialMode: true });
}

export function assertNotDemo(db: Db, me: UserWithTeam, what: string): void {
  if (isRestrictedDemo(db, me)) throw demoRefusal(what);
}

export const STEP_UP_TWO_FACTOR_MESSAGE =
  'Set up two-step verification in Settings → Security first: this needs a code from your authenticator app.';

/**
 * A sensitive admin action: refused for a demo account, and it needs the caller's fresh two-step code
 * (`req.body.code`, from the authenticator app, used once). Wrong codes count towards the same limiter as at sign-in.
 */
export function assertStepUp(db: Db, me: UserWithTeam, req: Request, what: string): void {
  assertNotDemo(db, me, what);
  if (!isTwoFactorEnabled(db, me.id)) throw new HttpError(403, STEP_UP_TWO_FACTOR_MESSAGE, { code: 'two_factor_required', twoFactorRequired: true });
  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as { code?: unknown };
  assertFreshCode(db, me, body.code, codeSource(req), { required: true });
}
