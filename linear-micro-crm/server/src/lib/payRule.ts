/**
 * Release 1.3 — the pay rule on the server — OWNED BY P1 pay-rule (laid down by r3-foundation; every export below is
 * STABLE: other packages call them). The week's maths lives in lib/payWeek.ts (reads only) and shared payRule.ts.
 *
 *  - payRuleSettings(db): day rate (meta `ext:pay:day_rate`, default £63.50) and PAY_RULE_FROM (meta
 *    `ext:pay:rule_from`; the Monday of today when it was never written). updatePaySettings writes them (Settings →
 *    Pay) and recalculates the unpaid runs they move.
 *  - weekPayBreakdown(db, userId, weekStart): the week with every line (P2 builds invoice lines from it; GET
 *    /pay/breakdown answers it). A stored run answers its own calculation (breakdown_json): a paid run as it was
 *    paid, with the corrections made later listed under `corrections`; a paid 1.2 run without one answers its own
 *    stored columns once the gauges or the plan moved. Weeks without a run are calculated live.
 *  - applyConfirmedSales(db, rows, opts): P3 calls it when a statement is applied (opts.dryRun for the preview: the
 *    same writes inside a savepoint that is rolled back, so the preview is exactly what Apply does). Unpaid weeks are
 *    recalculated; a paid week's difference (corrected − paid, from the run's own stored inputs: lib/paidWeek.ts)
 *    becomes a pay_adjustments row on the person's next unpaid week; applying the same statement again changes
 *    nothing.
 *  - campaignRateOn / listCampaignRates / addCampaignRate (P6's approval and POST /pay/rates; unpaid weeks from the
 *    effective date recalculate) / recordCampaignRateChange (routes/campaigns.ts after POST and PATCH).
 *  - addPayAdjustment / removePayAdjustment / listPayAdjustments: bonuses (kind 'bonus'), manual lines, dispute
 *    settlements (P2, kind 'dispute') — always on an unpaid week.
 *  - recalculateUnpaidRuns, nextUnpaidWeek: helpers for the above (and for P2/P3/P6).
 * Paid runs never change. Every write here bumps the data version (the cached views refresh).
 */
import {
  applySentence,
  MONEY_MAX,
  paidAsFor,
  payDayLabel,
  payExplanation,
  paySignedMoney,
  payMoney,
  payWeekLabel,
  paydayForWeek,
  round2,
  type ApplyConfirmedSalesOptions,
  type ApplyPersonResult,
  type ApplyResult,
  type Campaign,
  type CampaignRate,
  type CampaignRateInput,
  type CampaignRateSource,
  type ConfirmedSalesRow,
  type PayAdjustment,
  type PayAdjustmentKind,
  type PayRuleSettings,
  type PayRuleSettingsInput,
  type WeekPayBreakdown,
  type WeekPayResult,
} from '@lm/shared';
import { all, get, placeholders, run, type Db, type Param } from '../db/connection.ts';
import { applyRatesInEffect, ensurePayrollMaterialised, syncPayrollRun } from '../db/maintenance.ts';
import { getUser } from '../db/queries.ts';
import { bumpDataVersion } from './cache.ts';
import { addDays, isISODate, mondayOf, nowISO, sundayOf, todayISO } from './dates.ts';
import { HttpError, badRequest, conflict, notFound } from './errors.ts';
import { paidWeekOf, type ExtraCampaign, type PaidRunColumns } from './paidWeek.ts';
import {
  ADJUSTMENT_SELECT,
  DAY_RATE_KEY,
  RULE_FROM_KEY,
  computeWeek,
  isRuleWeek,
  mapAdjustment,
  parseSnapshot,
  payCalcContext,
  payRuleSettings,
  type PayCalcContext,
  type PayUser,
} from './payWeek.ts';

export { payRuleSettings } from './payWeek.ts';

/** The largest day rate Settings → Pay accepts (a typo guard). */
export const DAY_RATE_MAX = 500;

type RunUser = PayUser & { employeeId: string; firstName: string; lastName: string };

const RUN_USER_SELECT = `
  SELECT u.id, u.employee_id AS employeeId, u.first_name AS firstName, u.last_name AS lastName, u.team_id AS teamId,
         u.pay_plan_id AS payPlanId, u.role, u.start_date AS startDate
  FROM users u`;

function runUsers(db: Db, ids: readonly number[]): Map<number, RunUser> {
  if (!ids.length) return new Map();
  const rows = all<RunUser>(db, `${RUN_USER_SELECT} WHERE u.id IN (${placeholders(ids.length)}) AND u.role <> 'client'`, [...ids]);
  return new Map(rows.map((u) => [Number(u.id), { ...u, id: Number(u.id), teamId: u.teamId === null ? null : Number(u.teamId), payPlanId: Number(u.payPlanId) }]));
}

/** Runs `fn` inside a SAVEPOINT (works inside or outside the caller's transaction); `rollback` undoes it on success. */
function withSavepoint<T>(db: Db, name: string, fn: () => T, rollback = false): T {
  db.exec(`SAVEPOINT ${name}`);
  try {
    const out = fn();
    if (rollback) db.exec(`ROLLBACK TO ${name}`);
    db.exec(`RELEASE ${name}`);
    return out;
  } catch (err) {
    db.exec(`ROLLBACK TO ${name}`);
    db.exec(`RELEASE ${name}`);
    throw err;
  }
}

interface StoredRunRow extends PaidRunColumns {
  id: number;
  status: string;
  dueDate: string;
  paidDate: string | null;
  basePay: number;
  commission: number;
  bonus: number;
  overrides: number;
  salesConfirmed: number | null;
  salesCancelled: number | null;
  adjustedAt: string | null;
}

const storedRun = (db: Db, userId: number, monday: string) =>
  get<StoredRunRow>(
    db,
    `SELECT id, status, due_date AS dueDate, paid_date AS paidDate, deductions, gross, breakdown_json AS breakdownJson,
            days_worked AS daysWorked, sales, team_sales AS teamSales, base_pay AS basePay, commission, bonus, overrides,
            sales_confirmed AS salesConfirmed, sales_cancelled AS salesCancelled, adjusted_at AS adjustedAt
     FROM payroll_runs WHERE user_id = ? AND week_start = ?`,
    [userId, monday],
  );

const isPaidStatus = (s: string | undefined | null) => s === 'paid' || s === 'late';

// ───────────────────────────── settings ─────────────────────────────

/**
 * Settings → Pay. A new day rate applies to every UNPAID week from PAY_RULE_FROM; a new PAY_RULE_FROM (a Monday, not
 * after this week's) moves the weeks between the two dates to the other rule — their unpaid runs are recalculated.
 * Paid runs never change.
 */
