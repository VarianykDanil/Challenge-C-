import { paydayForWeek, round2, type UserWithTeam } from '@lm/shared';
import { all, get, run, transaction, type Db } from './connection.ts';
import { bumpDataVersion } from '../lib/cache.ts';
import { addDays, isoWeek, mondayOf, nowHHMM, nowISO, sundayOf, todayISO } from '../lib/dates.ts';
import { conflict } from '../lib/errors.ts';
import { payableUsers, weekPayFor, type PayUser } from '../lib/pay.ts';

/**
 * Keep event statuses honest as the clock moves: past `scheduled`/`live` events become `completed`, and today's
 * `scheduled` events become `live` once their start time has passed (not before). Cancelled events are left alone.
 */
export function rollForwardEventStatuses(db: Db, today = todayISO(), now = nowHHMM()): { completed: number; live: number } {
  const completed = run(db, `UPDATE events SET status = 'completed' WHERE status IN ('scheduled', 'live') AND date < ?`, [today]).changes;
  const live = run(db, `UPDATE events SET status = 'live' WHERE status = 'scheduled' AND date = ? AND start_time <= ?`, [today, now]).changes;
  if (completed || live) bumpDataVersion();
  return { completed, live };
}

// ── payroll runs ─────────────────────────────────────────────────────────────

type RunUser = PayUser & { employeeId: string };

interface StoredRun {
  id: number;
  status: string;
  deductions: number;
  daysWorked: number;
  sales: number;
  teamSales: number;
  basePay: number;
  commission: number;
  bonus: number;
  overrides: number;
  gross: number;
}

const RUN_SELECT = `
  SELECT id, status, deductions, days_worked AS daysWorked, sales, team_sales AS teamSales, base_pay AS basePay,
         commission, bonus, overrides, gross
  FROM payroll_runs WHERE user_id = ? AND week_start = ?`;
const INSERT_RUN = `
  INSERT INTO payroll_runs
    (user_id, week_start, week_end, days_worked, sales, team_sales, base_pay, commission, bonus, overrides, deductions, gross, due_date, paid_date, status, reference)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, NULL, 'pending', ?)`;
const UPDATE_RUN = `
  UPDATE payroll_runs SET days_worked = ?, sales = ?, team_sales = ?, base_pay = ?, commission = ?, bonus = ?, overrides = ?, gross = ?
  WHERE id = ?`;

export const PAID_WEEK_MESSAGE = 'This week has already been paid — ask an administrator to adjust';

/** True when the person's run for the pay week containing `date` has been paid (`paid` or `late`). */
export function isWeekPaidFor(db: Db, userId: number, date: string): boolean {
  return Boolean(get(db, `SELECT 1 FROM payroll_runs WHERE user_id = ? AND week_start = ? AND status IN ('paid', 'late')`, [userId, mondayOf(date)]));
}

/**
 * Gauge writes for a week whose run has already been paid are refused with `409` unless the writer is an admin — an
 * admin's change goes through and flags the run `adjusted_at` so the payslip can say "adjusted after payment".
 */
export function assertWeekUnpaidFor(db: Db, me: UserWithTeam, userId: number, date: string): void {
  if (me.role === 'admin') return;
  if (isWeekPaidFor(db, userId, date)) throw conflict(PAID_WEEK_MESSAGE);
}

export type RunSync = 'created' | 'updated' | 'deleted' | 'unchanged' | 'flagged' | 'skipped';

/**
 * Brings one person's run for the Mon–Sun week starting `monday` in line with the gauges, by the same rules as the
 * seed and the live estimates (`weekPayFor`):
 *  - a week still in progress (or a week before the person started) is left alone (`skipped`);
 *  - a paid run (`paid`/`late`) is never recomputed — money already landed — but with `flagPaid` it is marked
 *    `adjusted_at` so finance can see the figures no longer match the gauges;
 *  - an unpaid run (`pending`/`failed`) is recomputed in place, keeping its status, due date, reference and any
 *    deductions; it is removed when nothing is payable any more;
 *  - a complete week with payable work and no run yet gets a `pending` run.
 */
export function syncPayrollRun(db: Db, user: RunUser, monday: string, today = todayISO(), opts: { flagPaid?: boolean } = {}): RunSync {
  const sunday = sundayOf(monday);
  if (!(sunday < today) || user.startDate > sunday) return 'skipped';
  const existing = get<StoredRun>(db, RUN_SELECT, [user.id, monday]);
  if (existing && (existing.status === 'paid' || existing.status === 'late')) {
    if (!opts.flagPaid) return 'skipped';
    run(db, `UPDATE payroll_runs SET adjusted_at = ? WHERE id = ?`, [nowISO(), existing.id]);
    return 'flagged';
  }
  const w = weekPayFor(db, user, monday, today);
  if (!w || w.pay.gross <= 0) {
    if (!existing) return 'unchanged';
    run(db, `DELETE FROM payroll_runs WHERE id = ?`, [existing.id]);
    return 'deleted';
  }
  if (!existing) {
    const { year, week } = isoWeek(monday);
    run(db, INSERT_RUN, [
      user.id, monday, sunday, w.daysWorked, w.sales, w.teamSales,
      w.pay.basePay, w.pay.commission, w.pay.bonus, w.pay.overrides, w.pay.gross,
      paydayForWeek(monday), `PAY-${year}${String(week).padStart(2, '0')}-${user.employeeId}`,
    ]);
    return 'created';
  }
  const gross = round2(w.pay.gross - existing.deductions);
  if (
    existing.daysWorked === w.daysWorked && existing.sales === w.sales && existing.teamSales === w.teamSales &&
    existing.basePay === w.pay.basePay && existing.commission === w.pay.commission && existing.bonus === w.pay.bonus &&
    existing.overrides === w.pay.overrides && existing.gross === gross
  ) return 'unchanged';
  run(db, UPDATE_RUN, [w.daysWorked, w.sales, w.teamSales, w.pay.basePay, w.pay.commission, w.pay.bonus, w.pay.overrides, gross, existing.id]);
  return 'updated';
}

