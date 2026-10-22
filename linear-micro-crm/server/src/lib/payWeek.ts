/**
 * Release 1.3 — OWNED BY P1 pay-rule. One person's pay week, read from the database and calculated by the rule that
 * applies to it: the 1.3 base-or-commission rule (shared calculateWeekPay) for weeks starting on or after
 * PAY_RULE_FROM, the 1.2 pay plan (shared calculatePayroll) before it. Reads only — nothing here writes a row.
 *
 * Used by lib/pay.ts weekPayFor (materialisation, estimates, the forecast, payroll checks, the digest), the seed (so a
 * seeded run equals what the live rules give) and lib/payRule.ts (breakdown, statements, rates, adjustments). Kept apart
 * from lib/payRule.ts so payRule can call db/maintenance.ts without an import cycle.
 *
 * Statements per week (constant): the plan (cached in a PayCalcContext), the settings (cached), sales per day and
 * campaign with the rate in effect (1), the week's confirmations (1) and adjustments (1); a recruiter's hires (1); a
 * 1.2 week's team sales when the plan pays overrides (1).
 */
import {
  calculatePayroll,
  calculateWeekPay,
  PAY_DAY_RATE_DEFAULT,
  round2,
  type PayAdjustment,
  type PayPlan,
  type PayRuleSettings,
  type PayrollBreakdown,
  type Role,
  type WeekConfirmation,
  type WeekPayResult,
  type WeekPaySale,
} from '@lm/shared';
import type { StatementSync } from 'node:sqlite';
import { all, get, type Db } from '../db/connection.ts';
import { getPayPlan } from '../db/queries.ts';
import { addDays, diffDays, mondayOf, sundayOf, todayISO } from './dates.ts';

export const RULE_FROM_KEY = 'ext:pay:rule_from';
export const DAY_RATE_KEY = 'ext:pay:day_rate';

/** Hires closed in a Mon–Sun week by the recruiter who owns the candidate: params (ownerId, monday, sunday). */
export const RECRUITER_HIRES_SQL = `
  SELECT COUNT(DISTINCT s.candidate_id) AS n FROM stage_changes s JOIN candidates c ON c.id = s.candidate_id
  WHERE s.to_stage = 'hired' AND c.owner_id = ? AND substr(s.changed_at, 1, 10) BETWEEN ? AND ?`;

/** Who is being paid (the fields the pay rules read). */
export interface PayUser {
  id: number;
  teamId: number | null;
  payPlanId: number;
  role: Role;
  startDate: string;
}

/**
 * Prepared statements reused per database: the week's queries run for every person and week (materialisation, the
 * seed, the payroll checks), and preparing them once keeps that cheap. SQLite re-prepares a cached statement itself
 * after a schema change.
 */
const PREPARED = new WeakMap<Db, Map<string, StatementSync>>();
function prepared(db: Db, sql: string): StatementSync {
  let byDb = PREPARED.get(db);
  if (!byDb) PREPARED.set(db, (byDb = new Map()));
  let st = byDb.get(sql);
  if (!st) byDb.set(sql, (st = db.prepare(sql)));
  return st;
}
const allOf = <T>(db: Db, sql: string, params: (string | number)[]): T[] => prepared(db, sql).all(...params) as unknown as T[];
const getOf = <T>(db: Db, sql: string, params: (string | number)[]): T | undefined => prepared(db, sql).get(...params) as unknown as T | undefined;

/** The pay rule's settings (Settings → Pay): one statement. */
export function payRuleSettings(db: Db): PayRuleSettings {
  const rows = allOf<{ key: string; value: string }>(db, `SELECT key, value FROM meta WHERE key IN (?, ?)`, [RULE_FROM_KEY, DAY_RATE_KEY]);
  const value = (k: string) => rows.find((r) => r.key === k)?.value ?? null;
  const rate = Number(value(DAY_RATE_KEY));
  const from = value(RULE_FROM_KEY);
  return {
    dayRate: Number.isFinite(rate) && rate > 0 ? rate : PAY_DAY_RATE_DEFAULT,
    ruleFrom: from && /^\d{4}-\d{2}-\d{2}$/.test(from) ? from : mondayOf(todayISO()),
  };
}

/** Settings and plans cached across many weeks (materialisation, the payroll checks, the seed). */
export interface PayCalcContext {
  settings: PayRuleSettings;
  plans: Map<number, PayPlan | undefined>;
}