export function updatePaySettings(db: Db, input: PayRuleSettingsInput, today = todayISO()): PayRuleSettings {
  const before = payRuleSettings(db);
  const next = { ...before };
  if (input.dayRate !== undefined) {
    const rate = Number(input.dayRate);
    if (!Number.isFinite(rate) || rate <= 0 || rate > DAY_RATE_MAX) throw badRequest(`The day rate must be more than £0 and at most £${DAY_RATE_MAX}`);
    next.dayRate = round2(rate);
  }
  if (input.ruleFrom !== undefined) {
    if (typeof input.ruleFrom !== 'string' || !isISODate(input.ruleFrom)) throw badRequest('ruleFrom must be a date formatted YYYY-MM-DD');
    if (mondayOf(input.ruleFrom) !== input.ruleFrom) throw badRequest('The rule date must be a Monday (pay weeks run Monday to Sunday)');
    if (input.ruleFrom > mondayOf(today)) throw badRequest('The rule date cannot be after this week');
    next.ruleFrom = input.ruleFrom;
  }
  if (next.dayRate === before.dayRate && next.ruleFrom === before.ruleFrom) return before;
  withSavepoint(db, 'p1_settings', () => {
    const put = `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`;
    run(db, put, [DAY_RATE_KEY, String(next.dayRate)]);
    run(db, put, [RULE_FROM_KEY, next.ruleFrom]);
    const from = next.ruleFrom !== before.ruleFrom ? (next.ruleFrom < before.ruleFrom ? next.ruleFrom : before.ruleFrom) : next.ruleFrom;
    recalculateUnpaidRuns(db, { from }, today);
  });
  bumpDataVersion();
  return payRuleSettings(db);
}

// ───────────────────────────── recalculation ─────────────────────────────

export interface RecalcScope {
  /** Weeks starting on or after this Monday. */
  from: string;
  /** … and on or before this one. */
  to?: string;
  userIds?: readonly number[];
  /** Only weeks in which the person logged sales at this campaign. */
  campaignId?: number;
}

/**
 * Recalculates the unpaid (pending / failed) runs in scope with syncPayrollRun — the rule of the week, the gauges, the
 * confirmations, bonuses and corrections. Paid runs are never read for this. Returns how many runs changed.
 */
export function recalculateUnpaidRuns(db: Db, scope: RecalcScope, today = todayISO(), ctx: PayCalcContext = payCalcContext(db)): number {
  const where: string[] = [`p.status IN ('pending', 'failed')`, `p.week_start >= ?`];
  const params: Param[] = [mondayOf(scope.from)];
  if (scope.to) {
    where.push('p.week_start <= ?');
    params.push(scope.to);
  }
  if (scope.userIds) {
    if (!scope.userIds.length) return 0;
    where.push(`p.user_id IN (${placeholders(scope.userIds.length)})`);
    params.push(...scope.userIds);
  }
  if (scope.campaignId) {
    where.push(`EXISTS (SELECT 1 FROM gauge_entries g JOIN events e ON e.id = g.event_id WHERE g.user_id = p.user_id AND e.campaign_id = ? AND g.date BETWEEN p.week_start AND p.week_end)`);
    params.push(scope.campaignId);
  }
  const runs = all<{ userId: number; weekStart: string }>(db, `SELECT p.user_id AS userId, p.week_start AS weekStart FROM payroll_runs p WHERE ${where.join(' AND ')} ORDER BY p.week_start, p.user_id`, params);
  if (!runs.length) return 0;
  const users = runUsers(db, [...new Set(runs.map((r) => Number(r.userId)))]);
  let changed = 0;
  for (const r of runs) {
    const u = users.get(Number(r.userId));
    if (!u) continue;
    const s = syncPayrollRun(db, u, r.weekStart, today, { ctx });
    if (s === 'updated' || s === 'deleted' || s === 'created') changed++;
  }
  return changed;
}

/**
 * The week a correction for `sourceMonday` goes on: the person's earliest PENDING run after that week, else the
 * current pay week (its run is created when the week closes and includes the correction). A failed transfer is owed
 * money already in flight, so it is not reused.
 */
export function nextUnpaidWeek(db: Db, userId: number, sourceMonday: string, today = todayISO()): string {
  const floor = addDays(mondayOf(sourceMonday), 7);
  const pending = get<{ w: string | null }>(db, `SELECT MIN(week_start) AS w FROM payroll_runs WHERE user_id = ? AND week_start >= ? AND status = 'pending'`, [userId, floor])!.w;
  if (pending) return pending;
  const current = mondayOf(today);
  return floor > current ? floor : current;
}

/** Re-syncs one person's run for one week (after a bonus, an adjustment or a confirmation landed on it). */
function syncWeek(db: Db, userId: number, monday: string, today: string, ctx?: PayCalcContext): void {
  const u = runUsers(db, [userId]).get(userId);
  if (u) syncPayrollRun(db, u, monday, today, { ctx });
}

// ───────────────────────────── the breakdown ─────────────────────────────

export interface BreakdownOptions {
  /** Who is looking: the explanation says "you" to the person themselves and uses their first name for anyone else. */
  viewerId?: number | null;
  today?: string;
}

/**
 * One person's pay week with every figure and line: the stored run's own calculation when it has one (a paid run as
 * it was paid), else a live calculation (the week in progress, a week with no run). A paid 1.2 run (made by the 1.2
 * code, so no stored calculation) shows the live calculation only while it still equals the run's figures; once the
 * gauges or the plan moved, its own stored columns (review fix). The same goes for an UNPAID 1.2 plan-week run, which a
 * plan or team change does not recalculate (re-review fix: the breakdown and Mark paid then agree). Null for an
 * unknown person or a client account.
 */
