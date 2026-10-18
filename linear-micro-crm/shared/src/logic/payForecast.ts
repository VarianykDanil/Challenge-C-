/**
 * Weekly pay forecast (low / likely / high estimate) — OWNED BY p3-money-forecast-payroll-checks.
 * Stub laid down by p1-foundation-contracts: the exported names and signatures are final; p3 replaces the bodies.
 * An estimate only: nothing here is ever written to payroll_runs.
 */
import type { FunnelRatios, PayForecast, PayPlan } from '../types.ts';
import { estimateWeekPay, paydayForWeek } from './finance.ts';

export const PAY_FORECAST_RULES = {
  /** Fewer worked days of history than this → λ = p10 = p90 = 0 and basis.weeks = 0 ("not enough history for a range"). */
  minHistoryDays: 5,
  lowQuantile: 0.1,
  highQuantile: 0.9,
  /** bonusProbability thresholds for 'likely' and 'possible'. */
  likely: 0.6,
  possible: 0.25,
} as const;

export interface PayForecastInput {
  plan: PayPlan;
  /** Monday of the pay week. */
  weekStart: string;
  /** Logged so far this week (`teamSales` = the team's sales excluding the person, for leaders' overrides). */
  soFar: { days: number; sales: number; teamSales: number };
  /** Team event days still to come this week. */
  remainingDays: number;
  /** Sales on each worked day of the trailing window (8 completed weeks, live events excluded). */
  dailySales: ReadonlyArray<number>;
  /** The person's funnel ratios over the same window (for stopsForBonus). */
  ratios: FunnelRatios;
  /** Stops over the same window; stopsForBonus is null below MIN_STOPS_FOR_INSIGHTS. */
  trailingStops: number;
  /** Team sales per team event day excluding the person (only used when the plan pays overrides). */
  teamSalesPerDay?: number;
}

export function payForecastFrom(input: PayForecastInput): PayForecast {
  const { plan, weekStart, soFar } = input;
  // p1 stub: no projection yet — the whole range is what has been logged so far.
  const gross = estimateWeekPay(plan, { daysWorked: soFar.days, sales: soFar.sales, teamSales: soFar.teamSales }).gross;
  return {
    weekStart,
    payday: paydayForWeek(weekStart),
    estimate: true,
    soFar: { days: soFar.days, sales: soFar.sales, gross },
    remainingDays: input.remainingDays,
    low: gross,
    likely: gross,
    high: gross,
    bonusThreshold: plan.bonusThreshold,
    bonusAmount: plan.bonusAmount,
    bonusGap: 0,
    bonusProbability: 0,
    bonusLikelihood: 'none',
    stopsForBonus: null,
    basis: { weeks: 0, workedDays: 0, salesPerDay: 0 },
  };
}