export function payCalcContext(db: Db, settings: PayRuleSettings = payRuleSettings(db)): PayCalcContext {
  return { settings, plans: new Map() };
}

function planOf(db: Db, ctx: PayCalcContext, id: number): PayPlan | undefined {
  if (!ctx.plans.has(id)) ctx.plans.set(id, getPayPlan(db, id));
  return ctx.plans.get(id);
}

/** True for a week paid by the 1.3 rule. */
export function isRuleWeek(settings: PayRuleSettings, monday: string): boolean {
  return monday >= settings.ruleFrom;
}

/**
 * The owner's salaried plan pays neither a day rate nor commission per sale (in 1.2 it paid only overrides, which 1.3
 * drops): weekly pay does not apply to it from PAY_RULE_FROM. Every other plan is paid by the rule — its own base and
 * commission figures are replaced by the day rate and the campaign rates.
 */
export function isSalariedPlan(plan: Pick<PayPlan, 'basePerDay' | 'commissionPerSale'>): boolean {
  return !(plan.basePerDay > 0) && !(plan.commissionPerSale > 0);
}

/**
 * The rep rate of a campaign on a date, as SQL over `campaignCol` / `dateCol`: the campaign_rates row with the latest
 * effective_from on or before the date (a later id wins a tie), else the campaign's earliest row (a sale before the
 * history starts), else campaigns.rep_commission_per_sale (`fallbackCol`).
 */
export function rateOnSql(campaignCol: string, dateCol: string, fallbackCol: string, column: 'rep_rate' | 'payout_rate' = 'rep_rate'): string {
  return `COALESCE(
    (SELECT r.${column} FROM campaign_rates r WHERE r.campaign_id = ${campaignCol} AND r.effective_from <= ${dateCol} ORDER BY r.effective_from DESC, r.id DESC LIMIT 1),
    (SELECT r.${column} FROM campaign_rates r WHERE r.campaign_id = ${campaignCol} ORDER BY r.effective_from ASC, r.id ASC LIMIT 1),
    ${fallbackCol})`;
}

/**
 * Whether a campaign's client sends statements (so its subs are "not yet confirmed" until one arrives): it has a
 * statement sender set up (P3, Settings → Integrations) or a statement has confirmed some of its subs already.
 */
export const AWAITS_STATEMENT_SQL = (campaignCol: string) =>
  `(EXISTS (SELECT 1 FROM campaign_statement_senders ss WHERE ss.campaign_id = ${campaignCol})
    OR EXISTS (SELECT 1 FROM sale_confirmations sc WHERE sc.campaign_id = ${campaignCol}))`;

/** Sales per day and campaign in a week, with the rep rate in effect that day. Params: userId, monday, sunday. */
const WEEK_SALES_SQL = `
  SELECT g.date AS date, e.campaign_id AS campaignId, c.code AS code, c.name AS name, COALESCE(SUM(g.sales), 0) AS logged,
         ${rateOnSql('e.campaign_id', 'g.date', 'c.rep_commission_per_sale')} AS rate,
         ${AWAITS_STATEMENT_SQL('e.campaign_id')} AS awaits
  FROM gauge_entries g JOIN events e ON e.id = g.event_id JOIN campaigns c ON c.id = e.campaign_id
  WHERE g.user_id = ? AND g.date BETWEEN ? AND ?
  GROUP BY g.date, e.campaign_id
  ORDER BY g.date, e.campaign_id`;

/** The week's confirmations, each with the rate in effect on the week's Sunday. Params: sunday, userId, monday. */
const WEEK_CONFIRMATIONS_SQL = `
  SELECT s.campaign_id AS campaignId, s.confirmed, s.statement_id AS statementId, s.confirmed_at AS confirmedAt,
         c.code AS code, c.name AS name, ${rateOnSql('s.campaign_id', '?', 'c.rep_commission_per_sale')} AS rate
  FROM sale_confirmations s JOIN campaigns c ON c.id = s.campaign_id
  WHERE s.user_id = ? AND s.week_start = ?
  ORDER BY c.code`;