export function weekPayBreakdown(db: Db, userId: number, weekStart: string, opts: BreakdownOptions = {}): WeekPayBreakdown | null {
  if (!isISODate(weekStart)) return null;
  const today = opts.today ?? todayISO();
  const user = getUser(db, userId);
  if (!user || user.role === 'client') return null;
  const monday = mondayOf(weekStart);
  const sunday = sundayOf(monday);
  const ctx = payCalcContext(db);
  const settings = ctx.settings;
  const stored = storedRun(db, userId, monday);
  const snap = stored ? parseSnapshot(stored.breakdownJson) : null;
  const paid = isPaidStatus(stored?.status);

  let result: WeekPayResult;
  let rule: WeekPayBreakdown['rule'];
  let adjustments: PayAdjustment[];
  let daysWorked: number;
  let dayRate: number;
  let salaried: boolean;
  let planName: string | null = null;
  let asPaid = Boolean(snap);
  if (snap) {
    result = snap.result;
    rule = snap.rule;
    adjustments = snap.adjustments;
    daysWorked = snap.daysWorked;
    dayRate = snap.dayRate;
    salaried = snap.salaried;
    planName = snap.inputs?.plan?.name ?? null;
  } else {
    const w = computeWeek(db, user, monday, today, { ctx, deductions: stored?.deductions ?? 0 });
    if (!w) return null;
    // a run made by the 1.2 code (no stored calculation): paid, or an unpaid 1.2 plan week (re-review fix: a plan or
    // team change does not recalculate it, and Mark paid pays the run) — its own columns once the live figures moved
    if (stored && (paid || w.rule === 'plan') && !(w.rule === 'plan' && matchesRun(w.result, w.daysWorked, w.sales, stored))) {
      result = resultFromRun(stored, user.role === 'recruiter');
      rule = 'plan';
      adjustments = [];
      daysWorked = Number(stored.daysWorked);
      dayRate = daysWorked > 0 ? round2(Number(stored.basePay) / daysWorked) : w.plan.basePerDay;
      salaried = false;
      asPaid = true;
    } else {
      result = w.result;
      rule = w.rule;
      adjustments = w.facts.adjustments;
      daysWorked = w.daysWorked;
      dayRate = w.dayRate;
      salaried = w.salaried;
    }
    planName = w.plan.name;
  }
  const liveConfirmations = asPaid
    ? all<{ campaignId: number; campaignCode: string; confirmed: number }>(
        db,
        `SELECT s.campaign_id AS campaignId, c.code AS campaignCode, s.confirmed FROM sale_confirmations s JOIN campaigns c ON c.id = s.campaign_id WHERE s.user_id = ? AND s.week_start = ?`,
        [userId, monday],
      )
    : [];
  const corrections = all<PayAdjustment>(
    db,
    `${ADJUSTMENT_SELECT} WHERE a.user_id = ? AND a.source_week_start = ? AND a.target_week_start <> ? ORDER BY a.created_at, a.id`,
    [userId, monday, monday],
  ).map(mapAdjustment);

  const own = opts.viewerId === undefined || opts.viewerId === null || opts.viewerId === userId;
  const name = own ? undefined : user.firstName;
  // A stored calculation said "not yet confirmed by BCN"; when BCN's statement has arrived since, say so as of payment.
  const confirmedNow = new Set(liveConfirmations.map((c) => c.campaignId));
  const confirmedSince = snap
    ? result.perCampaign.filter((c) => !c.statementConfirmed && confirmedNow.has(c.campaignId)).map((c) => c.code)
    : [];
  if (confirmedSince.length) {
    const codes = new Set(confirmedSince);
    result = {
      ...result,
      lines: result.lines.map((l) =>
        l.kind === 'commission' && l.note && l.campaignCode && codes.has(l.campaignCode)
          ? { ...l, note: l.note.replace(`not yet confirmed by ${l.campaignCode}`, `not confirmed by ${l.campaignCode} when paid`) }
          : l,
      ),
    };
  }
  let explanation: string[];
  if (salaried) {
    explanation = [`${own ? 'Your' : `${user.firstName}'s`} pay plan${planName ? ` (${planName})` : ''} pays no day rate and no commission, so weekly pay does not apply from ${payDayLabel(settings.ruleFrom)}.`];
  } else if (rule === 'plan') {
    explanation = planExplanation(result, settings.ruleFrom, daysWorked);
  } else {
    explanation = payExplanation({ ...result, daysWorked, dayRate }, { name, confirmedSince });
  }
  if (paid && stored?.adjustedAt) explanation.push('The gauges for this week were changed after it was paid; the figures here are what it was paid with.');
  if (!paid && stored && asPaid && !snap) explanation.push('These are the figures this pay run was made with, which is what will be paid. A fresh calculation would differ (for example after a change of pay plan).');
  if (!paid && stored && result.gross < 0) {
    const owed = payMoney(-result.gross);
    explanation.push(own
      ? `Your corrections come to more than this week's pay, so the total is below £0 (${payMoney(result.gross)}) and nothing can be paid for it as it is. The office will agree with you how the ${owed} is settled, for example on a later week.`
      : `${user.firstName}'s corrections come to more than this week's pay, so the total is below £0 (${payMoney(result.gross)}) and nothing can be paid for it as it is. The ${owed} owed is settled with ${user.firstName}, for example on a later week.`);
  }
  if (asPaid && paid) {
    // confirmed by a statement after the week was paid
    const byCampaign = new Map(result.perCampaign.map((c) => [c.campaignId, c]));
    for (const c of liveConfirmations) {
      const was = byCampaign.get(c.campaignId);
      if (was && was.statementConfirmed && was.confirmed === c.confirmed) continue;
      const fixed = corrections.some((a) => a.campaignId === c.campaignId && (a.kind === 'cancellation' || a.kind === 'statement'));
      const of = was ? ` of ${was.logged}` : '';
      explanation.push(`After this week was paid, ${c.campaignCode ?? 'the client'} confirmed ${c.confirmed}${of} subs${fixed ? '' : ', which did not change the pay'}.`);
    }
  }
  for (const a of corrections) {
    explanation.push(`${a.kind === 'bonus' ? 'Bonus' : 'Correction'} ${paySignedMoney(a.amount)}${a.note ? ` (${a.note})` : ''} on the pay for ${payWeekLabel(a.targetWeekStart)}.`);
  }

  // campaigns still waiting for their statement for this week (a paid week may have been confirmed since)
  const awaiting = result.perCampaign
    .filter((c) => !c.statementConfirmed && c.awaitsStatement !== false && c.logged > 0 && !confirmedNow.has(c.campaignId))
    .map((c) => c.code);

  return {
    basePay: result.basePay,
    commission: result.commission,
    bonus: result.bonus,
    overrides: result.overrides,
    deductions: result.deductions,
    gross: result.gross,
    userId,
    userName: `${user.firstName} ${user.lastName}`,
    weekStart: monday,
    weekEnd: sunday,
    rule,
    daysWorked,
    dayRate,
    baseAmount: result.baseAmount,
    commissionAmount: result.commissionAmount,
    paidAs: result.paidAs,
    lines: result.lines,
    salesLogged: result.salesLogged,
    salesConfirmed: result.salesConfirmed,
    salesCancelled: result.salesCancelled,
    perCampaign: result.perCampaign,
    adjustments,
    explanation,
    runId: stored ? Number(stored.id) : null,
    status: stored ? (stored.status as WeekPayBreakdown['status']) : 'estimate',
    adjustmentsTotal: result.adjustmentsTotal,
    dueDate: stored?.dueDate ?? paydayForWeek(monday),
    paidDate: stored?.paidDate ?? null,
    corrections,
    asCalculated: asPaid,
    salaried,
    awaiting,
  };
}

/** True when a live calculation still gives the run's stored figures (a 1.2 run made by the 1.2 code). */
function matchesRun(r: WeekPayResult, days: number, sales: number, run: StoredRunRow): boolean {
  return days === Number(run.daysWorked) && sales === Number(run.sales) && r.basePay === Number(run.basePay) && r.commission === Number(run.commission) &&
    r.bonus === Number(run.bonus) && r.overrides === Number(run.overrides) && r.deductions === Number(run.deductions) && r.gross === Number(run.gross);
}

/** A paid 1.2 run as it was paid, from its own columns: base, commission, plan bonus, overrides and deductions. */
function resultFromRun(run: StoredRunRow, recruiter: boolean): WeekPayResult {
  const days = Number(run.daysWorked);
  const base = round2(Number(run.basePay));
  const commission = round2(Number(run.commission));
  const bonus = round2(Number(run.bonus));
  const overrides = round2(Number(run.overrides));
  const deductions = round2(Number(run.deductions));
  const gross = round2(Number(run.gross));
  // a recruiter's `sales` column holds hires
  const sales = recruiter ? 0 : Math.max(0, Number(run.salesConfirmed ?? run.sales));
  const teamSales = Math.max(0, Number(run.teamSales));
  const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;
  const lines: WeekPayResult['lines'] = [
    { kind: 'base', label: days > 0 ? `${plural(days, 'day')} × ${payMoney(round2(base / days))}` : 'Base', quantity: days, rate: days > 0 ? round2(base / days) : 0, amount: base, paid: true },
  ];
  if (commission > 0 || sales > 0) {
    const rate = sales > 0 ? round2(commission / sales) : 0;
    lines.push({ kind: 'commission', label: sales > 0 ? `${plural(sales, 'sale')} × ${payMoney(rate)}` : 'Commission', quantity: sales, rate, amount: commission, paid: true });
  }
  if (bonus > 0) lines.push({ kind: 'bonus', label: 'Plan bonus', amount: bonus, paid: true });
  if (overrides > 0) {
    lines.push({
      kind: 'override', label: teamSales > 0 ? `Overrides: ${teamSales} team sales × ${payMoney(round2(overrides / teamSales))}` : 'Overrides',
      quantity: teamSales, rate: teamSales > 0 ? round2(overrides / teamSales) : 0, amount: overrides, paid: true,
    });
  }
  const other = round2(gross - (base + commission + bonus + overrides - deductions));
  if (other !== 0) lines.push({ kind: 'adjustment', label: 'Other changes', amount: other, paid: true });
  if (deductions > 0) lines.push({ kind: 'deduction', label: 'Deductions', amount: -deductions, paid: true });
  return {
    baseAmount: base, commissionAmount: commission, paidAs: paidAsFor(base, commission), basePay: base, commission, bonus, overrides, deductions,
    adjustmentsTotal: other, gross, salesLogged: recruiter ? 0 : Math.max(0, Number(run.sales)), salesConfirmed: sales,
    salesCancelled: recruiter ? 0 : Math.max(0, Number(run.salesCancelled ?? 0)), perCampaign: [], lines, daysWorked: days, dayRate: days > 0 ? round2(base / days) : 0,
  };
}

/** A 1.2 week in sentences: everything the plan paid, side by side. */
function planExplanation(r: WeekPayResult, ruleFrom: string, daysWorked: number): string[] {
  const out = [`This week was paid by the pay plan in use before ${payDayLabel(ruleFrom)}: base, commission, bonus and overrides added together.`];
  const base = r.lines.find((l) => l.kind === 'base');
  out.push(`Base ${payMoney(r.basePay)} (${daysWorked} day${daysWorked === 1 ? '' : 's'}${base?.rate ? ` × ${payMoney(base.rate)}` : ''}).`);
  if (r.commission > 0 || r.salesLogged > 0) out.push(`Commission ${payMoney(r.commission)} (${r.salesConfirmed} sale${r.salesConfirmed === 1 ? '' : 's'}).`);
  for (const l of r.lines) {
    if (l.kind === 'bonus') out.push(`${l.label}: ${payMoney(l.amount)}.`);
    else if (l.kind === 'override') out.push(`${l.label}: ${payMoney(l.amount)}.`);
    else if (l.kind === 'adjustment') out.push(`${l.label}: ${paySignedMoney(l.amount)}${l.note ? ` (${l.note})` : ''}.`);
    else if (l.kind === 'deduction') out.push(`Deductions: ${payMoney(l.amount)}.`);
  }
  out.push(`Total: ${payMoney(r.gross)}.`);
  return out;
}

// ───────────────────────────── statements (P3) ─────────────────────────────

interface Group {
  userId: number;
  monday: string;
  /** Per campaign; `notOnStatement` when every row for it says the person is only on the statement being replaced. */
  rows: Map<number, { confirmed: number; rowIds: number[]; notOnStatement: boolean }>;
}

/**
 * Applies a statement's confirmed subs (or previews it with dryRun). For each person and week, campaign by campaign:
 *  - an UNPAID week is recalculated live (its run follows): before and after each campaign's confirmation;
 *  - a PAID week keeps its run. Its correction is (corrected − paid): "corrected" recalculates the week from the run's
 *    own stored inputs (lib/paidWeek.ts: the day rate, rates and logged subs it was paid with) with every confirmation
 *    the week now has; "paid" is what the run paid plus the statement corrections already made for that week (any
 *    campaign — the base-or-commission choice is the whole week's, so a second campaign's statement sees the first's
 *    correction). A non-zero difference goes on the person's next unpaid week as a 'cancellation' (fewer subs than
 *    paid for) or 'statement' (more) line — one per statement, person, week and campaign, updated in place when the
 *    same statement is applied again with other figures (while its target week is unpaid).
 * Rows for unknown people or client accounts are skipped. Idempotent: the same statement applied twice changes nothing
 * the second time. Queries: one live calculation per unpaid week plus one per campaign; a paid week is calculated in
 * memory from its stored inputs.
 */
export function applyConfirmedSales(db: Db, rows: readonly ConfirmedSalesRow[], opts: ApplyConfirmedSalesOptions): ApplyResult {
  const today = todayISO();
  const dryRun = Boolean(opts.dryRun);
  const statementId = opts.statementId ?? null;
  const groups = new Map<string, Group>();
  for (const r of rows) {
    const userId = Number(r.userId);
    const campaignId = Number(r.campaignId);
    const confirmed = Number(r.confirmed);
    if (!Number.isInteger(userId) || userId <= 0 || !Number.isInteger(campaignId) || campaignId <= 0) throw badRequest('Each confirmed row needs a userId and a campaignId');
    if (typeof r.weekStart !== 'string' || !isISODate(r.weekStart)) throw badRequest('Each confirmed row needs a weekStart formatted YYYY-MM-DD');
    if (!Number.isFinite(confirmed) || confirmed < 0 || confirmed > 10_000) throw badRequest('confirmed must be a whole number of subs (0 or more)');
    const monday = mondayOf(r.weekStart);
    const key = `${userId}|${monday}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { userId, monday, rows: new Map() }));
    const prev = g.rows.get(campaignId);
    // several statement rows for one person, campaign and week add up (a per-sub statement lists each sub)
    g.rows.set(campaignId, {
      confirmed: (prev?.confirmed ?? 0) + Math.round(confirmed),
      rowIds: [...(prev?.rowIds ?? []), ...(r.statementRowIds ?? [])],
      notOnStatement: (prev?.notOnStatement ?? true) && r.notOnStatement === true,
    });
  }
  const replaces = opts.replacesStatementId ?? null;
  if (replaces !== null && (!Number.isInteger(replaces) || replaces <= 0 || replaces === statementId || statementId === null)) {
    throw badRequest('replacesStatementId must be another statement’s id');
  }
  // last week's runs exist before we decide which weeks are paid (only outside the caller's transaction)
  if (!db.isTransaction) ensurePayrollMaterialised(db, today);
  const users = runUsers(db, [...new Set([...groups.values()].map((g) => g.userId))]);
  const campaignCodes = new Map(all<{ id: number; code: string }>(db, `SELECT id, code FROM campaigns`).map((c) => [Number(c.id), c.code]));
  const ctx = payCalcContext(db);
  const people: ApplyPersonResult[] = [];
  let wrote = false;

  /** Writes the week's confirmed subs for the campaign (unchanged rows are left alone). */
  const confirm = (userId: number, campaignId: number, monday: string, confirmed: number) => {
    const prior = get<{ confirmed: number; statementId: number | null }>(
      db,
      `SELECT confirmed, statement_id AS statementId FROM sale_confirmations WHERE user_id = ? AND campaign_id = ? AND week_start = ?`,
      [userId, campaignId, monday],
    );
    if (prior && Number(prior.confirmed) === confirmed && (prior.statementId ?? null) === statementId) return;
    run(
      db,
      `INSERT INTO sale_confirmations (user_id, campaign_id, week_start, confirmed, statement_id, confirmed_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, campaign_id, week_start) DO UPDATE SET confirmed = excluded.confirmed, statement_id = excluded.statement_id, confirmed_at = excluded.confirmed_at`,
      [userId, campaignId, monday, confirmed, statementId, nowISO()],
    );
    wrote = true;
  };

  withSavepoint(db, 'p1_apply', () => {
    if (replaces !== null) {
      // a statement sent again for the same period: the corrections of the one it replaces that still wait on an
      // unpaid week become this statement's, so each is updated in place below (never a second, contradictory line)
      const handed = run(
        db,
        `UPDATE pay_adjustments SET statement_id = ?
          WHERE statement_id = ? AND kind IN ('cancellation', 'statement')
            AND NOT EXISTS (SELECT 1 FROM payroll_runs p WHERE p.user_id = pay_adjustments.user_id AND p.week_start = pay_adjustments.target_week_start AND p.status IN ('paid', 'late'))`,
        [statementId, replaces],
      ).changes;
      if (handed) wrote = true;
    }
    const resync = new Map<string, { userId: number; monday: string }>();
    const ordered = [...groups.values()].sort((a, b) => a.monday.localeCompare(b.monday) || a.userId - b.userId);
    for (const g of ordered) {
      const user = users.get(g.userId);
      if (!user) continue;
      const stored = storedRun(db, user.id, g.monday);
      const campaigns = [...g.rows].sort((a, b) => a[0] - b[0]);
      const name = `${user.firstName} ${user.lastName}`;

      if (stored && isPaidStatus(stored.status)) {
        // ── a paid week: corrected − paid, from the run's own inputs ──
        const sunday = sundayOf(g.monday);
        const extra: ExtraCampaign = (id) => ({ campaignCode: campaignCodes.get(id) ?? String(id), rate: campaignRateOn(db, id, sunday)?.repRate ?? 0 });
        const week = paidWeekOf(db, user, g.monday, stored, extra);
        const confirmations = new Map(
          all<{ campaignId: number; confirmed: number }>(db, `SELECT campaign_id AS campaignId, confirmed FROM sale_confirmations WHERE user_id = ? AND week_start = ?`, [user.id, g.monday])
            .map((c) => [Number(c.campaignId), Number(c.confirmed)]),
        );
        let corrected = round2(Number(get<{ s: number }>(
          db,
          `SELECT COALESCE(SUM(amount), 0) AS s FROM pay_adjustments WHERE user_id = ? AND source_week_start = ? AND kind IN ('cancellation', 'statement')`,
          [user.id, g.monday],
        )!.s));
        for (const [campaignId, { confirmed, notOnStatement }] of campaigns) {
          const code = campaignCodes.get(campaignId) ?? String(campaignId);
          const before = week.grossWith(confirmations);
          confirm(user.id, campaignId, g.monday, confirmed);
          confirmations.set(campaignId, confirmed);
          const after = week.grossWith(confirmations);
          const beforeGross = round2(week.paid + corrected);
          const difference = round2(after.gross - beforeGross);
          const was = week.asPaid.get(campaignId);
          const logged = was?.logged ?? 0;
          const paidFor = was?.paidFor ?? 0;
          let effect: ApplyPersonResult['effect'] = 'no-change';
          let adjustmentId: number | null = null;
          let targetWeekStart: string | null = null;
          let correctionTotal: number | undefined;
          if (difference !== 0) {
            const what = confirmed < paidFor
              ? `${paidFor - confirmed} cancelled by ${code}`
              : confirmed > paidFor ? `${confirmed - paidFor} more confirmed by ${code}` : `all ${paidFor} confirmed by ${code}`;
            // worded by the line's own total (re-review fix): an older statement re-read after a newer one can give
            // back part of what the newer one took off, so "2 cancelled" may come with a line of +£10
            const noteFor = (total: number) => notOnStatement
              ? `not on ${code}'s corrected statement: back to the ${confirmed} subs logged`
              : (confirmed < paidFor && total > 0) || (confirmed > paidFor && total < 0)
                ? `${code} confirmed ${confirmed} of the ${paidFor} paid for, which changes the week's earlier correction`
                : `${what}: paid for ${paidFor}, confirmed ${confirmed}`;
            const line = upsertStatementAdjustment(db, {
              userId: user.id, targetWeekStart: nextUnpaidWeek(db, user.id, g.monday, today), sourceWeekStart: g.monday, campaignId, statementId, amount: difference,
              noteFor, createdBy: opts.actorId ?? null,
            });
            adjustmentId = line.id;
            targetWeekStart = line.targetWeekStart;
            correctionTotal = line.amount;
            corrected = round2(corrected + difference);
            resync.set(`${user.id}|${targetWeekStart}`, { userId: user.id, monday: targetWeekStart });
            effect = 'adjustment';
            wrote = true;
          }
          const result: ApplyPersonResult = {
            userId: user.id, userName: name, campaignId, weekStart: g.monday, logged, confirmed, cancelled: Math.max(0, logged - confirmed),
            before: { gross: beforeGross, paidAs: before.paidAs }, after: { gross: round2(beforeGross + difference), paidAs: after.paidAs },
            difference, effect, adjustmentId, targetWeekStart, sentence: '',
          };
          result.sentence = applySentence({ ...result, campaignCode: code, paidFor, correctionTotal, notOnStatement });
          people.push(result);
        }
        continue;
      }

      // ── an unpaid week: recalculated live, campaign by campaign ──
      let before = computeWeek(db, user, g.monday, today, { ctx });
      if (!before) continue;
      for (const [campaignId, { confirmed, notOnStatement }] of campaigns) {
        const code = campaignCodes.get(campaignId) ?? String(campaignId);
        confirm(user.id, campaignId, g.monday, confirmed);
        const after = computeWeek(db, user, g.monday, today, { ctx })!;
        const difference = round2(after.pay.gross - before.pay.gross);
        const was = before.result.perCampaign.find((c) => c.campaignId === campaignId);
        const now = after.result.perCampaign.find((c) => c.campaignId === campaignId);
        const logged = now?.logged ?? was?.logged ?? 0;
        const result: ApplyPersonResult = {
          userId: user.id, userName: name, campaignId, weekStart: g.monday, logged, confirmed, cancelled: Math.max(0, logged - confirmed),
          before: { gross: before.pay.gross, paidAs: before.rule === 'base-or-commission' ? before.result.paidAs : null },
          after: { gross: after.pay.gross, paidAs: after.rule === 'base-or-commission' ? after.result.paidAs : null },
          difference, effect: difference !== 0 ? 'recalculated' : 'no-change', adjustmentId: null, targetWeekStart: null, sentence: '',
        };
        result.sentence = applySentence({ ...result, campaignCode: code, paidFor: was?.confirmed ?? logged, notOnStatement });
        people.push(result);
        before = after;
      }
      resync.set(`${user.id}|${g.monday}`, { userId: user.id, monday: g.monday });
    }
    for (const t of resync.values()) syncWeek(db, t.userId, t.monday, today, ctx);
  }, dryRun);

  if (!dryRun && wrote) bumpDataVersion();
  return { statementId, dryRun, applied: !dryRun && people.length > 0, people, totalDifference: round2(people.reduce((a, p) => a + p.difference, 0)) };
}

