/**
 * Pay, payroll status and margins.
 *
 * Pay week = Monday–Sunday. Weekly gross = daily base × days worked + commission × sales
 * + bonus (when weekly sales reach the plan's threshold) + override × team sales − deductions.
 * Pay is due on the Friday after the week ends (Sunday + 5 days).
 */
import type { PayPlan, PayrollStatus } from '../types.ts';
import { PAYDAY_DAYS_AFTER_WEEK_END } from '../constants.ts';
import { addDays, dateOnly, daysBetween, endOfWeekISO, startOfWeekISO } from './dates.ts';

export interface PayrollInput {
  daysWorked: number;
  sales: number;
  /** Sales made by the leader's team excluding their own. */
  teamSales: number;
  deductions?: number;
}

export interface PayrollBreakdown {
  basePay: number;
  commission: number;
  bonus: number;
  overrides: number;
  deductions: number;
  gross: number;
}

/**
 * Round to 2 decimal places (pence). Shifts the decimal point in string form first so that values
 * such as 1.005 or 10.555 round the way a human expects (1.01, 10.56) instead of falling foul of
 * binary floating point; halves round up like `Math.round`.
 */
export function round2(n: number): number {
  if (!Number.isFinite(n)) return n;
  const s = String(n);
  const shifted = s.includes('e') ? n * 100 : Number(`${s}e2`);
  return Math.round(shifted) / 100 + 0;
}

/** Weekly pay for one person under a pay plan. */
export function calculatePayroll(plan: PayPlan, input: PayrollInput): PayrollBreakdown {
  const daysWorked = Math.max(0, input.daysWorked);
  const sales = Math.max(0, input.sales);
  const teamSales = Math.max(0, input.teamSales);
  const basePay = round2(plan.basePerDay * daysWorked);
  const commission = round2(plan.commissionPerSale * sales);
  const bonus = plan.bonusThreshold > 0 && sales >= plan.bonusThreshold ? round2(plan.bonusAmount) : 0;
  const overrides = round2(plan.overridePerTeamSale * teamSales);
  const deductions = round2(input.deductions ?? 0);
  const gross = round2(basePay + commission + bonus + overrides - deductions);
  return { basePay, commission, bonus, overrides, deductions, gross };
}

/** Projection of this week's pay — the same maths as `calculatePayroll`, named for intent. */
export function estimateWeekPay(plan: PayPlan, input: PayrollInput): PayrollBreakdown {
  return calculatePayroll(plan, input);
}

/** True when a payment landed on or before its due date; null when unpaid. */
export function isPaidOnTime(dueDate: string, paidDate: string | null): boolean | null {
  if (!paidDate) return null;
  return dateOnly(paidDate) <= dateOnly(dueDate);
}

/**
 * Derive a payroll status from its dates:
 *  - paid on/before the due date → `paid`
 *  - paid after the due date, or unpaid and past due → `late`
 *  - unpaid and not yet due → `pending`
 * `failed` is never derived — it is set explicitly by finance when a transfer bounces.
 */
export function payrollStatusFor(dueDate: string, paidDate: string | null, today: string): PayrollStatus {
  if (paidDate) return isPaidOnTime(dueDate, paidDate) ? 'paid' : 'late';
  return dateOnly(today) > dateOnly(dueDate) ? 'late' : 'pending';
}

/**
 * Whole days a payment is (or was) late; 0 when on time or when nothing can be measured.
 * For an unpaid run pass `today` to measure how overdue it is.
 */
export function daysLate(dueDate: string, paidDate: string | null, today?: string): number {
  const ref = paidDate ?? today;
  if (!ref) return 0;
  return Math.max(0, daysBetween(dateOnly(dueDate), dateOnly(ref)));
}

export interface PaymentDates {
  dueDate: string;
  paidDate: string | null;
}

/** Share (0..1) of *paid* runs that were paid on or before the due date; 0 when nothing has been paid. */
export function onTimeRate(runs: ReadonlyArray<PaymentDates>): number {
  let paid = 0;
  let onTime = 0;
  for (const r of runs) {
    const ok = isPaidOnTime(r.dueDate, r.paidDate);
    if (ok === null) continue;
    paid++;
    if (ok) onTime++;
  }
  return paid > 0 ? onTime / paid : 0;
}

/** Average days late across the runs that were paid late; 0 when none were. */
export function avgDaysLate(runs: ReadonlyArray<PaymentDates>): number {
  let count = 0;
  let total = 0;
  for (const r of runs) {
    if (isPaidOnTime(r.dueDate, r.paidDate) === false) {
      count++;
      total += daysLate(r.dueDate, r.paidDate);
    }
  }
  return count > 0 ? total / count : 0;
}

/** Payday for the pay week containing `weekStart`: the Friday after that Monday–Sunday week ends. */
export function paydayForWeek(weekStart: string): string {
  return addDays(endOfWeekISO(startOfWeekISO(weekStart)), PAYDAY_DAYS_AFTER_WEEK_END);
}

/**
 * The next payday from `today`'s point of view: the current Monday–Sunday week is paid on the
 * Friday after it ends. On Wed 14 Oct 2026 the week ends Sun 18 Oct, so payday is Fri 23 Oct.
 */
export function nextPayday(today: string): string {
  return paydayForWeek(today);
}

/** Gross margin as a fraction of revenue ((revenue − cost) / revenue); 0 when revenue is 0. May be negative. */
export function margin(revenue: number, cost: number): number {
  if (!(revenue > 0)) return 0;
  return (revenue - cost) / revenue;
}

/** Gross profit in pounds (revenue − cost), rounded to pence. */
export function marginAmount(revenue: number, cost: number): number {
  return round2(revenue - cost);
}

/** Sum money values without float drift (rounds the total to pence). */
export function sumMoney(values: ReadonlyArray<number>): number {
  let total = 0;
  for (const v of values) total += Number.isFinite(v) ? v : 0;
  return round2(total);
}