export const ADJUSTMENT_SELECT = `
  SELECT a.id, a.user_id AS userId, a.target_week_start AS targetWeekStart, a.source_week_start AS sourceWeekStart, a.kind,
         a.amount, a.note, a.campaign_id AS campaignId, a.statement_id AS statementId, a.invoice_id AS invoiceId,
         a.created_by AS createdBy, a.created_at AS createdAt, c.code AS campaignCode,
         CASE WHEN cb.id IS NULL THEN NULL ELSE cb.first_name || ' ' || cb.last_name END AS createdByName
  FROM pay_adjustments a
  LEFT JOIN campaigns c ON c.id = a.campaign_id
  LEFT JOIN users cb ON cb.id = a.created_by`;

const WEEK_ADJUSTMENTS_SQL = `${ADJUSTMENT_SELECT} WHERE a.user_id = ? AND a.target_week_start = ? ORDER BY a.created_at, a.id`;

export function mapAdjustment(r: PayAdjustment): PayAdjustment {
  return { ...r, amount: Number(r.amount), note: r.note ?? '' };
}

export interface StoredConfirmation extends WeekConfirmation {
  statementId: number | null;
  confirmedAt: string;
}

/** What the week's pay is calculated from. */
export interface WeekFacts {
  monday: string;
  sunday: string;
  daysWorked: number;
  sales: WeekPaySale[];
  confirmations: StoredConfirmation[];
  adjustments: PayAdjustment[];
  /** Recruiters only: the hires they closed (shown in the payroll `sales` column). */
  hires: number | null;
}

export function loadWeekFacts(db: Db, user: PayUser, monday: string, today = todayISO()): WeekFacts {
  const sunday = sundayOf(monday);
  const rows = allOf<{ date: string; campaignId: number; code: string; name: string; logged: number; rate: number; awaits: number }>(db, WEEK_SALES_SQL, [user.id, monday, sunday]);
  const sales: WeekPaySale[] = rows.map((r) => ({
    campaignId: Number(r.campaignId), campaignCode: r.code, campaignName: r.name, date: r.date, logged: Number(r.logged), rate: Number(r.rate),
    awaitsStatement: Boolean(r.awaits),
  }));
  let daysWorked = new Set(rows.map((r) => r.date)).size;
  let hires: number | null = null;
  if (user.role === 'recruiter') {
    // office based: Mon–Fri, clamped to the start date and (for the week in progress) to today
    const first = user.startDate > monday ? user.startDate : monday;
    const friday = addDays(monday, 4);
    const last = friday < today ? friday : today;
    daysWorked = Math.max(0, Math.min(5, diffDays(first, last) + 1));
    hires = Number(getOf<{ n: number }>(db, RECRUITER_HIRES_SQL, [user.id, monday, sunday])!.n);
  }
  const confirmations = allOf<{ campaignId: number; confirmed: number; statementId: number | null; confirmedAt: string; code: string; name: string; rate: number }>(
    db, WEEK_CONFIRMATIONS_SQL, [sunday, user.id, monday],
  ).map((c) => ({
    campaignId: Number(c.campaignId), confirmed: Number(c.confirmed), campaignCode: c.code, campaignName: c.name, rate: Number(c.rate),
    statementId: c.statementId === null ? null : Number(c.statementId), confirmedAt: c.confirmedAt,
  }));
  const adjustments = allOf<PayAdjustment>(db, WEEK_ADJUSTMENTS_SQL, [user.id, monday]).map(mapAdjustment);
  return { monday, sunday, daysWorked, sales, confirmations, adjustments, hires };
}

/** One person's week, by the rule that applies to it. */
export interface ComputedWeek {
  rule: 'base-or-commission' | 'plan';
  facts: WeekFacts;
  daysWorked: number;
  /** The payroll `sales` column: subs logged in gauges (a recruiter: hires). */
  sales: number;
  teamSales: number;
  /** basePay, commission, bonus, overrides, deductions, gross — gross after `deductions` when they were passed. */
  pay: PayrollBreakdown;
  /** The full calculation (lines, per campaign, paid as) — for a 1.2 week, the plan's figures as lines. */
  result: WeekPayResult;
  salaried: boolean;
  /** Bonus or adjustment lines land on this week. */
  hasAdjustments: boolean;
  /** Something was worked, logged, confirmed or added this week. */
  hasWork: boolean;
  dayRate: number;
  plan: PayPlan;
  /** The confirmations the calculation used (none with `withoutConfirmations`). */
  confirmationsUsed: readonly WeekConfirmation[];
  /** A 1.2 week: the sales its commission was paid on (confirmed when a statement confirmed the week). */
  planSales?: number;
}