/**
 * The statement's correction line for (person, week, campaign): the same statement applied again with other figures
 * changes its own line in place while the week it sits on is unpaid (removing it when it comes to £0); otherwise a new
 * line on the target week. Its kind follows the sign of its total ('cancellation' takes money off, 'statement' adds
 * it) and its note is worded for that total. Returns the line (id null when removed), its total and the week it sits on.
 */
function upsertStatementAdjustment(db: Db, a: {
  userId: number; targetWeekStart: string; sourceWeekStart: string; campaignId: number; statementId: number | null; amount: number;
  noteFor: (total: number) => string; createdBy: number | null;
}): { id: number | null; amount: number; targetWeekStart: string } {
  const kindFor = (total: number): PayAdjustmentKind => (total < 0 ? 'cancellation' : 'statement');
  if (a.statementId !== null) {
    const existing = get<{ id: number; amount: number; target: string }>(
      db,
      `SELECT a.id, a.amount, a.target_week_start AS target FROM pay_adjustments a
       WHERE a.statement_id = ? AND a.user_id = ? AND a.source_week_start = ? AND a.campaign_id = ?
         AND NOT EXISTS (SELECT 1 FROM payroll_runs p WHERE p.user_id = a.user_id AND p.week_start = a.target_week_start AND p.status IN ('paid', 'late'))
       ORDER BY a.id DESC LIMIT 1`,
      [a.statementId, a.userId, a.sourceWeekStart, a.campaignId],
    );
    if (existing) {
      const amount = round2(Number(existing.amount) + a.amount);
      if (amount === 0) {
        run(db, `DELETE FROM pay_adjustments WHERE id = ?`, [existing.id]);
        return { id: null, amount: 0, targetWeekStart: existing.target };
      }
      run(db, `UPDATE pay_adjustments SET amount = ?, kind = ?, note = ? WHERE id = ?`, [amount, kindFor(amount), a.noteFor(amount), existing.id]);
      return { id: Number(existing.id), amount, targetWeekStart: existing.target };
    }
  }
  const id = run(
    db,
    `INSERT INTO pay_adjustments (user_id, target_week_start, source_week_start, kind, amount, note, campaign_id, statement_id, invoice_id, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
    [a.userId, a.targetWeekStart, a.sourceWeekStart, kindFor(a.amount), a.amount, a.noteFor(a.amount), a.campaignId, a.statementId, a.createdBy, nowISO()],
  ).lastInsertRowid;
  return { id, amount: a.amount, targetWeekStart: a.targetWeekStart };
}

// ───────────────────────────── campaign rates ─────────────────────────────

const RATE_SELECT = `
  SELECT r.id, r.campaign_id AS campaignId, r.rep_rate AS repRate, r.payout_rate AS payoutRate, r.effective_from AS effectiveFrom,
         r.source, r.approved_by AS approvedBy,
         CASE WHEN u.id IS NULL THEN NULL ELSE u.first_name || ' ' || u.last_name END AS approvedByName,
         r.client_post_id AS clientPostId, r.created_at AS createdAt
  FROM campaign_rates r LEFT JOIN users u ON u.id = r.approved_by`;

const mapRate = (r: CampaignRate): CampaignRate => ({ ...r, repRate: Number(r.repRate), payoutRate: Number(r.payoutRate) });

/** The rate in effect for a campaign on a date (latest effective_from ≤ date; before the history: its first row). */
export function campaignRateOn(db: Db, campaignId: number, date: string): CampaignRate | null {
  const row = get<CampaignRate>(db, `${RATE_SELECT} WHERE r.campaign_id = ? AND r.effective_from <= ? ORDER BY r.effective_from DESC, r.id DESC LIMIT 1`, [campaignId, date])
    ?? get<CampaignRate>(db, `${RATE_SELECT} WHERE r.campaign_id = ? ORDER BY r.effective_from ASC, r.id ASC LIMIT 1`, [campaignId]);
  return row ? mapRate(row) : null;
}

/** A campaign's rate history, newest first (every campaign when campaignId is omitted). */
export function listCampaignRates(db: Db, campaignId?: number | null): CampaignRate[] {
  const rows = campaignId
    ? all<CampaignRate>(db, `${RATE_SELECT} WHERE r.campaign_id = ? ORDER BY r.effective_from DESC, r.id DESC`, [campaignId])
    : all<CampaignRate>(db, `${RATE_SELECT} ORDER BY r.campaign_id, r.effective_from DESC, r.id DESC`);
  return rows.map(mapRate);
}

interface CampaignRow {
  id: number;
  rep: number;
  payout: number;
  startDate: string;
}

const campaignRow = (db: Db, id: number) =>
  get<CampaignRow>(db, `SELECT id, rep_commission_per_sale AS rep, payout_per_sale AS payout, start_date AS startDate FROM campaigns WHERE id = ?`, [id]);

/** A campaign without any history gets one first: its current rates from its start date ('seed'). */
function seedHistoryIfEmpty(db: Db, c: CampaignRow, rates: { rep: number; payout: number } = c): void {
  if (get(db, `SELECT 1 FROM campaign_rates WHERE campaign_id = ?`, [c.id])) return;
  run(
    db,
    `INSERT INTO campaign_rates (campaign_id, rep_rate, payout_rate, effective_from, source, approved_by, client_post_id, created_at) VALUES (?, ?, ?, ?, 'seed', NULL, NULL, ?)`,
    [c.id, rates.rep, rates.payout, c.startDate, nowISO()],
  );
}

const SOURCES: readonly CampaignRateSource[] = ['seed', 'admin', 'client'];

/**
 * Adds a rate to a campaign's history: an admin's entry (POST /pay/rates) or a client's commission change Matt
 * approved (P6, source 'client' with clientPostId). A missing repRate or payoutRate keeps the one in effect on the
 * date. When the new row is the one in effect today, the campaign's own rates (Campaigns form, revenue snapshots)
 * follow; a future row takes over on its date (materialisation). Unpaid weeks from the effective date in which the
 * campaign was worked are recalculated. 400 for bad figures, 404 for an unknown campaign.
 */
export function addCampaignRate(db: Db, input: CampaignRateInput, actorId: number | null): CampaignRate {
  const today = todayISO();
  const c = campaignRow(db, Number(input.campaignId));
  if (!c) throw notFound('Campaign');
  if (typeof input.effectiveFrom !== 'string' || !isISODate(input.effectiveFrom)) throw badRequest('effectiveFrom must be a date formatted YYYY-MM-DD');
  if (input.effectiveFrom > addDays(today, 366)) throw badRequest('effectiveFrom can be at most a year ahead');
  const source = input.source ?? 'admin';
  if (!SOURCES.includes(source)) throw badRequest('Unknown rate source');
  const current = campaignRateOn(db, c.id, input.effectiveFrom);
  const repRate = input.repRate === undefined || input.repRate === null ? (current?.repRate ?? c.rep) : Number(input.repRate);
  const payoutRate = input.payoutRate === undefined || input.payoutRate === null ? (current?.payoutRate ?? c.payout) : Number(input.payoutRate);
  if (!Number.isFinite(repRate) || repRate < 0 || repRate > MONEY_MAX) throw badRequest('The rep rate must be £0 or more');
  if (!Number.isFinite(payoutRate) || payoutRate <= 0 || payoutRate > MONEY_MAX) throw badRequest('The payout per sub must be more than £0');
  const id = withSavepoint(db, 'p1_rate', () => {
    seedHistoryIfEmpty(db, c);
    const newId = run(
      db,
      `INSERT INTO campaign_rates (campaign_id, rep_rate, payout_rate, effective_from, source, approved_by, client_post_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [c.id, round2(repRate), round2(payoutRate), input.effectiveFrom, source, actorId, input.clientPostId ?? null, nowISO()],
    ).lastInsertRowid;
    applyRatesInEffect(db, today, c.id);
    recalculateUnpaidRuns(db, { from: input.effectiveFrom, campaignId: c.id }, today);
    return newId;
  });
  bumpDataVersion();
  return mapRate(get<CampaignRate>(db, `${RATE_SELECT} WHERE r.id = ?`, [id])!);
}

