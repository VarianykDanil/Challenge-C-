/**
 * Pay rules shared by the dashboard, /finance/me, the finance summary and payroll materialisation — built on the
 * shared payroll maths and the same week rules the seed uses. Release 1.3 (P1 pay-rule): weeks starting on or after
 * PAY_RULE_FROM are paid by the base-or-commission rule (lib/payWeek.ts → shared calculateWeekPay); earlier weeks keep
 * the 1.2 pay plan maths. Both read the same gauges, statement confirmations, bonuses and adjustments.
 */
import { nextPayday, type PayrollBreakdown } from '@lm/shared';
import { all, type Db } from '../db/connection.ts';
import { listPayroll } from '../db/queries.ts';
import { eachMonday, mondayOf, sundayOf, todayISO } from './dates.ts';
import { computeWeek, payCalcContext, type ComputedWeek, type PayCalcContext, type PayUser } from './payWeek.ts';

export { RECRUITER_HIRES_SQL, type PayUser } from './payWeek.ts';

export interface WeekPay {
  daysWorked: number;
  /** gauge sales (subs logged) — or, for recruiters, the hires (candidates they own moved to `hired`) closed in the week */
  sales: number;
  teamSales: number;
  /** Gross after the stored deductions only when `deductions` was passed (as syncPayrollRun does). */
  pay: PayrollBreakdown;
  /** Release 1.3 (P1): the rule the week is paid by, and its full calculation (lines, per campaign, paid as). */
  rule: ComputedWeek['rule'];
  week: ComputedWeek;
}

/**
 * People who can earn in the Mon–Sun week starting `monday`: started by that Sunday and either still active, or with
 * gauges recorded that week (so a leaver's final week is still paid), or with a correction or bonus landing on that
 * week (1.3: money owed after a statement still reaches a leaver), or whose leaving date falls in or after that week
 * (MON-8: an office leaver's last days are paid). Optionally limited to one team. Release 1.3: never a client portal
 * account (role 'client').
 */
export function payableUsers(db: Db, monday: string, teamId: number | null = null): (PayUser & { employeeId: string })[] {
  const sunday = sundayOf(monday);
  return all<PayUser & { employeeId: string }>(
    db,
    `SELECT u.id, u.employee_id AS employeeId, u.team_id AS teamId, u.pay_plan_id AS payPlanId, u.role, u.start_date AS startDate
     FROM users u
     WHERE u.start_date <= ? AND u.role <> 'client'
       AND (u.status = 'active'
            OR EXISTS (SELECT 1 FROM gauge_entries g WHERE g.user_id = u.id AND g.date BETWEEN ? AND ?)
            OR EXISTS (SELECT 1 FROM pay_adjustments a WHERE a.user_id = u.id AND a.target_week_start = ?)
            OR (u.leaving_date IS NOT NULL AND u.leaving_date >= ?))
       ${teamId ? 'AND u.team_id = ?' : ''}
     ORDER BY u.id`,
    teamId ? [sunday, monday, sunday, monday, monday, teamId] : [sunday, monday, sunday, monday, monday],
  );
}

export interface WeekPayOptions {
  /** Settings and plans cached across many weeks. */
  ctx?: PayCalcContext;
  /** The run's stored deductions (syncPayrollRun): taken off `pay.gross`. */
  deductions?: number;
}

/**
 * Pay for one person for the Mon–Sun week starting `monday`, by the rules the seed uses:
 *  - daysWorked = distinct gauge dates, sales = sum of gauge sales;
 *  - recruiters are office based: Mon–Fri, clamped to their start date and (for the week in progress) to today, and
 *    their `sales` figure is the number of hires they closed;
 *  - from PAY_RULE_FROM (1.3): the day rate × days or the commission at the campaign rates, whichever is higher, plus
 *    Matt's bonuses and the corrections landing on the week; a salaried plan (no day rate, no commission) is not paid;
 *  - before it (1.2): the plan — base, commission, the bonus at its threshold (a recruiter's counts hires), leaders'
 *    overrides on their team's sales excluding their own, no-team seniors' overrides on other reps' sales at the events
 *    they attended.
 * Returns null when there is nothing to pay.
 */
export function weekPayFor(db: Db, user: PayUser, monday: string, today = todayISO(), opts: WeekPayOptions = {}): WeekPay | null {
  const w = computeWeek(db, user, monday, today, { ctx: opts.ctx, deductions: opts.deductions });
  if (!w || !w.hasWork) return null;
  return { daysWorked: w.daysWorked, sales: w.sales, teamSales: w.teamSales, pay: w.pay, rule: w.rule, week: w };
}

/** Projected pay for the Mon–Sun week starting `monday`, from the gauges recorded so far (null when nothing to pay). */
export function weekPayEstimate(db: Db, user: PayUser, monday: string, today = todayISO(), ctx?: PayCalcContext): PayrollBreakdown | null {
  return weekPayFor(db, user, monday, today, { ctx })?.pay ?? null;
}

/** Live estimate of the company's (or one team's) wage bill for a week that has no payroll runs yet. */
export function estimateWeekPayroll(db: Db, monday: string, teamId: number | null = null, today = todayISO()): number {
  const ctx = payCalcContext(db);
  let total = 0;
  for (const u of payableUsers(db, monday, teamId)) total += weekPayEstimate(db, u, monday, today, ctx)?.gross ?? 0;
  return Math.round(total * 100) / 100;
}

/**
 * Gross of the runs whose pay week *starts* inside [from, to] plus a live estimate for weeks in that span with no
 * run yet (the week in progress). A pay week that straddles the start of the range (its Monday is before `from`)
 * belongs to the previous period, so a month or quarter never counts the previous period's last week and adjacent
 * periods never report the same run twice.
 */
export function earningsForRange(db: Db, user: PayUser, from: string, to: string): number {
  const runs = listPayroll(db, 'WHERE p.user_id = ? AND p.week_start >= ? AND p.week_start <= ?', [user.id, from, to]);
  let total = runs.reduce((acc, r) => acc + r.gross, 0);
  const covered = new Set(runs.map((r) => r.weekStart));
  const ctx = payCalcContext(db);
  for (const monday of eachMonday(from, to)) {
    if (monday < from || covered.has(monday)) continue;
    total += weekPayEstimate(db, user, monday, todayISO(), ctx)?.gross ?? 0;
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