export interface ComputeOptions {
  ctx?: PayCalcContext;
  /** The run's stored deductions (0 when omitted): taken off `pay.gross` and `result.gross`. */
  deductions?: number;
  /** Ignore the stored confirmations (the seed: a week paid before its statement arrived). */
  withoutConfirmations?: boolean;
}

/** Team sales excluding the person, for a 1.2 week's overrides (leaders: their team; no-team seniors: their events). */
function planTeamSales(db: Db, user: PayUser, monday: string, sunday: string): number {
  if (user.teamId !== null) {
    return Number(get<{ s: number }>(
      db,
      `SELECT COALESCE(SUM(g.sales), 0) AS s FROM gauge_entries g JOIN users u ON u.id = g.user_id WHERE u.team_id = ? AND g.user_id <> ? AND g.date BETWEEN ? AND ?`,
      [user.teamId, user.id, monday, sunday],
    )!.s);
  }
  return Number(get<{ s: number }>(
    db,
    `SELECT COALESCE(SUM(o.sales), 0) AS s FROM gauge_entries o
     WHERE o.user_id <> ? AND o.event_id IN (SELECT event_id FROM gauge_entries WHERE user_id = ? AND date BETWEEN ? AND ?)`,
    [user.id, user.id, monday, sunday],
  )!.s);
}

/** Paid subs per campaign after the week's confirmations (a 1.2 week pays its plan commission on these). */
function confirmedSalesTotal(facts: WeekFacts, withoutConfirmations: boolean): number {
  const logged = new Map<number, number>();
  for (const s of facts.sales) logged.set(s.campaignId, (logged.get(s.campaignId) ?? 0) + s.logged);
  if (!withoutConfirmations) for (const c of facts.confirmations) logged.set(c.campaignId, c.confirmed);
  let total = 0;
  for (const n of logged.values()) total += n;
  return total;
}

/**
 * The week by the rule that applies to it; null when the plan is missing. A 1.3 week: shared calculateWeekPay with
 * the day rate (0 for a salaried plan, which also earns no commission), the sales at the campaign rates, the week's
 * confirmations, bonuses and adjustments. A 1.2 week: the plan maths as in 1.2 (sales = the confirmed subs when a
 * statement confirmed the week), plus any bonus or adjustment lines on it.
 */
export function computeWeek(db: Db, user: PayUser, monday: string, today = todayISO(), opts: ComputeOptions = {}): ComputedWeek | null {
  const ctx = opts.ctx ?? payCalcContext(db);
  const plan = planOf(db, ctx, user.payPlanId);
  if (!plan) return null;
  const facts = loadWeekFacts(db, user, monday, today);
  const confirmations = opts.withoutConfirmations ? [] : facts.confirmations;
  const deductions = round2(Math.max(0, Number(opts.deductions ?? 0) || 0));
  const bonuses = facts.adjustments.filter((a) => a.kind === 'bonus');
  const others = facts.adjustments.filter((a) => a.kind !== 'bonus');
  const salesLogged = facts.sales.reduce((a, s) => a + s.logged, 0);
  const hasAdjustments = facts.adjustments.length > 0;
  const salesColumn = facts.hires ?? salesLogged;

  if (isRuleWeek(ctx.settings, monday)) {
    const salaried = isSalariedPlan(plan);
    const dayRate = salaried ? 0 : ctx.settings.dayRate;
    const result = calculateWeekPayFrom(dayRate, salaried ? 0 : facts.daysWorked, salaried ? [] : facts.sales, salaried ? [] : confirmations, bonuses, others, deductions);
    return {
      rule: 'base-or-commission',
      facts,
      daysWorked: facts.daysWorked,
      sales: salesColumn,
      teamSales: 0,
      pay: { basePay: result.basePay, commission: result.commission, bonus: result.bonus, overrides: 0, deductions: result.deductions, gross: result.gross },
      result,
      salaried,
      hasAdjustments,
      hasWork: !salaried && (facts.daysWorked > 0 || salesLogged > 0 || confirmations.length > 0 || hasAdjustments),
      dayRate,
      plan,
      confirmationsUsed: salaried ? [] : confirmations,
    };
  }

  // ── 1.2 plan rules ──
  const sales = facts.hires ?? confirmedSalesTotal(facts, Boolean(opts.withoutConfirmations));
  const teamSales = plan.overridePerTeamSale > 0 ? planTeamSales(db, user, monday, facts.sunday) : 0;
  const base = calculatePayroll(plan, { daysWorked: facts.daysWorked, sales, teamSales, deductions });
  const bonusTotal = round2(bonuses.reduce((a, b) => a + b.amount, 0));
  const adjustmentsTotal = round2(others.reduce((a, b) => a + b.amount, 0));
  const pay: PayrollBreakdown = { ...base, bonus: round2(base.bonus + bonusTotal), gross: round2(base.gross + bonusTotal + adjustmentsTotal) };
  const result = planResult(plan, facts, sales, teamSales, base, bonuses, others, pay, confirmations);
  return {
    rule: 'plan',
    facts,
    daysWorked: facts.daysWorked,
    sales: facts.hires ?? salesLogged,
    teamSales,
    pay,
    result,
    salaried: false,
    hasAdjustments,
    hasWork: facts.daysWorked > 0 || sales > 0 || teamSales > 0 || hasAdjustments,
    dayRate: plan.basePerDay,
    plan,
    confirmationsUsed: confirmations,
    planSales: sales,
  };
}

