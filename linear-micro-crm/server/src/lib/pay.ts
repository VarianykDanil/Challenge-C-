/** Earnings helpers shared by the dashboard and /finance/me — built on the shared payroll rules. */
import { estimateWeekPay, nextPayday, type PayrollBreakdown } from '@lm/shared';
import { get, type Db } from '../db/connection.ts';
import { getPayPlan, listPayroll } from '../db/queries.ts';
import { eachMonday, mondayOf, sundayOf, todayISO } from './dates.ts';

export interface PayUser {
  id: number;
  teamId: number | null;
  payPlanId: number;
}

/** Projected pay for the Mon–Sun week starting `monday`, from the gauges recorded so far (null when nothing to pay). */
export function weekPayEstimate(db: Db, user: PayUser, monday: string): PayrollBreakdown | null {
  const plan = getPayPlan(db, user.payPlanId);
  if (!plan) return null;
  const sunday = sundayOf(monday);
  const own = get<{ days: number; sales: number }>(
    db,
    `SELECT COUNT(DISTINCT date) AS days, COALESCE(SUM(sales), 0) AS sales FROM gauge_entries WHERE user_id = ? AND date BETWEEN ? AND ?`,
    [user.id, monday, sunday],
  )!;
  let teamSales = 0;
  if (plan.overridePerTeamSale > 0 && user.teamId !== null) {
    teamSales = Number(
      get<{ s: number }>(
        db,
        `SELECT COALESCE(SUM(g.sales), 0) AS s FROM gauge_entries g JOIN users u ON u.id = g.user_id WHERE u.team_id = ? AND g.user_id <> ? AND g.date BETWEEN ? AND ?`,
        [user.teamId, user.id, monday, sunday],
      )!.s,
    );
  }
  if (Number(own.days) === 0 && teamSales === 0) return null;
  return estimateWeekPay(plan, { daysWorked: Number(own.days), sales: Number(own.sales), teamSales });
}

/** Settled/pending payroll for weeks starting in the range plus a live estimate for weeks with no run yet. */
export function earningsForRange(db: Db, user: PayUser, from: string, to: string): number {
  const runs = listPayroll(db, 'WHERE p.user_id = ? AND p.week_start >= ? AND p.week_start <= ?', [user.id, mondayOf(from), to]);
  let total = runs.reduce((acc, r) => acc + r.gross, 0);
  const covered = new Set(runs.map((r) => r.weekStart));
  for (const monday of eachMonday(from, to)) {
    if (covered.has(monday)) continue;
    total += weekPayEstimate(db, user, monday)?.gross ?? 0;
  }
  return Math.round(total * 100) / 100;
}

/**
 * When the next money lands and how much: the earliest pending run that is not yet past due, else the
 * current pay week paid on the Friday after it ends (shared `nextPayday` rule) with a live estimate.
 */
export function nextPay(db: Db, user: PayUser, today = todayISO()): { nextPayday: string | null; nextPayAmount: number | null } {
  const pending = listPayroll(db, `WHERE p.user_id = ? AND p.status = 'pending' AND p.due_date >= ?`, [user.id, today], 'p.due_date ASC')[0];
  if (pending) return { nextPayday: pending.dueDate, nextPayAmount: pending.gross };
  const estimate = weekPayEstimate(db, user, mondayOf(today));
  return { nextPayday: nextPayday(today), nextPayAmount: estimate ? estimate.gross : 0 };
}