/**
 * routes/campaigns.ts calls this after POST /campaigns (before = null) and PATCH /campaigns/:id: a new campaign's
 * history starts with its rates from its start date; a change of rep commission or payout per sale in the Campaigns
 * form adds a row effective today (the earlier rates stay for the days before). Nothing else is written.
 */
export function recordCampaignRateChange(db: Db, campaignId: number, before: Campaign | null, after: Campaign, actorId: number | null): void {
  const today = todayISO();
  if (!before) {
    if (get(db, `SELECT 1 FROM campaign_rates WHERE campaign_id = ?`, [campaignId])) return;
    run(
      db,
      `INSERT INTO campaign_rates (campaign_id, rep_rate, payout_rate, effective_from, source, approved_by, client_post_id, created_at) VALUES (?, ?, ?, ?, 'admin', ?, NULL, ?)`,
      [campaignId, after.repCommissionPerSale, after.payoutPerSale, after.startDate, actorId, nowISO()],
    );
    return;
  }
  if (before.repCommissionPerSale === after.repCommissionPerSale && before.payoutPerSale === after.payoutPerSale) return;
  // the history starts with the rates the campaign had until today
  seedHistoryIfEmpty(db, { id: campaignId, rep: before.repCommissionPerSale, payout: before.payoutPerSale, startDate: before.startDate });
  run(
    db,
    `INSERT INTO campaign_rates (campaign_id, rep_rate, payout_rate, effective_from, source, approved_by, client_post_id, created_at) VALUES (?, ?, ?, ?, 'admin', ?, NULL, ?)`,
    [campaignId, after.repCommissionPerSale, after.payoutPerSale, today, actorId, nowISO()],
  );
  recalculateUnpaidRuns(db, { from: today, campaignId }, today);
}

