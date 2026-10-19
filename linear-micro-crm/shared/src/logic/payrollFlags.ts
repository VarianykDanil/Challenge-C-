/**
 * Advisory payroll checks before paying — OWNED BY p3-money-forecast-payroll-checks.
 * Flags are advisory: they never block paying. Pure and deterministic: the same run gives the same flags, in the
 * fixed order of the rules below.
 *
 *  first_payslip       info     no earlier runs for this person
 *  high_gross          warning  gross > 2.5 × median of up to 8 earlier runs (needs ≥ 3 of them)
 *  bonus_single_day    warning  bonus paid, ≥ 10 trailing worked days, best day ≥ 3 × max(1, usual daily sales) and the
 *                               other days alone would not reach the threshold (not for recruiters)
 *  sales_without_days  warning  sales > 0 with 0 days worked (not for recruiters: their "sales" are hires)
 *  high_deductions     warning  deductions > 50% of (gross + deductions)
 *  stale_amount        warning  today's gauges give a different amount than the stored gross (beyond £0.01)
 *  override_no_days    info     overrides > 0 with 0 days worked
 */
import type { PayrollFlag, PayrollRun } from '../types.ts';
import { round2 } from './finance.ts';
import { quantile } from './stats.ts';

export const PAYROLL_FLAG_RULES = {
  highGrossMultiple: 2.5,
  minPriorRuns: 3,
  priorWindow: 8,
  bonusDayMultiple: 3,
  minDailyHistory: 10,
  deductionShare: 0.5,
  tolerance: 0.01,
} as const;

export interface PayrollFlagInput {
  run: Pick<PayrollRun, 'gross' | 'sales' | 'daysWorked' | 'bonus' | 'deductions' | 'overrides'>;
  /** Gross of the person's earlier runs, newest first (the rules use up to PAYROLL_FLAG_RULES.priorWindow). */
  priorGross: ReadonlyArray<number>;
  /** Sales on each worked day before this run's week (trailing history for bonus_single_day). */
  trailingDailySales: ReadonlyArray<number>;
  /** Sales on each worked day inside this run's week. */
  weekDailySales: ReadonlyArray<number>;
  /** The plan's weekly bonus threshold (0 = no bonus). */
  bonusThreshold: number;
  /** weekPayFor gross − deductions recomputed from today's gauges; null when it cannot be recomputed. */
  recomputedGross: number | null;
  /** Recruiter runs skip the sales-based rules. */
  recruiter: boolean;
}

const gbp0 = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP', maximumFractionDigits: 0 });
const gbp2 = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP', minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** "£780" for whole pounds, "£412.50" otherwise; a minus sign for negatives ("−£20"). */
export function flagMoney(n: number): string {
  const v = round2(Number.isFinite(n) ? n : 0);
  const abs = Math.abs(v);
  const s = Number.isInteger(abs) ? gbp0.format(abs) : gbp2.format(abs);
  return v < 0 ? `−${s}` : s;
}

/** 2.6× style multiple (one decimal place, trailing .0 dropped). */
function times(n: number): string {
  const r = Math.round(n * 10) / 10;
  return `${Number.isInteger(r) ? r.toFixed(0) : r.toFixed(1)}×`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function payrollFlags(input: PayrollFlagInput): PayrollFlag[] {
  const R = PAYROLL_FLAG_RULES;
  const { run } = input;
  const flags: PayrollFlag[] = [];
  const prior = input.priorGross.filter((g) => Number.isFinite(g)).slice(0, R.priorWindow);

  if (input.priorGross.length === 0) {
    flags.push({ code: 'first_payslip', severity: 'info', text: 'First payslip for this person — check their bank details and pay plan before paying' });
  }

  if (prior.length >= R.minPriorRuns) {
    const usual = round2(quantile(prior, 0.5));
    if (usual > 0 && run.gross > R.highGrossMultiple * usual) {
      flags.push({
        code: 'high_gross',
        severity: 'warning',
        text: `${flagMoney(run.gross)} is ${times(run.gross / usual)} the usual ${flagMoney(usual)} (median of the last ${plural(prior.length, 'run')})`,
      });
    }
  }

  if (!input.recruiter) {
    const trailing = input.trailingDailySales.filter((x) => Number.isFinite(x) && x >= 0);
    const week = input.weekDailySales.filter((x) => Number.isFinite(x) && x >= 0);
    if (run.bonus > 0 && input.bonusThreshold > 0 && trailing.length >= R.minDailyHistory && week.length > 0) {
      const usualDay = quantile(trailing, 0.5);
      const bestDay = Math.max(...week);
      if (bestDay >= R.bonusDayMultiple * Math.max(1, usualDay) && run.sales - bestDay < input.bonusThreshold) {
        flags.push({
          code: 'bonus_single_day',
          severity: 'warning',
          text: `The ${flagMoney(run.bonus)} bonus rests on one day: ${plural(bestDay, 'sale')} against a usual ${plural(Math.round(usualDay * 10) / 10, 'sale')} a day — worth checking that day's gauges`,
        });
      }
    }
    if (run.sales > 0 && run.daysWorked === 0) {
      flags.push({ code: 'sales_without_days', severity: 'warning', text: `${plural(run.sales, 'sale')} with no days worked — a gauge row may be missing its date` });
    }
  }

  const beforeDeductions = run.gross + run.deductions;
  if (run.deductions > 0 && beforeDeductions > 0 && run.deductions > R.deductionShare * beforeDeductions) {
    flags.push({
      code: 'high_deductions',
      severity: 'warning',
      text: `Deductions of ${flagMoney(run.deductions)} take ${Math.round((run.deductions / beforeDeductions) * 100)}% of the ${flagMoney(beforeDeductions)} earned`,
    });
  } else if (run.deductions > 0 && beforeDeductions <= 0) {
    flags.push({ code: 'high_deductions', severity: 'warning', text: `Deductions of ${flagMoney(run.deductions)} take the whole week's pay` });
  }

  if (input.recomputedGross !== null && Number.isFinite(input.recomputedGross) && Math.abs(input.recomputedGross - run.gross) > R.tolerance) {
    flags.push({
      code: 'stale_amount',
      severity: 'warning',
      text: `The gauges changed since this run was calculated: they now give ${flagMoney(input.recomputedGross)}, not ${flagMoney(run.gross)}`,
    });
  }

  if (run.overrides > 0 && run.daysWorked === 0) {
    flags.push({ code: 'override_no_days', severity: 'info', text: `${flagMoney(run.overrides)} of team overrides with no days worked this week` });
  }

  return flags;
}