/**
 * Everyone whose pay for the week moves when the entry (user, event) changes: the entry's owner, the leaders of the
 * owner's team (overrides on team sales) and the no-team seniors (owner / assistant owner) who attended the event
 * (their override counts other reps' sales at the events they ran).
 */
export function affectedPayUsers(db: Db, entry: { userId: number; eventId: number }): RunUser[] {
  return all<RunUser>(
    db,
    `SELECT u.id, u.employee_id AS employeeId, u.team_id AS teamId, u.pay_plan_id AS payPlanId, u.role, u.start_date AS startDate
     FROM users u JOIN pay_plans pp ON pp.id = u.pay_plan_id
     WHERE u.id = ?
        OR (pp.override_per_team_sale > 0 AND u.team_id IS NOT NULL AND u.team_id = (SELECT team_id FROM users WHERE id = ?))
        OR (pp.override_per_team_sale > 0 AND u.team_id IS NULL AND EXISTS (SELECT 1 FROM gauge_entries g WHERE g.user_id = u.id AND g.event_id = ?))
     ORDER BY u.id`,
    [entry.userId, entry.userId, entry.eventId],
  );
}

/**
 * After a gauge entry was created, changed or deleted (inside the caller's transaction): recompute the unpaid runs
 * of everyone affected for that pay week, create the run when the week is complete and had none, and flag paid runs
 * as adjusted. Returns what happened per affected person.
 */
export function syncPayrollForEntry(db: Db, entry: { userId: number; eventId: number; date: string }, today = todayISO()): RunSync[] {
  const monday = mondayOf(entry.date);
  return affectedPayUsers(db, entry).map((u) => syncPayrollRun(db, u, monday, today, { flagPaid: true }));
}

export interface MaterialiseResult {
  created: number;
  /** unpaid runs whose figures were brought back in line with the gauges */
  updated: number;
  /** unpaid runs removed because nothing was payable any more */
  deleted: number;
}

/**
 * Payroll materialisation, run at start-up, once a day and from the finance guard:
 *  1. creates the `pending` runs for every completed Mon–Sun week after the latest run (or from the first gauge week
 *     when there are none) — one run per payable user with gross > 0, due on the Friday after the week ends
 *     (`paydayForWeek`), reference `PAY-<ISO year><ISO week>-<employeeId>`;
 *  2. recomputes the unpaid runs of the last two completed weeks from the gauges (idempotent upsert), so late or
 *     corrected entries reach pay even when no request-path sync saw them. Paid runs are never touched.
 */
export function materialisePayrollRuns(db: Db, today = todayISO()): MaterialiseResult {
  const result: MaterialiseResult = { created: 0, updated: 0, deleted: 0 };
  const firstGauge = get<{ d: string | null }>(db, `SELECT MIN(date) AS d FROM gauge_entries`)!.d;
  if (!firstGauge) return result;
  const firstWeek = mondayOf(firstGauge);
  const latest = get<{ w: string | null }>(db, `SELECT MAX(week_start) AS w FROM payroll_runs`)!.w;
  const mondays = new Set<string>();
  for (let monday = latest ? addDays(latest, 7) : firstWeek; sundayOf(monday) < today; monday = addDays(monday, 7)) mondays.add(monday);
  const lastCompleted = addDays(mondayOf(today), -7);
  for (const monday of [lastCompleted, addDays(lastCompleted, -7)]) if (monday >= firstWeek) mondays.add(monday);
  transaction(db, () => {
    for (const monday of [...mondays].sort()) {
      if (!(sundayOf(monday) < today)) continue;
      for (const u of payableUsers(db, monday)) {
        const r = syncPayrollRun(db, u, monday, today);
        if (r === 'created') result.created++;
        else if (r === 'updated') result.updated++;
        else if (r === 'deleted') result.deleted++;
      }
    }
  });
  if (result.created || result.updated || result.deleted) bumpDataVersion();
  return result;
}

/** Request-path guard: materialise only when the last completed week has no runs yet (one cheap query otherwise). */
export function ensurePayrollMaterialised(db: Db, today = todayISO()): number {
  const latest = get<{ w: string | null }>(db, `SELECT MAX(week_start) AS w FROM payroll_runs`)!.w;
  const lastCompleted = addDays(mondayOf(today), -7);
  if (latest !== null && latest >= lastCompleted) return 0;
  return materialisePayrollRuns(db, today).created;
}
