import { auditMoney, auditWeekLabel, payDayLabel, paydayForWeek, round2, type UserWithTeam } from '@lm/shared';
import { all, get, run, transaction, type Db } from './connection.ts';
import { recordSystemEvent } from '../lib/audit/events.ts';
import { bumpDataVersion } from '../lib/cache.ts';
import { addDays, isoWeek, mondayOf, nowHHMM, nowISO, sundayOf, todayISO } from '../lib/dates.ts';
import { conflict } from '../lib/errors.ts';
import { payableUsers, weekPayFor, type PayUser, type WeekPay } from '../lib/pay.ts';
import { payCalcContext, ruleColumnsOf, type PayCalcContext, type RuleColumns } from '../lib/payWeek.ts';

/**
 * Keep event statuses honest as the clock moves: past `scheduled`/`live` events become `completed`, and today's
 * `scheduled` events become `live` once their start time has passed (not before). Cancelled events are left alone.
 * Release 1.3 (P1, review fix): the same 15-minute sweep makes a campaign rate dated today the campaign's own
 * (applyDatedRates), so the revenue snapshot on the day's first gauges already uses it; it used to wait for the daily
 * payroll materialisation, up to a day late.
 */
export function rollForwardEventStatuses(db: Db, today = todayISO(), now = nowHHMM()): { completed: number; live: number; rates?: number } {
  const completed = run(db, `UPDATE events SET status = 'completed' WHERE status IN ('scheduled', 'live') AND date < ?`, [today]).changes;
  const live = run(db, `UPDATE events SET status = 'live' WHERE status = 'scheduled' AND date = ? AND start_time <= ?`, [today, now]).changes;
  if (completed || live) bumpDataVersion();
  const rates = applyDatedRates(db, today);
  return rates ? { completed, live, rates } : { completed, live };
}

// ── payroll runs ─────────────────────────────────────────────────────────────

type RunUser = PayUser & { employeeId: string };

interface StoredRun {
  id: number;
  status: string;
  deductions: number;
  daysWorked: number;
  sales: number;
  teamSales: number;
  basePay: number;
  commission: number;
  bonus: number;
  overrides: number;
  gross: number;
  paidAs: string | null;
  salesLogged: number | null;
  salesConfirmed: number | null;
  salesCancelled: number | null;
  adjustmentsTotal: number | null;
  breakdownJson: string | null;
}

const RUN_SELECT = `
  SELECT id, status, deductions, days_worked AS daysWorked, sales, team_sales AS teamSales, base_pay AS basePay,
         commission, bonus, overrides, gross, paid_as AS paidAs, sales_logged AS salesLogged,
         sales_confirmed AS salesConfirmed, sales_cancelled AS salesCancelled, adjustments_total AS adjustmentsTotal,
         breakdown_json AS breakdownJson
  FROM payroll_runs WHERE user_id = ? AND week_start = ?`;
