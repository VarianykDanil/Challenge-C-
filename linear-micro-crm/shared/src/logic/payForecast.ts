/**
 * Weekly pay forecast (low / likely / high estimate) — OWNED BY p3-money-forecast-payroll-checks.
 * An estimate only: nothing here is ever written to payroll_runs, and Friday's payslip stays the official figure.
 *
 * Model: each remaining team event day is a draw from the person's own worked days in the trailing window.
 *   λ (likely sales per day) = mean(dailySales); p10 / p90 = quantile(dailySales, 0.1 / 0.9)
 *   sales   likely = soFar + round(d·λ) · low = soFar + floor(d·p10) · high = soFar + ceil(d·p90)   (d = remainingDays)
 *   days    projectedDays = min(7, soFar.days + d)
 *   team    leaders on an override plan: soFar.teamSales + round(d · teamSalesPerDay)
 *   money   estimateWeekPay(plan, { daysWorked: projectedDays, sales, teamSales }).gross, then low ≤ likely ≤ high
 *   bonus   gap = max(0, threshold − soFar.sales); P(reach) = 1 when the gap is 0, else P(Poisson(d·λ) ≥ gap)
 * Fewer than PAY_FORECAST_RULES.minHistoryDays worked days of history → λ = p10 = p90 = 0 and basis.weeks = 0, so the
 * range collapses to what is logged so far plus base pay for the days left ("not enough history for a range").
 */
import type { BonusLikelihood, FunnelRatios, PayForecast, PayPlan } from '../types.ts';
import { MIN_STOPS_FOR_INSIGHTS } from '../constants.ts';
import { estimateWeekPay, paydayForWeek } from './finance.ts';
import { stopsNeededFor } from './gauges.ts';
import { mean, poissonTailAtLeast, quantile } from './stats.ts';

export const PAY_FORECAST_RULES = {
  /** Fewer worked days of history than this → λ = p10 = p90 = 0 and basis.weeks = 0 ("not enough history for a range"). */
  minHistoryDays: 5,
  lowQuantile: 0.1,
  highQuantile: 0.9,
  /** bonusProbability thresholds for 'likely' and 'possible'. */
  likely: 0.6,
  possible: 0.25,
  /** Completed Mon–Sun weeks of history the server reads (the default for basis.weeks). */
  windowWeeks: 8,
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
  /**
   * Weeks the history covers, for basis.weeks and the "over the last 8 weeks" wording: from the first worked week in
   * the window to last week (a new starter has fewer). Default PAY_FORECAST_RULES.windowWeeks.
   */
  historyWeeks?: number;
}

const EPS = 1e-9;
const finiteOr0 = (n: number | undefined): number => (typeof n === 'number' && Number.isFinite(n) ? n : 0);
const whole = (n: number | undefined): number => Math.max(0, Math.round(finiteOr0(n)));

/** The likelihood label for a probability of reaching the bonus (gap > 0). */
export function bonusLikelihoodFor(probability: number): Exclude<BonusLikelihood, 'reached' | 'none'> {
  if (probability >= PAY_FORECAST_RULES.likely) return 'likely';
  if (probability >= PAY_FORECAST_RULES.possible) return 'possible';
  return 'unlikely';
}

export function payForecastFrom(input: PayForecastInput): PayForecast {
  const { plan, weekStart } = input;
  const soFar = { days: whole(input.soFar.days), sales: whole(input.soFar.sales), teamSales: whole(input.soFar.teamSales) };
  const remainingDays = whole(input.remainingDays);
  const history = input.dailySales.filter((x) => Number.isFinite(x) && x >= 0);
  const enough = history.length >= PAY_FORECAST_RULES.minHistoryDays;
  const lambda = enough ? mean(history) : 0;
  const p10 = enough ? quantile(history, PAY_FORECAST_RULES.lowQuantile) : 0;
  const p90 = enough ? quantile(history, PAY_FORECAST_RULES.highQuantile) : 0;

  const projectedDays = Math.min(7, soFar.days + remainingDays);
  const likelySales = soFar.sales + Math.round(remainingDays * lambda);
  const lowSales = Math.min(likelySales, soFar.sales + Math.floor(remainingDays * p10 + EPS));
  const highSales = Math.max(likelySales, soFar.sales + Math.ceil(remainingDays * p90 - EPS));
  const teamSales = plan.overridePerTeamSale > 0 ? soFar.teamSales + Math.round(remainingDays * Math.max(0, finiteOr0(input.teamSalesPerDay))) : soFar.teamSales;
  const grossFor = (sales: number) => estimateWeekPay(plan, { daysWorked: projectedDays, sales, teamSales }).gross;
  const likely = grossFor(likelySales);
  const low = Math.min(grossFor(lowSales), likely);
  const high = Math.max(grossFor(highSales), likely);

  // The gap counts from any threshold (gap = 0 without one). A plan "has a bonus" only when it pays a positive amount
  // at a threshold; otherwise probability is 0, the likelihood is 'none' and there is no stops figure.
  const hasBonus = plan.bonusThreshold > 0 && plan.bonusAmount > 0;
  const bonusGap = plan.bonusThreshold > 0 ? Math.max(0, plan.bonusThreshold - soFar.sales) : 0;
  let bonusProbability = 0;
  let bonusLikelihood: BonusLikelihood = 'none';
  if (hasBonus) {
    bonusProbability = bonusGap === 0 ? 1 : poissonTailAtLeast(bonusGap, remainingDays * lambda);
    bonusLikelihood = bonusGap === 0 ? 'reached' : bonusLikelihoodFor(bonusProbability);
  }
  let stopsForBonus: number | null = null;
  if (hasBonus && bonusGap > 0 && input.trailingStops >= MIN_STOPS_FOR_INSIGHTS) {
    const stops = stopsNeededFor(bonusGap, input.ratios);
    stopsForBonus = Number.isFinite(stops) && stops > 0 ? stops : null;
  }

  return {
    weekStart,
    payday: paydayForWeek(weekStart),
    estimate: true,
    soFar: { days: soFar.days, sales: soFar.sales, gross: estimateWeekPay(plan, { daysWorked: soFar.days, sales: soFar.sales, teamSales: soFar.teamSales }).gross },
    remainingDays,
    low,
    likely,
    high,
    bonusThreshold: plan.bonusThreshold,
    bonusAmount: plan.bonusAmount,
    bonusGap,
    bonusProbability,
    bonusLikelihood,
    stopsForBonus,
    basis: {
      weeks: enough ? Math.max(1, whole(input.historyWeeks ?? PAY_FORECAST_RULES.windowWeeks)) : 0,
      workedDays: history.length,
      salesPerDay: lambda,
    },
    sales: { low: lowSales, likely: likelySales, high: highSales },
  };
}
