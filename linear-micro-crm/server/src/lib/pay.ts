/**
 * Pay rules shared by the dashboard, /finance/me, the finance summary and payroll materialisation — built on the
 * shared payroll maths (`estimateWeekPay`) and the same week rules the seed uses.
 */
import { estimateWeekPay, nextPayday, type PayrollBreakdown, type Role } from '@lm/shared';
import { all, get, type Db } from '../db/connection.ts';
import { getPayPlan, listPayroll } from '../db/queries.ts';
import { addDays, diffDays, eachMonday, mondayOf, sundayOf, todayISO } from './dates.ts';

export interface PayUser {
  id: number;
  teamId: number | null;
  payPlanId: number;
  role: Role;
  startDate: string;
}

export interface WeekPay {
  daysWorked: number;
  /** gauge sales — or, for recruiters, the hires (candidates they own moved to `hired`) closed in the week */
  sales: number;
  teamSales: number;
  pay: PayrollBreakdown;
}

/** Hires closed in a Mon–Sun week by the recruiter who owns the candidate: params (ownerId, monday, sunday). */
export const RECRUITER_HIRES_SQL = `
  SELECT COUNT(DISTINCT s.candidate_id) AS n FROM stage_changes s JOIN candidates c ON c.id = s.candidate_id
  WHERE s.to_stage = 'hired' AND c.owner_id = ? AND substr(s.changed_at, 1, 10) BETWEEN ? AND ?`;

/**
 * People who can earn in the Mon–Sun week starting `monday`: started by that Sunday and either still active or with
 * gauges recorded that week (so a leaver's final week is still paid). Optionally limited to one team.
 */
export function payableUsers(db: Db, monday: string, teamId: number | null = null): (PayUser & { employeeId: string })[] {
  const sunday = sundayOf(monday);
  return all<PayUser & { employeeId: string }>(
    db,
    `SELECT u.id, u.employee_id AS employeeId, u.team_id AS teamId, u.pay_plan_id AS payPlanId, u.role, u.start_date AS startDate
     FROM users u
     WHERE u.start_date <= ?
       AND (u.status = 'active' OR EXISTS (SELECT 1 FROM gauge_entries g WHERE g.user_id = u.id AND g.date BETWEEN ? AND ?))
       ${teamId ? 'AND u.team_id = ?' : ''}
     ORDER BY u.id`,
    teamId ? [sunday, monday, sunday, teamId] : [sunday, monday, sunday],
  );
}

/**
 * Pay for one person for the Mon–Sun week starting `monday`, by the rules the seed uses:
 *  - daysWorked = distinct gauge dates, sales = sum of gauge sales;
 *  - recruiters are office based: Mon–Fri base, clamped to their start date and (for the week in progress) to today,
 *    and their `sales` figure is the number of hires they closed (the recruiter plan pays a bonus on hires);
 *  - leaders' overrides come from their team's sales excluding their own;
 *  - the owner / assistant owner (no team) earn overrides on other reps' sales at the events they attended.
 * Returns null when there is nothing to pay.
 */
export function weekPayFor(db: Db, user: PayUser, monday: string, today = todayISO()): WeekPay | null {
  const plan = getPayPlan(db, user.payPlanId);
  if (!plan) return null;
  const sunday = sundayOf(monday);
  const own = get<{ days: number; sales: number }>(
    db,
    `SELECT COUNT(DISTINCT date) AS days, COALESCE(SUM(sales), 0) AS sales FROM gauge_entries WHERE user_id = ? AND date BETWEEN ? AND ?`,
    [user.id, monday, sunday],
  )!;
  let daysWorked = Number(own.days);
  let sales = Number(own.sales);
  if (user.role === 'recruiter') {
    const first = user.startDate > monday ? user.startDate : monday;
    const friday = addDays(monday, 4);
    const last = friday < today ? friday : today;
    daysWorked = Math.max(0, Math.min(5, diffDays(first, last) + 1));
    // a recruiter's "sales" are the hires they closed that week: the recruiter plan's bonus threshold counts hires
    sales = Number(get<{ n: number }>(db, RECRUITER_HIRES_SQL, [user.id, monday, sunday])!.n);
  }
  let teamSales = 0;
  if (plan.overridePerTeamSale > 0) {
    if (user.teamId !== null) {
      teamSales = Number(
        get<{ s: number }>(
          db,
          `SELECT COALESCE(SUM(g.sales), 0) AS s FROM gauge_entries g JOIN users u ON u.id = g.user_id WHERE u.team_id = ? AND g.user_id <> ? AND g.date BETWEEN ? AND ?`,
          [user.teamId, user.id, monday, sunday],
        )!.s,
      );
    } else {
      teamSales = Number(
        get<{ s: number }>(
          db,
          `SELECT COALESCE(SUM(o.sales), 0) AS s FROM gauge_entries o
           WHERE o.user_id <> ? AND o.event_id IN (SELECT event_id FROM gauge_entries WHERE user_id = ? AND date BETWEEN ? AND ?)`,
          [user.id, user.id, monday, sunday],
        )!.s,
      );
    }
  }
  if (daysWorked === 0 && sales === 0 && teamSales === 0) return null;
  return { daysWorked, sales, teamSales, pay: estimateWeekPay(plan, { daysWorked, sales, teamSales }) };
}

/** Projected pay for the Mon–Sun week starting `monday`, from the gauges recorded so far (null when nothing to pay). */
export function weekPayEstimate(db: Db, user: PayUser, monday: string, today = todayISO()): PayrollBreakdown | null {
  return weekPayFor(db, user, monday, today)?.pay ?? null;
}

/** Live estimate of the company's (or one team's) wage bill for a week that has no payroll runs yet. */
export function estimateWeekPayroll(db: Db, monday: string, teamId: number | null = null, today = todayISO()): number {
  let total = 0;
  for (const u of payableUsers(db, monday, teamId)) total += weekPayEstimate(db, u, monday, today)?.gross ?? 0;
  return Math.round(total * 100) / 100;
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
 * When the next money lands and how much: the earliest UNPAID run (`pending` or `failed`), even when it is overdue —
 * money owed never disappears from the tile and the stored status is never changed here — otherwise the current pay
 * week, paid on the Friday after it ends (shared `nextPayday` rule), with a live estimate.
 */
export function nextPay(db: Db, user: PayUser, today = todayISO()): { nextPayday: string | null; nextPayAmount: number | null } {
  const unpaid = listPayroll(db, `WHERE p.user_id = ? AND p.status IN ('pending', 'failed')`, [user.id], 'p.due_date ASC, p.week_start ASC')[0];
  if (unpaid) return { nextPayday: unpaid.dueDate, nextPayAmount: unpaid.gross };
  const estimate = weekPayEstimate(db, user, mondayOf(today), today);
  return { nextPayday: nextPayday(today), nextPayAmount: estimate ? estimate.gross : 0 };
}
