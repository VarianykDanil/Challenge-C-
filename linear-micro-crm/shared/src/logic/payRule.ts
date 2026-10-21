/**
 * Release 1.3 — OWNED BY P1 pay-rule (laid down by r3-foundation). The 1.3 pay rule as pure functions (decision 2,
 * quoted in shared/src/types/pay.ts): base = day rate × days worked; commission = the week's paid subs × each
 * campaign's rate in effect on the sale's date; paid the base when commission < base, else the commission (a tie pays
 * commission); manual bonus lines, deductions and adjustments from earlier weeks on top. No automatic bonus, no
 * automatic overrides.
 *
 * P1 fills calculateWeekPay and payExplanation (stubs today) with hand-computed fixtures (2, 3, 4, 5, 7 days; tie;
 * zero days; rates changing mid-week; cancellations that change nothing). paidAsFor is STABLE.
 */
import type { PaidAs, PayAdjustment, PayLine, WeekCampaignPay } from '../types/pay.ts';

/** Decision 2: commission ≥ base → commission; below → base. */
export function paidAsFor(baseAmount: number, commissionAmount: number): PaidAs {
  return commissionAmount >= baseAmount ? 'commission' : 'base';
}

/** One campaign's subs on one day, at the rep rate in effect that day. */
export interface WeekPaySale {
  campaignId: number;
  campaignCode: string;
  date: string;
  logged: number;
  /** Confirmed by a statement; null/undefined while not confirmed (the logged figure is used). */
  confirmed?: number | null;
  /** £ per sub on that date (campaign_rates). */
  rate: number;
}

export interface WeekPayInput {
  dayRate: number;
  /** Distinct dates with gauges in the week (0–7). */
  daysWorked: number;
  sales: readonly WeekPaySale[];
  /** Manual bonus lines (pay_adjustments kind 'bonus'). */
  bonuses?: readonly Pick<PayAdjustment, 'id' | 'amount' | 'note'>[];
  /** Other adjustment lines landing on this week (cancellations, statements, disputes, manual). */
  adjustments?: readonly PayAdjustment[];
  deductions?: number;
}

/** The calculated week (WeekPayBreakdown without the person, the dates and the stored run). */
export interface WeekPayResult {
  baseAmount: number;
  commissionAmount: number;
  paidAs: PaidAs;
  basePay: number;
  commission: number;
  bonus: number;
  overrides: number;
  deductions: number;
  adjustmentsTotal: number;
  gross: number;
  salesLogged: number;
  salesConfirmed: number;
  salesCancelled: number;
  perCampaign: WeekCampaignPay[];
  lines: PayLine[];
}

/** STUB (P1): returns an all-zero week paid as base. */
export function calculateWeekPay(input: WeekPayInput): WeekPayResult {
  void input;
  return {
    baseAmount: 0, commissionAmount: 0, paidAs: 'base', basePay: 0, commission: 0, bonus: 0, overrides: 0, deductions: 0,
    adjustmentsTotal: 0, gross: 0, salesLogged: 0, salesConfirmed: 0, salesCancelled: 0, perCampaign: [], lines: [],
  };
}

/**
 * STUB (P1): the breakdown in sentences, e.g. "You worked 4 days: base £254.00. Commission: 16 subs paid (18 logged, 2
 * cancelled by BCN) = £160.00. Commission was below your base, so you're paid the base: £254.00."
 */
export function payExplanation(week: WeekPayResult): string[] {
  void week;
  return [];
}
