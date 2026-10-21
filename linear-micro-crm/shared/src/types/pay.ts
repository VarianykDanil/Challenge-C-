/**
 * Release 1.3 — P1 pay-rule contracts (laid down by r3-foundation; OWNED BY P1, which may add fields and types but never
 * renames or removes what another package relies on: CampaignRate, PayAdjustment, WeekPayBreakdown, ConfirmedSalesRow,
 * ApplyConfirmedSalesOptions, ApplyResult are used by P2 invoices, P3 statements and P6 client-portal).
 *
 * Owner's decision 2 (quote, do not reinterpret): "Pay rule, per pay week (Mon–Sun): base = £63.50 × days worked (days
 * with gauges that week; people work 2, 3, 4, 5 or 7 days). Commission = the week's paid subs × each campaign's rate. If
 * commission < base → paid the BASE only (the commission is not paid). If commission ≥ base → paid the COMMISSION only
 * (no base). Day rate £63.50 for everyone. NO automatic sales bonus and NO automatic leader overrides from 1.3: Matt adds
 * a bonus to individual top performers by hand. The breakdown must show all of this."
 *
 * Endpoints (server/src/routes/pay.ts, mounted at /pay, owned by P1; stubs answer empty data / 501 until P1 lands):
 *  - GET    /pay/settings                          → PayRuleSettings (admin)
 *  - PUT    /pay/settings  PayRuleSettingsInput    → PayRuleSettings (admin)
 *  - GET    /pay/rates?campaignId=                 → CampaignRate[] (admin, leader; newest first)
 *  - POST   /pay/rates     CampaignRateInput       → 201 CampaignRate (admin)
 *  - GET    /pay/breakdown?userId=&weekStart=      → WeekPayBreakdown (own; leader: own team; admin: anyone) — cached
 *  - GET    /pay/adjustments?userId=&weekStart=    → PayAdjustment[] (same scoping)
 *  - POST   /pay/bonuses   BonusInput              → 201 PayAdjustment (admin; kind 'bonus')
 *  - POST   /pay/adjustments ManualAdjustmentInput → 201 PayAdjustment (admin; kind 'manual')
 *  - DELETE /pay/adjustments/:id                   → 204 (admin; only on an unpaid target week)
 * Server helpers other packages call (server/src/lib/payRule.ts): payRuleSettings, weekPayBreakdown,
 * applyConfirmedSales (P3), addCampaignRate (P6 approval), campaignRateOn, recordCampaignRateChange (campaigns.ts).
 * Tables (server/src/db/extensions/pay.ts): campaign_rates, pay_adjustments, sale_confirmations; payroll_runs columns
 * paid_as, sales_logged, sales_confirmed, sales_cancelled, adjustments_total; meta `ext:pay:rule_from`,
 * `ext:pay:day_rate`.
 */
import type { PayrollBreakdown } from '../logic/finance.ts';
import type { PayrollStatus } from '../types.ts';

/** £63.50 a day for everyone (decision 2). The admin may change it in Settings → Pay (`ext:pay:day_rate`). */
export const PAY_DAY_RATE_DEFAULT = 63.5;

/** Which one a week paid: the base (commission below the base) or the commission (commission ≥ base; a tie pays commission). */
export type PaidAs = 'base' | 'commission';

/** GET /pay/settings. `ruleFrom` is PAY_RULE_FROM: the Monday from which weeks use the base-or-commission rule. */
export interface PayRuleSettings {
  /** £ per day worked; 63.5 by default. */
  dayRate: number;
  /** YYYY-MM-DD, a Monday. Weeks starting before it keep the 1.2 plan rules (their runs never change). */
  ruleFrom: string;
}

export interface PayRuleSettingsInput {
  dayRate?: number;
}

/** Where a campaign rate came from: the demo seed / upgrade, an admin edit, or a client's commission change Matt approved. */
export type CampaignRateSource = 'seed' | 'admin' | 'client';

/** One row of a campaign's rate history (campaign_rates). The rate in effect on a date is the latest `effectiveFrom` ≤ it. */
export interface CampaignRate {
  id: number;
  campaignId: number;
  /** £ paid to the rep per paid sub (decision 3: each client sets its own, e.g. £10 or £15). */
  repRate: number;
  /** £ the client pays Linear per paid sub. */
  payoutRate: number;
  /** YYYY-MM-DD from which this rate applies (inclusive). */
  effectiveFrom: string;
  source: CampaignRateSource;
  /** The admin who approved (or entered) it; null for 'seed'. */
  approvedBy: number | null;
  approvedByName?: string | null;
  /** P6: the client post (kind 'commission') this rate came from, when source = 'client'. */
  clientPostId?: number | null;
  createdAt: string;
}

/** POST /pay/rates, and P6's approval (lib/payRule.ts addCampaignRate). */
export interface CampaignRateInput {
  campaignId: number;
  repRate: number;
  payoutRate: number;
  effectiveFrom: string;
  source?: CampaignRateSource;
  clientPostId?: number | null;
}

/** A line of the breakdown (and of P2's invoice). `paid: false` lines are shown but not paid (e.g. the base when commission applied). */
export type PayLineKind = 'base' | 'commission' | 'bonus' | 'adjustment' | 'deduction' | 'override';

export interface PayLine {
  kind: PayLineKind;
  /** e.g. "4 days × £63.50", "BCN: 16 subs × £10.00", "Correction for w/c 5 Oct: 2 cancelled by BCN". */
  label: string;
  quantity?: number;
  /** £ per unit. */
  rate?: number;
  amount: number;
  /** false: listed for the explanation, not part of the total. */
  paid: boolean;
  campaignId?: number;
  campaignCode?: string;
  /** For adjustment lines: the week the correction comes from. */
  sourceWeekStart?: string;
  adjustmentId?: number;
  note?: string;
}

