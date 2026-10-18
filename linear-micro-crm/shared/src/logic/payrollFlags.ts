/**
 * Advisory payroll checks before paying — OWNED BY p3-money-forecast-payroll-checks.
 * Stub laid down by p1-foundation-contracts: the exported names and signatures are final; p3 replaces the bodies.
 * Flags are advisory: they never block paying.
 */
import type { PayrollFlag, PayrollRun } from '../types.ts';

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

export function payrollFlags(input: PayrollFlagInput): PayrollFlag[] {
  void input;
  return [];
}