// ───────────────────────────── bonuses and adjustments ─────────────────────────────

export interface AdjustmentInput {
  userId: number;
  targetWeekStart: string;
  sourceWeekStart?: string | null;
  kind: PayAdjustmentKind;
  amount: number;
  note: string;
  campaignId?: number | null;
  statementId?: number | null;
  invoiceId?: number | null;
}

export function getPayAdjustment(db: Db, id: number): PayAdjustment | null {
  const row = get<PayAdjustment>(db, `${ADJUSTMENT_SELECT} WHERE a.id = ?`, [id]);
  return row ? mapAdjustment(row) : null;
}

export interface AdjustmentFilter {
  userIds?: readonly number[];
  teamId?: number | null;
  /** The week the lines land on (target). */
  weekStart?: string;
  limit?: number;
}

/** Adjustment lines, newest week first (at most 200), limited to the people in the filter. */
export function listPayAdjustments(db: Db, f: AdjustmentFilter = {}): PayAdjustment[] {
  const where: string[] = [];
  const params: Param[] = [];
  if (f.userIds) {
    if (!f.userIds.length) return [];
    where.push(`a.user_id IN (${placeholders(f.userIds.length)})`);
    params.push(...f.userIds);
  }
  if (f.teamId !== undefined && f.teamId !== null) {
    where.push(`a.user_id IN (SELECT id FROM users WHERE team_id = ?)`);
    params.push(f.teamId);
  }
  if (f.weekStart) {
    where.push(`a.target_week_start = ?`);
    params.push(mondayOf(f.weekStart));
  }
  const limit = Math.max(1, Math.min(200, Math.floor(f.limit ?? 200)));
  // the week each line lands on is already paid: the line is history (no Remove), and who it is for
  const select = ADJUSTMENT_SELECT.replace(
    'FROM pay_adjustments a',
    `, EXISTS (SELECT 1 FROM payroll_runs p WHERE p.user_id = a.user_id AND p.week_start = a.target_week_start AND p.status IN ('paid', 'late')) AS targetPaid,
       tu.first_name || ' ' || tu.last_name AS userName
     FROM pay_adjustments a JOIN users tu ON tu.id = a.user_id`,
  );
  return all<Omit<PayAdjustment, 'targetPaid'> & { targetPaid: number }>(db, `${select} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY a.target_week_start DESC, a.created_at DESC, a.id DESC LIMIT ${limit}`, params)
    .map((r) => ({ ...mapAdjustment({ ...r, targetPaid: undefined }), targetPaid: Boolean(r.targetPaid) }));
}