export type PayAdjustmentKind = 'cancellation' | 'statement' | 'bonus' | 'dispute' | 'manual';

/** pay_adjustments: an amount added to (or taken off) the person's run for `targetWeekStart` (always an unpaid week). */
export interface PayAdjustment {
  id: number;
  userId: number;
  /** Monday of the (unpaid) week whose run includes it. */
  targetWeekStart: string;
  /** Monday of the week it corrects (null for a bonus or a manual line about no particular week). */
  sourceWeekStart: string | null;
  kind: PayAdjustmentKind;
  /** £, negative to take money off. */
  amount: number;
  note: string;
  campaignId?: number | null;
  /** P3: the statement that caused it. */
  statementId?: number | null;
  /** P2: the disputed invoice it settles. */
  invoiceId?: number | null;
  createdBy: number | null;
  createdAt: string;
}

/** Per campaign inside a week: what was logged, what the client confirmed and what that pays. */
export interface WeekCampaignPay {
  campaignId: number;
  code: string;
  name?: string;
  /** Subs logged in gauges. */
  logged: number;
  /** Subs the client's statement confirmed; equal to `logged` while no statement has confirmed the period. */
  confirmed: number;
  /** logged − confirmed (never negative). */
  cancelled: number;
  /** True once a statement confirmed this campaign's week ("not yet confirmed by BCN" otherwise). */
  statementConfirmed: boolean;
  /** £ per sub; when the rate changed mid-week this is the weighted figure and `lines` carry each rate. */
  rate: number;
  /** confirmed × rate (summed over the rate periods). */
  amount: number;
}

/**
 * GET /pay/breakdown — one person's pay week under the 1.3 rule, with every figure the owner asked to see. Extends the
 * existing PayrollBreakdown, whose fields keep their meaning: basePay and commission are what the week PAYS (one of
 * them is 0 under the new rule; `lines` show the other as not paid), bonus = manual bonus lines, overrides = 0 from
 * PAY_RULE_FROM, deductions as before, gross = paid amount + bonus + adjustments − deductions.
 */
export interface WeekPayBreakdown extends PayrollBreakdown {
  userId: number;
  weekStart: string;
  weekEnd: string;
  /** 'base-or-commission' from PAY_RULE_FROM; 'plan' for the 1.2 plan rules before it. */
  rule: 'base-or-commission' | 'plan';
  daysWorked: number;
  dayRate: number;
  /** dayRate × daysWorked, whether or not it is paid. */
  baseAmount: number;
  /** Σ perCampaign.amount, whether or not it is paid. */
  commissionAmount: number;
  paidAs: PaidAs;
  lines: PayLine[];
  salesLogged: number;
  salesConfirmed: number;
  salesCancelled: number;
  perCampaign: WeekCampaignPay[];
  adjustments: PayAdjustment[];
  /** shared payExplanation(): "You worked 4 days: base £254.00. …" — one sentence per item. */
  explanation: string[];
  /** The stored run, when there is one (null for the week in progress). */
  runId: number | null;
  status: PayrollStatus | 'estimate';
}

/** One confirmed figure for applyConfirmedSales (P3 builds these from a statement's matched rows). */
export interface ConfirmedSalesRow {
  userId: number;
  campaignId: number;
  /** Monday of the pay week the confirmation is for. */
  weekStart: string;
  /** Subs the client confirmed for that person, campaign and week. */
  confirmed: number;
  /** P3: the statement row(s) it came from. */
  statementRowIds?: number[];
}

export interface ApplyConfirmedSalesOptions {
  statementId: number | null;
  actorId: number | null;
  /** true: compute the effect only (the statement page's preview); nothing is written. */
  dryRun?: boolean;
}

/** What applying a statement does to one person's week. */
export interface ApplyPersonResult {
  userId: number;
  userName?: string;
  campaignId: number;
  weekStart: string;
  logged: number;
  confirmed: number;
  cancelled: number;
  /** The week's pay before and after (gross). */
  before: { gross: number; paidAs: PaidAs | null };
  after: { gross: number; paidAs: PaidAs | null };
  /** after − before. */
  difference: number;
  /** 'recalculated': an unpaid week was recomputed; 'adjustment': a paid week → a line on the next unpaid run; 'no-change'. */
  effect: 'recalculated' | 'adjustment' | 'no-change';
  adjustmentId?: number | null;
  targetWeekStart?: string | null;
  /** "You were paid for 18, 2 cancelled, so −£20.00 next week" / "2 cancelled, but the base still applied: no change". */
  sentence: string;
}

/** applyConfirmedSales(db, rows, opts): idempotent per statement (applying the same statement twice changes nothing). */
export interface ApplyResult {
  statementId: number | null;
  dryRun: boolean;
  applied: boolean;
  people: ApplyPersonResult[];
  totalDifference: number;
}

/** POST /pay/bonuses — Matt's manual bonus for a top performer. */
export interface BonusInput {
  userId: number;
  /** Monday of the week the bonus is paid with (an unpaid week). */
  weekStart: string;
  amount: number;
  note: string;
}

/** POST /pay/adjustments — a manual correction. */
export interface ManualAdjustmentInput {
  userId: number;
  targetWeekStart: string;
  sourceWeekStart?: string | null;
  amount: number;
  note: string;
}
