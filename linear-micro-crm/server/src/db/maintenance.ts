import { paydayForWeek } from '@lm/shared';
import { get, run, transaction, type Db } from './connection.ts';
import { addDays, isoWeek, mondayOf, nowHHMM, sundayOf, todayISO } from '../lib/dates.ts';
import { payableUsers, weekPayFor } from '../lib/pay.ts';

/**
 * Keep event statuses honest as the clock moves: past `scheduled`/`live` events become `completed`, and today's
 * `scheduled` events become `live` once their start time has passed (not before). Cancelled events are left alone.
 */
export function rollForwardEventStatuses(db: Db, today = todayISO(), now = nowHHMM()): { completed: number; live: number } {
  const completed = run(db, `UPDATE events SET status = 'completed' WHERE status IN ('scheduled', 'live') AND date < ?`, [today]).changes;
  const live = run(db, `UPDATE events SET status = 'live' WHERE status = 'scheduled' AND date = ? AND start_time <= ?`, [today, now]).changes;
  return { completed, live };
}

const INSERT_RUN = `
  INSERT OR IGNORE INTO payroll_runs
    (user_id, week_start, week_end, days_worked, sales, team_sales, base_pay, commission, bonus, overrides, deductions, gross, due_date, paid_date, status, reference)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'pending', ?)`;

/**
 * Create the pending payroll runs for every completed Mon–Sun week after the latest run (or from the first gauge
 * week when there are none): one run per payable user with gross > 0, by the same rules as the seed (`weekPayFor`),
 * due on the Friday after the week ends (`paydayForWeek`), reference `PAY-<ISO year><ISO week>-<employeeId>`.
 * Idempotent: `INSERT OR IGNORE` on the UNIQUE (user, week) key. Returns the number of runs created.
 */
export function materialisePayrollRuns(db: Db, today = todayISO()): number {
  const latest = get<{ w: string | null }>(db, `SELECT MAX(week_start) AS w FROM payroll_runs`)!.w;
  let monday: string;
  if (latest) monday = addDays(latest, 7);
  else {
    const first = get<{ d: string | null }>(db, `SELECT MIN(date) AS d FROM gauge_entries`)!.d;
    if (!first) return 0;
    monday = mondayOf(first);
  }
  let created = 0;
  transaction(db, () => {
    for (; sundayOf(monday) < today; monday = addDays(monday, 7)) {
      const sunday = sundayOf(monday);
      const dueDate = paydayForWeek(monday);
      const { year, week } = isoWeek(monday);
      for (const u of payableUsers(db, monday)) {
        const w = weekPayFor(db, u, monday, today);
        if (!w || w.pay.gross <= 0) continue;
        const reference = `PAY-${year}${String(week).padStart(2, '0')}-${u.employeeId}`;
        created += run(db, INSERT_RUN, [
          u.id, monday, sunday, w.daysWorked, w.sales, w.teamSales,
          w.pay.basePay, w.pay.commission, w.pay.bonus, w.pay.overrides, w.pay.deductions, w.pay.gross,
          dueDate, reference,
        ]).changes;
      }
    }
  });
  return created;
}

/** Request-path guard: materialise only when the last completed week has no runs yet (one cheap query otherwise). */
export function ensurePayrollMaterialised(db: Db, today = todayISO()): number {
  const latest = get<{ w: string | null }>(db, `SELECT MAX(week_start) AS w FROM payroll_runs`)!.w;
  const lastCompleted = addDays(mondayOf(today), -7);
  if (latest !== null && latest >= lastCompleted) return 0;
  return materialisePayrollRuns(db, today);
}
