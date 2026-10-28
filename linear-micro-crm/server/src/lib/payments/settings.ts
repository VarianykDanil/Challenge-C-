/**
 * Settings → Payments (MONEY-MISSED-2): "Two people approve each payment". When on, a live payment needs
 * a second approval by a DIFFERENT administrator, each with their own fresh two-step code, before anything is sent
 * (lib/payments/batches.ts approveBatch). Test-mode payments pay nobody and need one approval.
 *
 * Stored in meta `ext:payments:two_approvals`: 'on' / 'off' (an administrator chose), or 'auto-on' (on by default and
 * kept on). Unset, it is on when two or more active administrators use two-step verification, and that default is
 * stored the first time it is read (and at start-up), so it never switches itself off when an administrator leaves or
 * stops using two-step. It stays on with one such administrator left (`stuck`: live payments wait, and the office is
 * told to add an administrator or turn it off).
 *
 * Turning it off is the change the second approval is there to check, so while two or more administrators use
 * two-step it needs two of them: the first asks (meta `ext:payments:two_approvals_off_request`, {by, at}; the other
 * administrators get a danger item in Needs attention), a different one agrees and it goes off. Turning it on, or
 * keeping it on, cancels a request. With one such administrator left, that one may turn it off. Every change needs the
 * administrator's fresh code (checked last, so a refused change keeps the code); the route's audit spec records it.
 */
import type { PaymentsSettings, UserWithTeam } from '@lm/shared';
import { all, get, run, type Db } from '../../db/connection.ts';
import { nowISO } from '../dates.ts';
import { badRequest, conflict } from '../errors.ts';
import { isRestrictedDemo } from '../trial.ts';

export const TWO_APPROVALS_KEY = 'ext:payments:two_approvals';
export const TWO_APPROVALS_OFF_REQUEST_KEY = 'ext:payments:two_approvals_off_request';

/**
 * Active administrators with two-step verification on (the people who can approve a payment). During the trial a
 * one-tap demo administrator may turn two-step on, but it may never approve a payment or change this setting
 * (lib/demoWrites.ts), so it does not count: otherwise it would switch two approvals on for good and leave live
 * payments waiting for a second approval nobody can give.
 */
export function adminsWithTwoStep(db: Db): number {
  const admins = all<Pick<UserWithTeam, 'id' | 'role' | 'email' | 'employeeId'>>(
    db,
    `SELECT id, role, email, employee_id AS employeeId FROM users WHERE role = 'admin' AND status = 'active' AND totp_enabled_at IS NOT NULL`,
  );
  return admins.filter((a) => !isRestrictedDemo(db, a)).length;
}

const readMeta = (db: Db, key: string): string | null => get<{ value: string }>(db, `SELECT value FROM meta WHERE key = ?`, [key])?.value ?? null;
const writeMeta = (db: Db, key: string, value: string): void => {
  run(db, `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [key, value]);
};

/**
 * Stores the default ('auto-on') once two or more administrators use two-step, so it stays on from then on. Returns
 * true when it stored it (the extension's start-up step names the change).
 */
export function keepTwoApprovalsDefault(db: Db, admins: number = adminsWithTwoStep(db)): boolean {
  if (admins < 2 || readMeta(db, TWO_APPROVALS_KEY) !== null) return false;
  writeMeta(db, TWO_APPROVALS_KEY, 'auto-on');
  return true;
}

interface OffRequest {
  by: number;
  at: string;
}

function offRequestOf(db: Db): OffRequest | null {
  const raw = readMeta(db, TWO_APPROVALS_OFF_REQUEST_KEY);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<OffRequest>;
    return typeof v.by === 'number' && typeof v.at === 'string' ? { by: v.by, at: v.at } : null;
  } catch {
    return null;
  }
}

const nameOf = (db: Db, id: number): string | null =>
  get<{ name: string }>(db, `SELECT TRIM(first_name || ' ' || last_name) AS name FROM users WHERE id = ?`, [id])?.name || null;

export function paymentsSettings(db: Db): PaymentsSettings {
  const admins = adminsWithTwoStep(db);
  keepTwoApprovalsDefault(db, admins);
  const stored = readMeta(db, TWO_APPROVALS_KEY);
  const on = stored === 'on' || stored === 'auto-on';
  const request = on ? offRequestOf(db) : null;
  return {
    twoApprovals: on,
    explicit: stored === 'on' || stored === 'off',
    adminsWithTwoStep: admins,
    offRequest: request ? { byId: request.by, byName: nameOf(db, request.by), at: request.at } : null,
    stuck: on && admins < 2,
  };
}

/** What a change did: 'changed' (on or off now), 'asked' (a request to turn it off now waits for a second person). */
export type PaymentsSettingsChange = 'changed' | 'asked' | 'unchanged';

/**
 * Turns two approvals on or off for `me` (an administrator). `verifyCode` checks their fresh code; it runs once the
 * change is allowed. Turning off with two or more administrators using two-step asks first (see the file comment).
 */
export function savePaymentsSettings(
  db: Db,
  me: UserWithTeam,
  input: { twoApprovals?: unknown },
  verifyCode: () => void,
): { settings: PaymentsSettings; change: PaymentsSettingsChange } {
  if (typeof input?.twoApprovals !== 'boolean') throw badRequest('Say whether two people approve each payment (true or false)');
  const current = paymentsSettings(db);
  if (input.twoApprovals) {
    verifyCode();
    const before = readMeta(db, TWO_APPROVALS_KEY);
    writeMeta(db, TWO_APPROVALS_KEY, 'on');
    const cancelled = run(db, `DELETE FROM meta WHERE key = ?`, [TWO_APPROVALS_OFF_REQUEST_KEY]).changes > 0;
    return { settings: paymentsSettings(db), change: cancelled || before !== 'on' ? 'changed' : 'unchanged' };
  }
  if (!current.twoApprovals) {
    verifyCode();
    writeMeta(db, TWO_APPROVALS_KEY, 'off');
    return { settings: paymentsSettings(db), change: 'unchanged' };
  }
  const request = offRequestOf(db);
  if (current.adminsWithTwoStep >= 2) {
    if (!request) {
      verifyCode();
      writeMeta(db, TWO_APPROVALS_OFF_REQUEST_KEY, JSON.stringify({ by: me.id, at: nowISO() } satisfies OffRequest));
      return { settings: paymentsSettings(db), change: 'asked' };
    }
    if (request.by === me.id) {
      throw conflict('You asked to turn it off. A different administrator must agree, with their own code.');
    }
  }
  verifyCode();
  writeMeta(db, TWO_APPROVALS_KEY, 'off');
  run(db, `DELETE FROM meta WHERE key = ?`, [TWO_APPROVALS_OFF_REQUEST_KEY]);
  return { settings: paymentsSettings(db), change: 'changed' };
}