/** 409 unless the person's week is still unpaid. */
export function assertWeekUnpaid(db: Db, userId: number, monday: string): void {
  const s = storedRun(db, userId, monday);
  if (isPaidStatus(s?.status)) throw conflict(`The week ${payWeekLabel(monday)} has already been paid. Choose the next unpaid week.`);
}

/**
 * Adds a bonus, a manual line or a dispute settlement to an UNPAID week (409 when it is paid) and recalculates that
 * week's run. The person must be on payroll (not a client account; 400 for a salaried plan, which is not paid weekly).
 */
export function addPayAdjustment(db: Db, input: AdjustmentInput, actorId: number | null, today = todayISO()): PayAdjustment {
  const user = getUser(db, Number(input.userId));
  if (!user || user.role === 'client') throw notFound('User');
  if (!isISODate(input.targetWeekStart)) throw badRequest('The week must be a date formatted YYYY-MM-DD');
  const target = mondayOf(input.targetWeekStart);
  const source = input.sourceWeekStart ? (isISODate(input.sourceWeekStart) ? mondayOf(input.sourceWeekStart) : null) : null;
  if (input.sourceWeekStart && !source) throw badRequest('The week it corrects must be a date formatted YYYY-MM-DD');
  const amount = round2(Number(input.amount));
  if (!Number.isFinite(amount) || amount === 0 || Math.abs(amount) > MONEY_MAX) throw badRequest('The amount must be a number of pounds other than £0');
  if (input.kind === 'bonus' && amount < 0) throw badRequest('A bonus must be more than £0');
  const note = String(input.note ?? '').trim();
  if (!note) throw badRequest('Say what it is for (the person sees it on their pay)');
  if (note.length > 300) throw badRequest('Keep the note under 300 characters');
  if (target > addDays(mondayOf(today), 28)) throw badRequest('The week can be at most four weeks ahead');
  if (sundayOf(target) < user.startDate) throw badRequest(`${user.firstName} had not started by that week`);
  const ctx = payCalcContext(db);
  const plan = get<{ basePerDay: number; commissionPerSale: number }>(db, `SELECT base_per_day AS basePerDay, commission_per_sale AS commissionPerSale FROM pay_plans WHERE id = ?`, [user.payPlanId]);
  if (plan && isRuleWeek(ctx.settings, target) && !(plan.basePerDay > 0) && !(plan.commissionPerSale > 0)) {
    throw badRequest(`${user.firstName}'s pay plan is not paid weekly, so there is no pay to add this to`);
  }
  assertWeekUnpaid(db, user.id, target);
  const id = withSavepoint(db, 'p1_adjust', () => {
    const before = storedRun(db, user.id, target)?.gross ?? null;
    const newId = run(
      db,
      `INSERT INTO pay_adjustments (user_id, target_week_start, source_week_start, kind, amount, note, campaign_id, statement_id, invoice_id, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [user.id, target, source, input.kind, amount, note, input.campaignId ?? null, input.statementId ?? null, input.invoiceId ?? null, actorId, nowISO()],
    ).lastInsertRowid;
    syncWeek(db, user.id, target, today, ctx);
    // a finished week the line takes below £0 could never be paid (a week with no work passes its lines on instead)
    const landed = get<{ target: string }>(db, `SELECT target_week_start AS target FROM pay_adjustments WHERE id = ?`, [newId])!.target;
    const after = amount < 0 ? storedRun(db, user.id, landed) : undefined;
    if (after && Number(after.gross) < 0) {
      const room = landed === target && before !== null ? Number(before) : round2(Number(after.gross) - amount);
      throw badRequest(`That would take ${user.firstName}'s pay for ${payWeekLabel(landed)} below £0 (${payMoney(Number(after.gross))}). Take off at most ${payMoney(Math.max(0, room))} here and put the rest on a later week.`);
    }
    return newId;
  });
  bumpDataVersion();
  return getPayAdjustment(db, id)!;
}

