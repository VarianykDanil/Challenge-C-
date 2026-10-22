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
import type { PayForecast, PayrollStatus } from '../types.ts';

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
  /**
   * P1: a new PAY_RULE_FROM (a Monday, not after this week's). Unpaid runs of the weeks it moves between the two rules
   * are recalculated; paid runs never change.
   */
  ruleFrom?: string;
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
  /** P1: the campaign's code ("BCN") when campaignId is set, and who added it (for the office's views). */
  campaignCode?: string | null;
  createdByName?: string | null;
  /** P1 (GET /pay/adjustments): whose pay it is on, and whether that week is already paid (then it cannot be removed). */
  userName?: string;
  targetPaid?: boolean;
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
  /** P1: false when the campaign's client sends no statements (never "not yet confirmed"); absent = it does. */
  awaitsStatement?: boolean;
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
  // ── P1 additions (optional, so every reader of the contract keeps working) ──
  /** Σ adjustment lines landing on this week (bonuses are in `bonus`). */
  adjustmentsTotal?: number;
  /** The person's name (for the office's views). */
  userName?: string;
  /** Payday of the week and, once paid, the day the money went. */
  dueDate?: string;
  paidDate?: string | null;
  /**
   * Corrections made AFTER this week was paid that come from it (e.g. a statement cancelled 2 subs): each one sits on a
   * later unpaid week (`targetWeekStart`). The week's own figures stay as paid.
   */
  corrections?: PayAdjustment[];
  /** True when the figures are the run as it was calculated (and, once paid, as it was paid), not a live recalculation. */
  asCalculated?: boolean;
  /** The person's pay plan pays no day rate and no commission (the owner's salaried plan): weekly pay does not apply. */
  salaried?: boolean;
  /** Campaign codes whose statement for this week has not arrived yet ("Not yet confirmed by BCN"), as of now. */
  awaiting?: string[];
}

/**
 * P1: this week's pay estimate under the 1.3 rule — added to the existing PayForecast (GET /finance/me `forecast`,
 * GET /me/insights `personal.payForecast`) as `rule` for weeks from PAY_RULE_FROM. The plan bonus fields of PayForecast
 * read 0 / 'none' then (no automatic bonus from 1.3); this says whether the base or the commission is likely to apply.
 */
export interface PayForecastRule {
  dayRate: number;
  /** Days so far plus the team event days left (≤ 7). */
  projectedDays: number;
  /** dayRate × projectedDays. */
  baseLikely: number;
  /** Commission from what is logged (or confirmed) so far this week. */
  commissionSoFar: number;
  /** commissionSoFar + the likely remaining subs × ratePerSub. */
  commissionLikely: number;
  paidAsLikely: PaidAs;
  /** £ per sub assumed for the days left (the rates of the team's campaigns ahead, else this week's, else recent). */
  ratePerSub: number;
  /** More subs needed for the commission to reach the likely base (0 when it already has). */
  subsToBeatBase: number;
  /** Stops those subs take at the person's own rate; null with too little history. */
  stopsToBeatBase: number | null;
  /** Chance (0..1) of reaching subsToBeatBase in the days left (Poisson, as the 1.2 bonus estimate); 1 when reached. */
  beatBaseProbability: number;
  /** Bonuses and corrections already on this week (known amounts, included in low / likely / high). */
  extras: number;
}

/** PayForecast with the P1 rule block (present for weeks from PAY_RULE_FROM). */
export type PayForecastWithRule = PayForecast & { rule?: PayForecastRule };

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
  /**
   * P3 (re-review fix): the person was on the statement this one replaces but is not on this one, so `confirmed` is
   * their week as logged; the sentence says "Not on BCN's corrected statement: back to the 22 subs logged".
   */
  notOnStatement?: boolean;
}

export interface ApplyConfirmedSalesOptions {
  statementId: number | null;
  actorId: number | null;
  /** true: compute the effect only (the statement page's preview); nothing is written. */
  dryRun?: boolean;
  /**
   * The applied statement this one replaces (P3, same campaign and period). Its correction lines still on an unpaid
   * week are handed to `statementId` first, inside the same savepoint, so each is updated in place rather than a
   * second line added (re-review fix: P1 re-keys its own lines; P3 never writes pay_adjustments).
   */
  replacesStatementId?: number | null;
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
