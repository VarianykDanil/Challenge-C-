/**
 * Advisory payroll checks — OWNED BY p3-money-forecast-payroll-checks.
 *
 * payrollFlagsFor: admin only (any other `me` → empty Map); pending / failed runs only; at most MAX_FLAGGED_RUNS runs
 * per call (the newest weeks first); 3 grouped queries (prior gross per run, daily sales per user, users + plans) plus
 * weekPayFor per run for the stale-amount check. Returns runId → flags for every run it checked (an empty array when
 * nothing is unusual), so GET /finance/payroll and /finance/payroll/:id attach `flags` to exactly those runs.
 * Read-only: it never writes a payroll run or a gauge row.
 */
import { payrollFlags, PAYROLL_FLAG_RULES, round2, type PayrollFlag, type PayrollRunWithUser, type Role, type UserWithTeam } from '@lm/shared';
import { all, placeholders, type Db, type Param } from '../../db/connection.ts';
import { addDays } from '../dates.ts';
import { weekPayFor, type PayUser } from '../pay.ts';
import { smartEnabled } from './enabled.ts';

export const MAX_FLAGGED_RUNS = 80;
/** Trailing history for bonus_single_day: the same 8 completed weeks the forecast reads. */
const TRAILING_DAYS = 7 * PAYROLL_FLAG_RULES.priorWindow;

interface PriorRow {
  runId: number;
  gross: number;
}

interface DayRow {
  userId: number;
  date: string;
  sales: number;
}

interface UserPlanRow {
  id: number;
  teamId: number | null;
  payPlanId: number;
  role: Role;
  startDate: string;
  bonusThreshold: number | null;
}

/**
 * The gauge dates each person's checks read: from 8 weeks before their earliest run in the batch (the trailing history
 * of bonus_single_day) to their latest run's Sunday. Per person, so one old failed transfer only widens its own scan.
 */
export function gaugeWindows(runs: ReadonlyArray<Pick<PayrollRunWithUser, 'userId' | 'weekStart' | 'weekEnd'>>): Map<number, { from: string; to: string }> {
  const windows = new Map<number, { from: string; to: string }>();
  for (const r of runs) {
    const from = addDays(r.weekStart, -TRAILING_DAYS);
    const w = windows.get(r.userId);
    if (!w) windows.set(r.userId, { from, to: r.weekEnd });
    else {
      if (from < w.from) w.from = from;
      if (r.weekEnd > w.to) w.to = r.weekEnd;
    }
  }
  return windows;
}

export function payrollFlagsFor(db: Db, runs: readonly PayrollRunWithUser[], me: UserWithTeam): Map<number, PayrollFlag[]> {
  const out = new Map<number, PayrollFlag[]>();
  if (!smartEnabled() || me.role !== 'admin') return out;
  const batch = runs
    .filter((r) => r.status === 'pending' || r.status === 'failed')
    .sort((a, b) => b.weekStart.localeCompare(a.weekStart) || a.id - b.id)
    .slice(0, MAX_FLAGGED_RUNS);
  if (!batch.length) return out;

  const userIds = [...new Set(batch.map((r) => r.userId))];

  // 1. Up to 8 earlier runs per run, newest first (any status), via one windowed join on (user_id, week_start).
  const values = batch.map(() => '(?, ?, ?)').join(', ');
  const valueParams: Param[] = batch.flatMap((r) => [r.id, r.userId, r.weekStart]);
  const prior = all<PriorRow>(
    db,
    `WITH batch(run_id, user_id, week_start) AS (VALUES ${values})
     SELECT runId, gross FROM (
       SELECT b.run_id AS runId, p.gross AS gross, p.week_start AS weekStart,
              ROW_NUMBER() OVER (PARTITION BY b.run_id ORDER BY p.week_start DESC) AS rn
       FROM batch b JOIN payroll_runs p ON p.user_id = b.user_id AND p.week_start < b.week_start
     ) WHERE rn <= ? ORDER BY runId, weekStart DESC`,
    [...valueParams, PAYROLL_FLAG_RULES.priorWindow],
  );
  const priorByRun = new Map<number, number[]>();
  for (const row of prior) {
    const list = priorByRun.get(Number(row.runId)) ?? [];
    list.push(Number(row.gross));
    priorByRun.set(Number(row.runId), list);
  }

  // 2. Sales per worked day per person, over each person's OWN window: from the trailing history of their earliest
  //    run to their latest run's Sunday. (One window for everybody would let a single old failed transfer stretch the
  //    scan to months of gauges for every person in the batch.)
  const windows = gaugeWindows(batch);
  const days = all<DayRow>(
    db,
    `WITH win(user_id, date_from, date_to) AS (VALUES ${[...windows.keys()].map(() => '(?, ?, ?)').join(', ')})
     SELECT g.user_id AS userId, g.date AS date, COALESCE(SUM(g.sales), 0) AS sales
     FROM win w JOIN gauge_entries g ON g.user_id = w.user_id AND g.date >= w.date_from AND g.date <= w.date_to
     GROUP BY g.user_id, g.date ORDER BY g.user_id, g.date`,
    [...windows].flatMap(([userId, w]) => [userId, w.from, w.to]),
  );
  const daysByUser = new Map<number, DayRow[]>();
  for (const d of days) {
    const list = daysByUser.get(Number(d.userId)) ?? [];
    list.push({ userId: Number(d.userId), date: d.date, sales: Number(d.sales) });
    daysByUser.set(Number(d.userId), list);
  }

  // 3. Who they are and their plan (for weekPayFor and the bonus threshold).
  const users = new Map(
    all<UserPlanRow>(
      db,
      `SELECT u.id, u.team_id AS teamId, u.pay_plan_id AS payPlanId, u.role, u.start_date AS startDate, pp.bonus_threshold AS bonusThreshold
       FROM users u LEFT JOIN pay_plans pp ON pp.id = u.pay_plan_id WHERE u.id IN (${placeholders(userIds.length)})`,
      userIds,
    ).map((u) => [Number(u.id), u]),
  );

  for (const r of batch) {
    const u = users.get(r.userId);
    const userDays = daysByUser.get(r.userId) ?? [];
    const trailingFrom = addDays(r.weekStart, -TRAILING_DAYS);
    const trailing = userDays.filter((d) => d.date >= trailingFrom && d.date < r.weekStart).map((d) => d.sales);
    const inWeek = userDays.filter((d) => d.date >= r.weekStart && d.date <= r.weekEnd).map((d) => d.sales);
    let recomputedGross: number | null = null;
    if (u && u.bonusThreshold !== null) {
      const payUser: PayUser = { id: u.id, teamId: u.teamId === null ? null : Number(u.teamId), payPlanId: Number(u.payPlanId), role: u.role, startDate: u.startDate };
      // The pay week has ended for every run (runs exist only for complete weeks), so pass its Sunday + 1 as "today".
      const w = weekPayFor(db, payUser, r.weekStart, addDays(r.weekEnd, 1));
      recomputedGross = round2((w?.pay.gross ?? 0) - r.deductions);
    }
    out.set(
      r.id,
      payrollFlags({
        run: r,
        priorGross: priorByRun.get(r.id) ?? [],
        trailingDailySales: trailing,
        weekDailySales: inWeek,
        bonusThreshold: Number(u?.bonusThreshold ?? 0),
        recomputedGross,
        recruiter: (u?.role ?? null) === 'recruiter' || r.position === 'recruiter',
      }),
    );
  }
  return out;
}