/** Kinds an admin may remove by hand (statement corrections follow their statement; disputes are P2's). */
export const REMOVABLE_ADJUSTMENTS: readonly PayAdjustmentKind[] = ['bonus', 'manual'];

/**
 * Removes a bonus or manual line from an unpaid week (404 / 409 otherwise) and recalculates that week's run. Like
 * adding a line, removing one may not take a finished week below £0 (re-review fix: removing a bonus that made room
 * for a deduction used to leave the run below £0, held at Mark paid): 400, and nothing is removed.
 */
export function removePayAdjustment(db: Db, id: number, today = todayISO()): PayAdjustment {
  const a = getPayAdjustment(db, id);
  if (!a) throw notFound('Adjustment');
  if (!REMOVABLE_ADJUSTMENTS.includes(a.kind)) {
    throw conflict('This correction came from a client statement or a dispute, so it cannot be removed by hand. Add a manual adjustment to offset it.');
  }
  assertWeekUnpaid(db, a.userId, a.targetWeekStart);
  const unpaidRuns = () => all<{ week: string; gross: number }>(db, `SELECT week_start AS week, gross FROM payroll_runs WHERE user_id = ? AND status IN ('pending', 'failed') ORDER BY week_start`, [a.userId]);
  withSavepoint(db, 'p1_remove', () => {
    const before = a.amount > 0 ? new Map(unpaidRuns().map((r) => [r.week, Number(r.gross)])) : null;
    run(db, `DELETE FROM pay_adjustments WHERE id = ?`, [id]);
    syncWeek(db, a.userId, a.targetWeekStart, today);
    // the week it sat on, or the week its other lines moved on to when it was the only pay that week
    const below = before && unpaidRuns().find((r) => Number(r.gross) < 0 && Number(r.gross) < (before.get(r.week) ?? 0));
    if (below) {
      const who = getUser(db, a.userId)?.firstName ?? 'This person';
      throw badRequest(`Removing this would take ${who}'s pay for ${payWeekLabel(below.week)} below £0 (${payMoney(Number(below.gross))}), so it could not be paid. Remove or reduce the lines that take money off that week first.`);
    }
  });
  bumpDataVersion();
  return a;
}

/** HttpError and applyRatesInEffect re-exported for callers that only import this module (P6's approval). */
export { HttpError, applyRatesInEffect };
/** paidAsFor re-exported for server code that only imports this module. */
export { paidAsFor };