/** The shared calculation, in one place so the seed, the live rules and the breakdown agree. */
function calculateWeekPayFrom(
  dayRate: number,
  daysWorked: number,
  sales: readonly WeekPaySale[],
  confirmations: readonly WeekConfirmation[],
  bonuses: readonly PayAdjustment[],
  adjustments: readonly PayAdjustment[],
  deductions: number,
): WeekPayResult {
  return calculateWeekPay({ dayRate, daysWorked, sales, confirmations, bonuses, adjustments, deductions });
}

/** A 1.2 week as lines (everything it pays is paid, side by side). */
function planResult(
  plan: PayPlan,
  facts: WeekFacts,
  sales: number,
  teamSales: number,
  base: PayrollBreakdown,
  bonuses: readonly PayAdjustment[],
  others: readonly PayAdjustment[],
  pay: PayrollBreakdown,
  confirmations: readonly WeekConfirmation[],
): WeekPayResult {
  // per campaign at the plan's commission per sale
  const rule = calculateWeekPay({
    dayRate: plan.basePerDay,
    daysWorked: facts.daysWorked,
    sales: facts.sales.map((s) => ({ ...s, rate: plan.commissionPerSale })),
    confirmations,
    bonuses,
    adjustments: others,
    deductions: base.deductions,
  });
  const lines = [
    { ...rule.lines[0]!, paid: true },
    ...rule.lines.filter((l) => l.kind === 'commission').map((l) => ({ ...l, paid: true })),
  ];
  if (base.bonus > 0) lines.push({ kind: 'bonus', label: `Plan bonus: ${plan.bonusThreshold}+ sales`, amount: base.bonus, paid: true });
  if (base.overrides > 0) lines.push({ kind: 'override', label: `Overrides: ${teamSales} team sales × £${plan.overridePerTeamSale.toFixed(2)}`, quantity: teamSales, rate: plan.overridePerTeamSale, amount: base.overrides, paid: true });
  lines.push(...rule.lines.filter((l) => l.kind === 'bonus' || l.kind === 'adjustment' || l.kind === 'deduction'));
  return {
    ...rule,
    baseAmount: base.basePay,
    commissionAmount: base.commission,
    paidAs: rule.paidAs,
    basePay: base.basePay,
    commission: base.commission,
    bonus: pay.bonus,
    overrides: base.overrides,
    deductions: base.deductions,
    gross: pay.gross,
    salesConfirmed: confirmations.length ? sales : rule.salesConfirmed,
    lines,
    dayRate: plan.basePerDay,
  };
}

// ───────────────────────────── the run's snapshot ─────────────────────────────

/** The 1.2 pay plan a plan week was calculated with, and the counts it paid on. */
export interface SnapshotPlan {
  name: string;
  basePerDay: number;
  commissionPerSale: number;
  bonusThreshold: number;
  bonusAmount: number;
  overridePerTeamSale: number;
  /** The sales the commission was paid on (the confirmed subs when a statement confirmed the week). */
  sales: number;
  teamSales: number;
  /** A recruiter's hires (their `sales`): subs do not change a recruiter's pay. */
  hires: number | null;
}

/**
 * What the week was calculated from (review fix): a statement for a PAID week recalculates the week from these, so
 * the correction is (corrected − paid) with the day rate, the rates and the logged subs it was paid with — never with
 * gauges, rates or a day rate changed since.
 */
