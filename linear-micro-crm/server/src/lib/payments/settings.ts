/**
 * Settings → Payments (MONEY-MISSED-2): "Two people approve each payment". When on, a live payment needs
 * a second approval by a DIFFERENT administrator, each with their own fresh two-step code, before anything is sent
 * (lib/payments/batches.ts approveBatch). Test-mode payments pay nobody and need one approval.
 *
 * Stored in meta `ext:payments:two_approvals` ('on' / 'off'). Unset, it is on when two or more active administrators
 * use two-step verification (the recommended setting), and off otherwise (one administrator could never get a second
 * approval). Changing it needs the admin's fresh code; the route's audit spec records who and when.
 */
import type { PaymentsSettings, UserWithTeam } from '@lm/shared';
import { get, run, type Db } from '../../db/connection.ts';
import { badRequest } from '../errors.ts';

export const TWO_APPROVALS_KEY = 'ext:payments:two_approvals';

/** Active administrators with two-step verification on (the people who can approve a payment). */
export function adminsWithTwoStep(db: Db): number {
  return Number(get<{ n: number }>(db, `SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND status = 'active' AND totp_enabled_at IS NOT NULL`)!.n);
}

export function paymentsSettings(db: Db): PaymentsSettings {
  const stored = get<{ value: string }>(db, `SELECT value FROM meta WHERE key = ?`, [TWO_APPROVALS_KEY])?.value ?? null;
  const admins = adminsWithTwoStep(db);
  const explicit = stored === 'on' || stored === 'off';
  return { twoApprovals: explicit ? stored === 'on' : admins >= 2, explicit, adminsWithTwoStep: admins };
}

/** The caller has checked the admin's fresh code. */
export function savePaymentsSettings(db: Db, _me: UserWithTeam, input: { twoApprovals?: unknown }): PaymentsSettings {
  if (typeof input?.twoApprovals !== 'boolean') throw badRequest('Say whether two people approve each payment (true or false)');
  run(db, `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [TWO_APPROVALS_KEY, input.twoApprovals ? 'on' : 'off']);
  return paymentsSettings(db);
}