/** Release 1.3 (P1): the run's columns; the 1.3 ones (paid_as …) stay NULL for a week paid by the 1.2 plan rules. */
export const INSERT_RUN = `
  INSERT INTO payroll_runs
    (user_id, week_start, week_end, days_worked, sales, team_sales, base_pay, commission, bonus, overrides, deductions, gross, due_date, paid_date, status, reference,
     paid_as, sales_logged, sales_confirmed, sales_cancelled, adjustments_total, breakdown_json)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
const UPDATE_RUN = `
  UPDATE payroll_runs SET days_worked = ?, sales = ?, team_sales = ?, base_pay = ?, commission = ?, bonus = ?, overrides = ?, gross = ?,
    paid_as = ?, sales_logged = ?, sales_confirmed = ?, sales_cancelled = ?, adjustments_total = ?, breakdown_json = ?
  WHERE id = ?`;

export const PAID_WEEK_MESSAGE = 'This week has already been paid — ask an administrator to adjust';

/** True when the person's run for the pay week containing `date` has been paid (`paid` or `late`). */
export function isWeekPaidFor(db: Db, userId: number, date: string): boolean {
  return Boolean(get(db, `SELECT 1 FROM payroll_runs WHERE user_id = ? AND week_start = ? AND status IN ('paid', 'late')`, [userId, mondayOf(date)]));
}

/**
 * Gauge writes for a week whose run has already been paid are refused with `409` unless the writer is an admin — an
 * admin's change goes through and flags the run `adjusted_at` so the payslip can say "adjusted after payment".
 */
export function assertWeekUnpaidFor(db: Db, me: UserWithTeam, userId: number, date: string): void {
  if (me.role === 'admin') return;
  if (isWeekPaidFor(db, userId, date)) throw conflict(PAID_WEEK_MESSAGE);
}

export type RunSync = 'created' | 'updated' | 'deleted' | 'unchanged' | 'flagged' | 'skipped';

/** The figures a run stores for a calculated week (deductions already taken off `gross`). */
export interface RunFigures {
  daysWorked: number;
  sales: number;
  teamSales: number;
  basePay: number;
  commission: number;
  bonus: number;
  overrides: number;
  gross: number;
  rule: RuleColumns;
}

export function runFiguresOf(w: WeekPay): RunFigures {
  return {
    daysWorked: w.daysWorked, sales: w.sales, teamSales: w.teamSales, basePay: w.pay.basePay, commission: w.pay.commission,
    bonus: w.pay.bonus, overrides: w.pay.overrides, gross: w.pay.gross, rule: ruleColumnsOf(w.week),
  };
}

/**
 * The first week after `monday` whose run is still open: no run yet, or a pending one. Paid and late runs are money
 * that already landed, and a failed transfer is money already in flight, so neither takes a new line (review fix: the
 * lines used to go on the following week even when it was paid, where nobody ever paid or took them off).
 */
export function nextOpenWeek(db: Db, userId: number, monday: string): string {
  const closed = new Set(
    all<{ w: string }>(db, `SELECT week_start AS w FROM payroll_runs WHERE user_id = ? AND week_start > ? AND status IN ('paid', 'late', 'failed')`, [userId, monday]).map((r) => r.w),
  );
  let week = addDays(monday, 7);
  while (closed.has(week)) week = addDays(week, 7);
  return week;
}

/**
 * Release 1.3: a completed week the person did not work whose only lines are corrections taking it to £0 or below
 * (a statement cancelled subs of an earlier week, or a line put on a week with no work): the lines move on to the
 * person's next open week (nextOpenWeek: never a paid one), so what is owed comes off a week that has pay. A leaver's
 * lines stay where they are (their run shows what they owe). Returns the week the lines moved to, or null.
 */
export function carryForwardCorrections(db: Db, userId: number, monday: string, w: WeekPay | null): string | null {
  return carryForward(db, userId, monday, w)?.target ?? null;
}

/** carryForwardCorrections with the lines it moved (their ids), for the audit row. */
function carryForward(db: Db, userId: number, monday: string, w: WeekPay | null): { target: string; ids: number[] } | null {
  if (!w || w.rule !== 'base-or-commission') return null;
  const wk = w.week;
  if (!wk.hasAdjustments || wk.daysWorked > 0 || wk.result.salesLogged > 0 || wk.facts.confirmations.length > 0) return null;
  if (round2(wk.result.gross + wk.result.deductions) > 0) return null;
  const status = get<{ status: string }>(db, `SELECT status FROM users WHERE id = ?`, [userId])?.status;
  if (status === 'left') return null;
  const ids = all<{ id: number }>(db, `SELECT id FROM pay_adjustments WHERE user_id = ? AND target_week_start = ? ORDER BY id`, [userId, monday]).map((r) => Number(r.id));
  if (!ids.length) return null;
  const target = nextOpenWeek(db, userId, monday);
  run(db, `UPDATE pay_adjustments SET target_week_start = ? WHERE user_id = ? AND target_week_start = ?`, [target, userId, monday]);
  return { target, ids };
}

/**
 * The audit row for corrections Linear Hub moved on from a week with no work (re-review fix: decision 10 covers its
 * own automatic steps). One row for the whole move, from the week the lines were on to where they ended up (a run of
 * empty or paid weeks moves them several times): "Moved 1 correction (−£20) for Megan Shaw from w/c 5 Oct to w/c
 * 19 Oct: no work that week". Written in the caller's transaction, so a preview that is rolled back leaves none.
 */
function recordCarryForward(db: Db, userId: number, from: string, ids: readonly number[]): void {
  const rows = all<{ target: string; n: number; total: number }>(
    db,
    `SELECT target_week_start AS target, COUNT(*) AS n, COALESCE(SUM(amount), 0) AS total FROM pay_adjustments WHERE id IN (${ids.map(() => '?').join(', ')}) GROUP BY target_week_start ORDER BY target_week_start`,
    [...ids],
  );
  if (!rows.length) return;
  const name = get<{ name: string }>(db, `SELECT TRIM(first_name || ' ' || last_name) AS name FROM users WHERE id = ?`, [userId])?.name ?? 'Someone';
  const signed = (n: number) => (n < 0 ? `−${auditMoney(-n)}` : auditMoney(n));
  const n = rows.reduce((a, r) => a + Number(r.n), 0);
  const total = round2(rows.reduce((a, r) => a + Number(r.total), 0));
  const to = rows.map((r) => auditWeekLabel(r.target)).join(' and ');
  recordSystemEvent(db, {
    name: 'pay.carry_forward',
    summary: `Moved ${n} correction${n === 1 ? '' : 's'} (${signed(total)}) for ${name} from ${auditWeekLabel(from)} to ${to}: no work that week`,
    entity: 'pay_adjustment',
    entityId: ids.length === 1 ? ids[0]! : null,
    after: { userId, fromWeekStart: from, toWeekStart: rows.at(-1)!.target, adjustmentIds: [...ids], total },
  });
}

/** Whether a calculated week gets (or keeps) a run: something to pay, or a bonus / correction line on it (1.3). */
export function runIsDue(w: WeekPay | null, deductions = 0): w is WeekPay {
  if (!w) return false;
  return round2(w.pay.gross + deductions) > 0 || (w.rule === 'base-or-commission' && w.week.hasAdjustments);
}

/**
 * Brings one person's run for the Mon–Sun week starting `monday` in line with the gauges, by the same rules as the
 * seed and the live estimates (`weekPayFor`):
 *  - a week still in progress (or a week before the person started) is left alone (`skipped`);
 *  - a paid run (`paid`/`late`) is never recomputed — money already landed — but with `flagPaid` it is marked
 *    `adjusted_at` so finance can see the figures no longer match the gauges;
 *  - an unpaid run (`pending`/`failed`) is recomputed in place, keeping its status, due date, reference and any
 *    deductions; it is removed when nothing is payable any more (1.3: a run with a bonus or correction line stays,
 *    even when the correction takes it to £0 or below, so the money owed either way is never lost);
 *  - a complete week with payable work and no run yet gets a `pending` run.
 * Release 1.3: a week from PAY_RULE_FROM also stores paid_as, the subs logged / confirmed / cancelled, the adjustments
 * total and the calculation itself (breakdown_json), which a paid run keeps as paid.
 */
export function syncPayrollRun(db: Db, user: RunUser, monday: string, today = todayISO(), opts: { flagPaid?: boolean; ctx?: PayCalcContext; carried?: boolean } = {}): RunSync {
  const sunday = sundayOf(monday);
  if (!(sunday < today) || user.startDate > sunday) return 'skipped';
  const existing = get<StoredRun>(db, RUN_SELECT, [user.id, monday]);
  if (existing && (existing.status === 'paid' || existing.status === 'late')) {
    if (!opts.flagPaid) return 'skipped';
    run(db, `UPDATE payroll_runs SET adjusted_at = ? WHERE id = ?`, [nowISO(), existing.id]);
    return 'flagged';
  }
  const deductions = existing?.deductions ?? 0;
  const w = weekPayFor(db, user, monday, today, { ctx: opts.ctx, deductions });
  const moved = carryForward(db, user.id, monday, w);
  if (moved) {
    // the corrections now sit on a later week: bring its run (when that week is complete) in line too
    syncPayrollRun(db, user, moved.target, today, { ctx: opts.ctx, carried: true });
    // one audit row for the whole move, written where it started (the later week may have moved them on again)
    if (!opts.carried) recordCarryForward(db, user.id, monday, moved.ids);
    if (!existing) return 'unchanged';
    run(db, `DELETE FROM payroll_runs WHERE id = ?`, [existing.id]);
    return 'deleted';
  }
  if (!runIsDue(w, deductions)) {
    if (!existing) return 'unchanged';
    run(db, `DELETE FROM payroll_runs WHERE id = ?`, [existing.id]);
    return 'deleted';
  }
  const f = runFiguresOf(w);
  const r = f.rule;
  if (!existing) {
    insertRun(db, user, monday, f, { deductions: 0, paidDate: null, status: 'pending' });
    return 'created';
  }
  if (
    existing.daysWorked === f.daysWorked && existing.sales === f.sales && existing.teamSales === f.teamSales &&
    existing.basePay === f.basePay && existing.commission === f.commission && existing.bonus === f.bonus &&
    existing.overrides === f.overrides && existing.gross === f.gross && existing.paidAs === r.paidAs &&
    existing.salesLogged === r.salesLogged && existing.salesConfirmed === r.salesConfirmed &&
    existing.salesCancelled === r.salesCancelled && existing.adjustmentsTotal === r.adjustmentsTotal &&
    existing.breakdownJson === r.breakdownJson
  ) return 'unchanged';
  run(db, UPDATE_RUN, [
    f.daysWorked, f.sales, f.teamSales, f.basePay, f.commission, f.bonus, f.overrides, f.gross,
    r.paidAs, r.salesLogged, r.salesConfirmed, r.salesCancelled, r.adjustmentsTotal, r.breakdownJson, existing.id,
  ]);
  return 'updated';
}

/** Inserts a run for a calculated week (the seed passes its own status, paid date and deductions). Returns its id. */
export function insertRun(
  db: Db,
  user: { id: number; employeeId: string },
  monday: string,
  f: RunFigures,
  o: { deductions: number; paidDate: string | null; status: string },
): number {
  const { year, week } = isoWeek(monday);
  const r = f.rule;
  return run(db, INSERT_RUN, [
    user.id, monday, sundayOf(monday), f.daysWorked, f.sales, f.teamSales,
    f.basePay, f.commission, f.bonus, f.overrides, o.deductions, f.gross,
    paydayForWeek(monday), o.paidDate, o.status, `PAY-${year}${String(week).padStart(2, '0')}-${user.employeeId}`,
    r.paidAs, r.salesLogged, r.salesConfirmed, r.salesCancelled, r.adjustmentsTotal, r.breakdownJson,
  ]).lastInsertRowid;
}

/**
 * Everyone whose pay for the week moves when the entry (user, event) changes: the entry's owner, the leaders of the
 * owner's team (overrides on team sales) and the no-team seniors (owner / assistant owner) who attended the event
 * (their override counts other reps' sales at the events they ran).
 */
export function affectedPayUsers(db: Db, entry: { userId: number; eventId: number }): RunUser[] {
  return all<RunUser>(
    db,
    `SELECT u.id, u.employee_id AS employeeId, u.team_id AS teamId, u.pay_plan_id AS payPlanId, u.role, u.start_date AS startDate
     FROM users u JOIN pay_plans pp ON pp.id = u.pay_plan_id
     WHERE u.id = ?
        OR (pp.override_per_team_sale > 0 AND u.team_id IS NOT NULL AND u.team_id = (SELECT team_id FROM users WHERE id = ?))
        OR (pp.override_per_team_sale > 0 AND u.team_id IS NULL AND EXISTS (SELECT 1 FROM gauge_entries g WHERE g.user_id = u.id AND g.event_id = ?))
     ORDER BY u.id`,
    [entry.userId, entry.userId, entry.eventId],
  );
}

/**
 * After a gauge entry was created, changed or deleted (inside the caller's transaction): recompute the unpaid runs
 * of everyone affected for that pay week, create the run when the week is complete and had none, and flag paid runs
 * as adjusted. Returns what happened per affected person.
 */
export function syncPayrollForEntry(db: Db, entry: { userId: number; eventId: number; date: string }, today = todayISO()): RunSync[] {
  const monday = mondayOf(entry.date);
  const ctx = payCalcContext(db);
  return affectedPayUsers(db, entry).map((u) => syncPayrollRun(db, u, monday, today, { flagPaid: true, ctx }));
}

export interface MaterialiseResult {
  created: number;
  /** unpaid runs whose figures were brought back in line with the gauges */
  updated: number;
  /** unpaid runs removed because nothing was payable any more */
  deleted: number;
}

/**
 * Payroll materialisation, run at start-up, once a day and from the finance guard:
 *  1. creates the `pending` runs for every completed Mon–Sun week after the latest run (or from the first gauge week
 *     when there are none) — one run per payable user with gross > 0, due on the Friday after the week ends
 *     (`paydayForWeek`), reference `PAY-<ISO year><ISO week>-<employeeId>`;
 *  2. recomputes the unpaid runs of the last two completed weeks from the gauges (idempotent upsert), so late or
 *     corrected entries reach pay even when no request-path sync saw them. Paid runs are never touched.
 */
export function materialisePayrollRuns(db: Db, today = todayISO()): MaterialiseResult {
  const result: MaterialiseResult = { created: 0, updated: 0, deleted: 0 };
  const firstGauge = get<{ d: string | null }>(db, `SELECT MIN(date) AS d FROM gauge_entries`)!.d;
  if (!firstGauge) return result;
  const firstWeek = mondayOf(firstGauge);
  const latest = get<{ w: string | null }>(db, `SELECT MAX(week_start) AS w FROM payroll_runs`)!.w;
  const mondays = new Set<string>();
  for (let monday = latest ? addDays(latest, 7) : firstWeek; sundayOf(monday) < today; monday = addDays(monday, 7)) mondays.add(monday);
  const lastCompleted = addDays(mondayOf(today), -7);
  for (const monday of [lastCompleted, addDays(lastCompleted, -7)]) if (monday >= firstWeek) mondays.add(monday);
  const ctx = payCalcContext(db);
  let rates = 0;
  transaction(db, () => {
    // Release 1.3 (P1): a campaign rate dated today or earlier takes over the campaign's own rates
    rates = applyDatedRates(db, today, { bump: false });
    for (const monday of [...mondays].sort()) {
      if (!(sundayOf(monday) < today)) continue;
      for (const u of payableUsers(db, monday)) {
        const r = syncPayrollRun(db, u, monday, today, { ctx });
        if (r === 'created') result.created++;
        else if (r === 'updated') result.updated++;
        else if (r === 'deleted') result.deleted++;
      }
    }
  });
  if (result.created || result.updated || result.deleted || rates) bumpDataVersion();
  return result;
}

interface RateTakeover {
  id: number;
  code: string;
  rep: number;
  payout: number;
  rateRep: number;
  ratePayout: number;
  from: string;
}

/** Makes each campaign's own rates equal to its history row in effect today; returns what changed. */
function takeOverRates(db: Db, today: string, campaignId?: number): RateTakeover[] {
  const rows = all<{ id: number; code: string; rep: number; payout: number; rateRep: number | null; ratePayout: number | null; from: string | null }>(
    db,
    `SELECT c.id, c.code, c.rep_commission_per_sale AS rep, c.payout_per_sale AS payout, r.rep_rate AS rateRep, r.payout_rate AS ratePayout, r.effective_from AS "from"
     FROM campaigns c
     LEFT JOIN campaign_rates r ON r.id = (SELECT x.id FROM campaign_rates x WHERE x.campaign_id = c.id AND x.effective_from <= ? ORDER BY x.effective_from DESC, x.id DESC LIMIT 1)
     ${campaignId ? 'WHERE c.id = ?' : ''}`,
    campaignId ? [today, campaignId] : [today],
  );
  const changed: RateTakeover[] = [];
  for (const r of rows) {
    if (r.rateRep === null || r.ratePayout === null) continue;
    if (Number(r.rateRep) === Number(r.rep) && Number(r.ratePayout) === Number(r.payout)) continue;
    run(db, `UPDATE campaigns SET rep_commission_per_sale = ?, payout_per_sale = ? WHERE id = ?`, [r.rateRep, r.ratePayout, r.id]);
    changed.push({ id: Number(r.id), code: r.code, rep: Number(r.rep), payout: Number(r.payout), rateRep: Number(r.rateRep), ratePayout: Number(r.ratePayout), from: String(r.from) });
  }
  return changed;
}

/**
 * Keeps each campaign's own rates (campaigns.rep_commission_per_sale / payout_per_sale: the Campaigns form and the
 * revenue snapshot on new gauge rows) equal to the history row in effect today. Run right after a rate is added
 * (lib/payRule.ts: that write is audited by its route). Returns the campaigns updated.
 */
export function applyRatesInEffect(db: Db, today = todayISO(), campaignId?: number): number {
  return takeOverRates(db, today, campaignId).length;
}

/**
 * The automatic step (review fix): a rate dated in the future takes over on its day, from the 15-minute sweep
 * (rollForwardEventStatuses) and the daily materialisation. Each takeover is recorded in the audit trail as Linear Hub
 * ("SYSTEM pay.rates": "BCN rate from Mon 2 Nov in effect: £20 a sub to the rep (was £18), …"). Returns the campaigns
 * updated; bumps the data version unless `bump` is false (the caller bumps).
 */
export function applyDatedRates(db: Db, today = todayISO(), opts: { bump?: boolean } = {}): number {
  const changed = takeOverRates(db, today);
  for (const r of changed) {
    const part = (now: number, was: number, what: string) => `${auditMoney(now)} ${what}${now === was ? '' : ` (was ${auditMoney(was)})`}`;
    recordSystemEvent(db, {
      name: 'pay.rates',
      summary: `${r.code} rate from ${payDayLabel(r.from)} in effect: ${part(r.rateRep, r.rep, 'a sub to the rep')}, ${part(r.ratePayout, r.payout, 'payout')}`,
      entity: 'campaign',
      entityId: r.id,
      after: { repCommissionPerSale: r.rateRep, payoutPerSale: r.ratePayout, effectiveFrom: r.from },
    });
  }
  if (changed.length && opts.bump !== false) bumpDataVersion();
  return changed.length;
}

/** Request-path guard: materialise only when the last completed week has no runs yet (one cheap query otherwise). */
export function ensurePayrollMaterialised(db: Db, today = todayISO()): number {
  const latest = get<{ w: string | null }>(db, `SELECT MAX(week_start) AS w FROM payroll_runs`)!.w;
  const lastCompleted = addDays(mondayOf(today), -7);
  if (latest !== null && latest >= lastCompleted) return 0;
  return materialisePayrollRuns(db, today).created;
}
