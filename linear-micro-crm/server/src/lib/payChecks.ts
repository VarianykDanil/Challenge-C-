/**
 * What the office should look at before paying an unpaid run (MON-1, MONEY-MISSED-3), attached to GET
 * /finance/payroll (admins) and to each person on a payment's page:
 *  - daysWaiting: gauge days the person logged with no booking or check-in (or nothing logged) and no decision yet:
 *    they are NOT in this pay; a leader's confirmation adds them (lib/payDays.ts);
 *  - unconfirmed: the part of the pay resting on subs the rep logged that no client statement has confirmed — still
 *    waiting for the statement, or a campaign whose client sends none (shared unconfirmedPay on the run's stored
 *    calculation).
 * Two grouped reads for any number of runs.
 */
import { unconfirmedPay, type PayrollRunChecks, type PayrollRunWithUser, type UserWithTeam } from '@lm/shared';
import { all, placeholders, type Db } from '../db/connection.ts';
import { PAY_DAY_CHECKS_KEY } from './payDays.ts';
import { parseSnapshot } from './payWeek.ts';

/** Waiting days per (user, Monday) for these people between `from` and `to`. */
export function waitingDaysByWeek(db: Db, userIds: readonly number[], from: string, to: string): Map<string, number> {
  const ids = [...new Set(userIds)];
  if (!ids.length) return new Map();
  const rows = all<{ userId: number; week: string; n: number }>(
    db,
    `SELECT userId, week, COUNT(*) AS n FROM (
       SELECT g.user_id AS userId, date(g.date, '-6 days', 'weekday 1') AS week, g.date
       FROM gauge_entries g
       WHERE g.user_id IN (${placeholders(ids.length)}) AND g.date BETWEEN ? AND ?
         AND EXISTS (SELECT 1 FROM meta m WHERE m.key = ? AND m.value = 'on')
         AND NOT EXISTS (SELECT 1 FROM pay_day_checks d WHERE d.user_id = g.user_id AND d.date = g.date)
       GROUP BY g.user_id, g.date
       HAVING MAX((g.stops + g.table_count + g.presentations + g.closes + g.taps + g.sales) > 0
                  AND (EXISTS (SELECT 1 FROM event_roster r WHERE r.event_id = g.event_id AND r.user_id = g.user_id)
                       OR EXISTS (SELECT 1 FROM check_ins ci WHERE ci.user_id = g.user_id AND ci.event_id = g.event_id AND ci.date = g.date))) = 0
     ) GROUP BY userId, week`,
    [...ids, from, to, PAY_DAY_CHECKS_KEY],
  );
  return new Map(rows.map((r) => [`${Number(r.userId)}|${r.week}`, Number(r.n)]));
}

/** The checks for each run id (only runs with something to check). */
export function payrollChecksFor(db: Db, runs: readonly Pick<PayrollRunWithUser, 'id' | 'userId' | 'weekStart' | 'weekEnd'>[]): Map<number, PayrollRunChecks> {
  const out = new Map<number, PayrollRunChecks>();
  if (!runs.length) return out;
  const from = runs.reduce((m, r) => (r.weekStart < m ? r.weekStart : m), runs[0]!.weekStart);
  const to = runs.reduce((m, r) => (r.weekEnd > m ? r.weekEnd : m), runs[0]!.weekEnd);
  const waiting = waitingDaysByWeek(db, runs.map((r) => r.userId), from, to);
  const ids = runs.map((r) => r.id);
  const snaps = new Map(
    all<{ id: number; json: string | null }>(db, `SELECT id, breakdown_json AS json FROM payroll_runs WHERE id IN (${placeholders(ids.length)})`, ids).map((r) => [Number(r.id), r.json]),
  );
  for (const r of runs) {
    const daysWaiting = waiting.get(`${r.userId}|${r.weekStart}`) ?? 0;
    const snap = parseSnapshot(snaps.get(r.id));
    const unconfirmed = snap && snap.rule === 'base-or-commission' && !snap.salaried ? unconfirmedPay(snap.result) : null;
    if (daysWaiting || (unconfirmed && unconfirmed.amount > 0)) out.set(r.id, { daysWaiting, unconfirmed: unconfirmed && unconfirmed.amount > 0 ? unconfirmed : null });
  }
  return out;
}

/** GET /finance/payroll: unpaid runs gain `checks` for admins (nothing changes for anyone else). */
export function withPayrollChecks<T extends PayrollRunWithUser>(db: Db, runs: T[], me: UserWithTeam): T[] {
  if (me.role !== 'admin') return runs;
  const unpaid = runs.filter((r) => r.status === 'pending' || r.status === 'failed');
  if (!unpaid.length) return runs;
  const checks = payrollChecksFor(db, unpaid);
  if (!checks.size) return runs;
  return runs.map((r) => (checks.has(r.id) ? { ...r, checks: checks.get(r.id)! } : r));
}