export interface SnapshotInputs {
  /** A 1.3 week: subs per day and campaign at the rate in effect that day (empty for a salaried plan). */
  sales: WeekPaySale[];
  /** The statements' confirmed subs the calculation used. */
  confirmations: WeekConfirmation[];
  deductions: number;
  /** A 1.2 plan week. */
  plan?: SnapshotPlan;
}

/** payroll_runs.breakdown_json: the week as it was last calculated (a paid run keeps it as paid). */
export interface RunSnapshot {
  v: 1;
  /** 'plan' for a week before PAY_RULE_FROM (stored from the review fix on; earlier plan weeks have no snapshot). */
  rule: 'base-or-commission' | 'plan';
  daysWorked: number;
  dayRate: number;
  salaried: boolean;
  result: WeekPayResult;
  adjustments: PayAdjustment[];
  /** Absent in a run stored before the inputs were kept. */
  inputs?: SnapshotInputs;
}

export function snapshotOf(w: ComputedWeek): RunSnapshot {
  const plan: SnapshotPlan | undefined = w.rule === 'plan'
    ? {
        name: w.plan.name,
        basePerDay: w.plan.basePerDay,
        commissionPerSale: w.plan.commissionPerSale,
        bonusThreshold: w.plan.bonusThreshold,
        bonusAmount: w.plan.bonusAmount,
        overridePerTeamSale: w.plan.overridePerTeamSale,
        sales: w.planSales ?? 0,
        teamSales: w.teamSales,
        hires: w.facts.hires,
      }
    : undefined;
  const inputs: SnapshotInputs = {
    // the name is in result.perCampaign already
    sales: w.rule === 'plan' || w.salaried ? [] : w.facts.sales.map(({ campaignName: _n, ...s }) => s),
    confirmations: w.confirmationsUsed.map((c) => ({ campaignId: c.campaignId, confirmed: c.confirmed, ...(c.campaignCode ? { campaignCode: c.campaignCode } : {}), ...(c.rate !== undefined ? { rate: c.rate } : {}) })),
    deductions: w.pay.deductions,
    ...(plan ? { plan } : {}),
  };
  return { v: 1, rule: w.rule, daysWorked: w.daysWorked, dayRate: w.dayRate, salaried: w.salaried, result: w.result, adjustments: w.facts.adjustments, inputs };
}

export function parseSnapshot(json: string | null | undefined): RunSnapshot | null {
  if (!json) return null;
  try {
    const s = JSON.parse(json) as RunSnapshot;
    if (!s || s.v !== 1 || !s.result || !Array.isArray(s.result.lines)) return null;
    if (s.rule !== 'plan') s.rule = 'base-or-commission';
    if (s.rule === 'plan' && !s.inputs?.plan) return null;
    return s;
  } catch {
    return null;
  }
}

/**
 * The 1.3 columns of a run (NULL for a 1.2 week): what syncPayrollRun and the seed write, so a seeded run and a
 * recalculated one are identical.
 */
export interface RuleColumns {
  paidAs: string | null;
  salesLogged: number | null;
  salesConfirmed: number | null;
  salesCancelled: number | null;
  adjustmentsTotal: number | null;
  breakdownJson: string | null;
}

export function ruleColumnsOf(w: ComputedWeek): RuleColumns {
  if (w.rule !== 'base-or-commission') {
    // a 1.2 week: the 1.3 columns stay empty unless a statement confirmed it or a correction landed on it; the
    // calculation is stored all the same (review fix), so a paid plan week keeps the figures it was paid with
    const confirmed = w.facts.confirmations.length > 0;
    return {
      paidAs: null,
      salesLogged: confirmed ? w.result.salesLogged : null,
      salesConfirmed: confirmed ? w.result.salesConfirmed : null,
      salesCancelled: confirmed ? w.result.salesCancelled : null,
      adjustmentsTotal: w.result.adjustmentsTotal !== 0 ? w.result.adjustmentsTotal : null,
      breakdownJson: JSON.stringify(snapshotOf(w)),
    };
  }
  return {
    paidAs: w.result.paidAs,
    salesLogged: w.result.salesLogged,
    salesConfirmed: w.result.salesConfirmed,
    salesCancelled: w.result.salesCancelled,
    adjustmentsTotal: w.result.adjustmentsTotal,
    breakdownJson: JSON.stringify(snapshotOf(w)),
  };
}
