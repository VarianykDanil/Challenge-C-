import { Router } from 'express';
import { z } from 'zod';
import {
  avgDaysLate,
  marginAmount,
  onTimeRate,
  round2,
  type CampaignFinance,
  type Expense,
  type FinanceSummary,
  type FinanceWeek,
  type PayPlan,
  type PayrollRunWithUser,
  type UserWithTeam,
} from '@lm/shared';
import { all, get, placeholders, run, type Db } from '../db/connection.ts';
import { ensurePayrollMaterialised } from '../db/maintenance.ts';
import { EXPENSE_SELECT, PAY_PLAN_SELECT, Where, getExpense, getPayPlan, getPayroll, getUser, listGauges, listPayroll } from '../db/queries.ts';
import { addDays, eachMonday, mondayOf, sundayOf, todayISO } from '../lib/dates.ts';
import { badRequest, forbidden, notFound } from '../lib/errors.ts';
import { GAUGE_COMMISSION_SQL, GAUGE_FROM, GAUGE_PAYOUT_SQL, MONDAY_SQL, mondayOfSql } from '../lib/metrics.ts';
import { withInvoiceSummaries } from '../lib/invoices.ts';
import { markPayrollRunPaid } from '../lib/markPaid.ts';
import { withPaymentStatus } from '../lib/payments/batches.ts';
import { estimateWeekPayroll, nextPay } from '../lib/pay.ts';
import { payRuleSettings, rateOnSql } from '../lib/payWeek.ts';
import { redactPayroll } from '../lib/scope.ts';
import { smartEnabled } from '../lib/smart/enabled.ts';
import { weekPayForecast } from '../lib/smart/payForecast.ts';
import { payrollFlagsFor } from '../lib/smart/payrollFlags.ts';
import { idParam, isoDate, moneyAmount, optionalIdQuery, optionalString, parseRange } from '../lib/validate.ts';
import { currentUser, requireRole } from '../middleware/auth.ts';

const PAYROLL_STATUSES = ['pending', 'paid', 'late', 'failed'] as const;
const EXPENSE_CATEGORIES = ['venue', 'travel', 'office', 'software', 'recruitment', 'marketing', 'other'] as const;

const expenseBody = z.object({
  date: isoDate,
  category: z.enum(EXPENSE_CATEGORIES),
  amount: moneyAmount, // > 0 and ≤ MONEY_MAX, finite
  description: z.string().trim().min(1).max(500),
  campaignId: z.number().int().positive().nullable().optional().default(null),
  eventId: z.number().int().positive().nullable().optional().default(null),
});

function last12Weeks(today: string): { from: string; to: string } {
  return { from: addDays(mondayOf(today), -12 * 7), to: today };
}

/**
 * Smart release 1.1 (p3): advisory `flags` on unpaid (pending / failed) runs, for admins only. Nothing is attached —
 * not even the key — for other roles, other statuses, runs without flags, or when the kill switch is off.
 */
function withPayrollFlags<T extends PayrollRunWithUser>(db: Db, rows: T[], me: UserWithTeam): T[] {
  if (me.role !== 'admin' || !smartEnabled()) return rows;
  const unpaid = rows.filter((r) => r.status === 'pending' || r.status === 'failed');
  if (!unpaid.length) return rows;
  const flags = payrollFlagsFor(db, unpaid, me);
  if (!flags.size) return rows;
  return rows.map((r) => ((r.status === 'pending' || r.status === 'failed') && flags.has(r.id) ? { ...r, flags: flags.get(r.id)! } : r));
}

export function financeRouter(db: Db): Router {
  const router = Router();

  // ── payroll list ──
  router.get('/payroll', (req, res) => {
    const me = currentUser(req);
    const today = todayISO();
    ensurePayrollMaterialised(db, today);
    const { from, to } = parseRange(req.query, last12Weeks(today));
    const userId = optionalIdQuery(req.query.userId, 'userId');
    const teamId = optionalIdQuery(req.query.teamId, 'teamId');
    const status = optionalString(req.query.status);
    const statuses = status ? status.split(',').map((s) => s.trim()).filter(Boolean) : [];
    if (status && (!statuses.length || statuses.some((s) => !PAYROLL_STATUSES.includes(s as (typeof PAYROLL_STATUSES)[number])))) throw badRequest('Invalid status');
    // A failed transfer is still owed whatever its age: when `status` asks for failed runs and no range is given (the
    // Runs to pay card), they are listed from any week; everything else keeps the 12-week default.
    const failedAnyAge = statuses.includes('failed') && req.query.from === undefined && req.query.to === undefined;
    const where = failedAnyAge
      ? new Where().add(`(p.week_start BETWEEN ? AND ? OR p.status = 'failed')`, from, to)
      : new Where().add('p.week_start BETWEEN ? AND ?', from, to);
    // one status or a comma list, e.g. status=pending,failed for "everything still to pay"
    if (statuses.length) where.add(`p.status IN (${placeholders(statuses.length)})`, ...statuses);
    if (me.role === 'rep' || me.role === 'recruiter') {
      if (userId && userId !== me.id) throw forbidden('You can only view your own payroll');
      where.add('p.user_id = ?', me.id);
    } else if (me.role === 'leader') {
      if (userId) {
        const target = getUser(db, userId);
        if (!target || (target.id !== me.id && (me.teamId === null || target.teamId !== me.teamId))) throw forbidden('Leaders can only view payroll for their own team');
        where.add('p.user_id = ?', userId);
      } else if (me.teamId === null) {
        where.add('p.user_id = ?', me.id);
      } else {
        where.add('(u.team_id = ? OR p.user_id = ?)', me.teamId, me.id);
      }
    } else {
      if (userId) where.add('p.user_id = ?', userId);
      if (teamId) where.add('u.team_id = ?', teamId);
    }
    // Release 1.3 (P2): each run carries its self-billing invoice summary once one is issued (lib/invoices.ts).
    // Release 1.4 (F): unpaid runs carry their latest payment from Linear Hub for the admin (lib/payments/batches.ts).
    res.json(withPaymentStatus(db, withInvoiceSummaries(db, withPayrollFlags(db, listPayroll(db, `${where}`, where.params).map((r) => redactPayroll(me, r)), me), me), me));
  });

  // ── my earnings ── (declared before /payroll/:id so the literal path wins)
  router.get('/me', (req, res) => {
    const me = currentUser(req);
    const today = todayISO();
    ensurePayrollMaterialised(db, today);
    const weeksRaw = Number(req.query.weeks ?? 12);
    const weeks = Number.isInteger(weeksRaw) && weeksRaw > 0 ? Math.min(weeksRaw, 104) : 12;
    const since = addDays(mondayOf(today), -weeks * 7);
    const runs = withInvoiceSummaries(db, listPayroll(db, 'WHERE p.user_id = ? AND p.week_start >= ?', [me.id, since]), me);
    const settled = runs.filter((r) => r.paidDate !== null);
    const pay = nextPay(db, me, today);
    res.json({
      runs,
      totals: {
        gross: round2(runs.reduce((a, r) => a + r.gross, 0)),
        commission: round2(runs.reduce((a, r) => a + r.commission, 0)),
        onTimeRate: settled.length ? round2(onTimeRate(settled)) : null,
      },
      nextPayday: pay.nextPayday,
      nextPayAmount: pay.nextPayAmount,
      // Smart release 1.1 (p3): an estimate only — never written to payroll_runs; nextPayAmount stays official.
      forecast: smartEnabled() ? weekPayForecast(db, me, today) : null,
    });
  });

  // Pay plans are HR-sensitive: admins see them all, everyone else only the plan they are on (an array of one).
  router.get('/pay-plans', (req, res) => {
    const me = currentUser(req);
    if (me.role === 'admin') return res.json(all<PayPlan>(db, `${PAY_PLAN_SELECT} ORDER BY id`));
    res.json(all<PayPlan>(db, `${PAY_PLAN_SELECT} WHERE id = ?`, [me.payPlanId]));
  });

  // ── payslip ──
  router.get('/payroll/:id', (req, res) => {
    const me = currentUser(req);
    const run_ = getPayroll(db, idParam(req));
    if (!run_) throw notFound('Payroll run');
    const target = getUser(db, run_.userId);
    if (!target) throw notFound('User');
    const allowed = me.role === 'admin' || run_.userId === me.id || (me.role === 'leader' && me.teamId !== null && target.teamId === me.teamId);
    if (!allowed) throw forbidden('You cannot view this payslip');
    const plan = getPayPlan(db, target.payPlanId);
    const entries = listGauges(db, 'WHERE g.user_id = ? AND g.date BETWEEN ? AND ?', [run_.userId, run_.weekStart, run_.weekEnd], 'g.date ASC');
    const [shown] = withInvoiceSummaries(db, withPayrollFlags(db, [redactPayroll(me, run_)], me), me);
    res.json({ ...shown!, plan, entries });
  });

  router.post('/payroll/:id/pay', requireRole('admin'), (req, res) => {
    // Release 1.4 (F): the same path a payment made from Linear Hub uses (lib/markPaid.ts), unchanged
    res.json(markPayrollRunPaid(db, idParam(req), { actor: currentUser(req), body: req.body ?? {} }));
  });

  // ── summary ──
  router.get('/summary', requireRole('admin', 'leader'), (req, res) => {
    const me = currentUser(req);
    const today = todayISO();
    const { from, to } = parseRange(req.query, last12Weeks(today));
    const teamId = me.role === 'leader' ? me.teamId : null;
    if (me.role === 'leader' && teamId === null) throw forbidden('You are not assigned to a team');
    ensurePayrollMaterialised(db, today);
    res.json(financeSummary(db, from, to, teamId, today));
  });

  // ── expenses ──
  router.get('/expenses', requireRole('admin'), (req, res) => {
    const today = todayISO();
    const { from, to } = parseRange(req.query, last12Weeks(today));
    const where = new Where().add('date BETWEEN ? AND ?', from, to);
    const category = optionalString(req.query.category);
    if (category) {
      if (!EXPENSE_CATEGORIES.includes(category as (typeof EXPENSE_CATEGORIES)[number])) throw badRequest('Invalid category');
      where.add('category = ?', category);
    }
    const campaignId = optionalIdQuery(req.query.campaignId, 'campaignId');
    if (campaignId) where.add('campaign_id = ?', campaignId);
    res.json(all<Expense>(db, `${EXPENSE_SELECT} ${where} ORDER BY date DESC, id DESC`, where.params));
  });

  router.post('/expenses', requireRole('admin'), (req, res) => {
    const body = expenseBody.parse(req.body);
    if (body.campaignId !== null && !get(db, `SELECT 1 FROM campaigns WHERE id = ?`, [body.campaignId])) throw badRequest('Unknown campaignId');
    if (body.eventId !== null && !get(db, `SELECT 1 FROM events WHERE id = ?`, [body.eventId])) throw badRequest('Unknown eventId');
    const r = run(db, `INSERT INTO expenses (date, category, amount, description, campaign_id, event_id) VALUES (?, ?, ?, ?, ?, ?)`, [
      body.date, body.category, round2(body.amount), body.description, body.campaignId, body.eventId,
    ]);
    res.status(201).json(getExpense(db, r.lastInsertRowid));
  });

  router.delete('/expenses/:id', requireRole('admin'), (req, res) => {
    const id = idParam(req);
    if (!getExpense(db, id)) throw notFound('Expense');
    run(db, `DELETE FROM expenses WHERE id = ?`, [id]);
    res.status(204).end();
  });

  return router;
}

/**
 * Company-wide (teamId null) or team-scoped finance summary.
 *
 * Payroll runs are weekly (Mon–Sun), so the requested window is snapped outwards to whole pay weeks
 * (`mondayOf(from)` … `sundayOf(to)`) and revenue, payroll and expenses are all measured over those identical days —
 * a month preset therefore never charges a full week's wages against four days of revenue, and adjacent months never
 * double-count a run. The response's `from`/`to` are the snapped window. A week that has started but has no runs yet
 * (the week in progress) is charged at the live estimate and flagged `estimated`.
 */
export function financeSummary(db: Db, from: string, to: string, teamId: number | null, today = todayISO()): FinanceSummary {
  const wkFrom = mondayOf(from);
  const wkTo = sundayOf(to);
  const teamGauge = teamId ? ' AND u.team_id = ?' : '';
  const teamPayroll = teamId ? ' AND u.team_id = ?' : '';
  const teamExpense = teamId ? ' AND x.event_id IN (SELECT id FROM events WHERE team_id = ?)' : '';
  const tp = (): (number | string)[] => (teamId ? [teamId] : []);
  const latestRunWeek = get<{ w: string | null }>(db, `SELECT MAX(week_start) AS w FROM payroll_runs`)!.w ?? '';

  // One GROUP BY pay-week query per series (revenue, payroll, expenses) over the whole window, stitched per Monday in
  // JS — the same figures as one query per week, without 3 × N round trips. Revenue uses the payout captured on each
  // entry when it was logged, so changing a campaign's payout only affects future days.
  const byWeek = <T extends { wk: string }>(rows: T[]) => new Map(rows.map((r) => [r.wk, r]));
  const revenueByWeek = byWeek(all<{ wk: string; revenue: number; sales: number }>(
    db,
    `SELECT ${MONDAY_SQL} AS wk, COALESCE(SUM(g.sales * ${GAUGE_PAYOUT_SQL}), 0) AS revenue, COALESCE(SUM(g.sales), 0) AS sales
     ${GAUGE_FROM} WHERE g.date BETWEEN ? AND ?${teamGauge} GROUP BY wk`,
    [wkFrom, wkTo, ...tp()],
  ));
  const payrollByWeek = byWeek(all<{ wk: string; payroll: number; runs: number }>(
    db,
    `SELECT p.week_start AS wk, COALESCE(SUM(p.gross), 0) AS payroll, COUNT(*) AS runs
     FROM payroll_runs p JOIN users u ON u.id = p.user_id WHERE p.week_start BETWEEN ? AND ?${teamPayroll} GROUP BY wk`,
    [wkFrom, wkTo, ...tp()],
  ));
  const expensesByWeek = byWeek(all<{ wk: string; expenses: number }>(
    db,
    `SELECT ${mondayOfSql('x.date')} AS wk, COALESCE(SUM(x.amount), 0) AS expenses FROM expenses x WHERE x.date BETWEEN ? AND ?${teamExpense} GROUP BY wk`,
    [wkFrom, wkTo, ...tp()],
  ));

  const weeks: FinanceWeek[] = [];
  for (const monday of eachMonday(wkFrom, wkTo)) {
    const g = revenueByWeek.get(monday) ?? { wk: monday, revenue: 0, sales: 0 };
    const p = payrollByWeek.get(monday) ?? { wk: monday, payroll: 0, runs: 0 };
    const x = expensesByWeek.get(monday) ?? { wk: monday, expenses: 0 };
    const revenue = round2(Number(g.revenue));
    const expenses = round2(Number(x.expenses));
    const week: FinanceWeek = { weekStart: monday, revenue, payroll: round2(Number(p.payroll)), expenses, profit: 0, sales: Number(g.sales) };
    // No runs yet for a week that has started and lies after the last materialised week → the week in progress.
    if (Number(p.runs) === 0 && monday <= today && monday > latestRunWeek) {
      week.payroll = estimateWeekPayroll(db, monday, teamId, today);
      week.estimated = true;
    }
    week.profit = round2(revenue - week.payroll - expenses);
    weeks.push(week);
  }
  const totals = weeks.reduce(
    (acc, w) => ({
      revenue: round2(acc.revenue + w.revenue),
      payroll: round2(acc.payroll + w.payroll),
      expenses: round2(acc.expenses + w.expenses),
      profit: round2(acc.profit + w.profit),
      sales: acc.sales + w.sales,
    }),
    { revenue: 0, payroll: 0, expenses: 0, profit: 0, sales: 0 },
  );

  // Commission is what the reps earn on each campaign's sales. Release 1.3 (P1): for pay weeks from PAY_RULE_FROM it is
  // the sales at the campaign's rep rate in effect on each day (campaign_rates) — the commission value of the subs,
  // whether that week paid the commission or the base; before it, the pay-plan rate captured on each entry when it
  // was logged (the figure 1.2 payroll used). Margin = revenue − that commission, in pounds.
  const ruleFrom = payRuleSettings(db).ruleFrom;
  const byCampaign = all<{ campaignId: number; campaignName: string; campaignColor: string; sales: number; revenue: number; commission: number }>(
    db,
    `SELECT c.id AS campaignId, c.name AS campaignName, c.color AS campaignColor,
            COALESCE(SUM(g.sales), 0) AS sales,
            COALESCE(SUM(g.sales * ${GAUGE_PAYOUT_SQL}), 0) AS revenue,
            COALESCE(SUM(g.sales * CASE WHEN ${MONDAY_SQL} >= ? THEN ${rateOnSql('e.campaign_id', 'g.date', 'c.rep_commission_per_sale')} ELSE ${GAUGE_COMMISSION_SQL} END), 0) AS commission
     ${GAUGE_FROM}
     JOIN pay_plans pp ON pp.id = u.pay_plan_id
     WHERE g.date BETWEEN ? AND ?${teamGauge} GROUP BY c.id ORDER BY revenue DESC`,
    [ruleFrom, wkFrom, wkTo, ...tp()],
  ).map<CampaignFinance>((r) => ({
    ...r,
    revenue: round2(Number(r.revenue)),
    commission: round2(Number(r.commission)),
    margin: marginAmount(Number(r.revenue), Number(r.commission)), // pounds, not a fraction
  }));

  // paid = money has landed (status paid OR late); late = the subset paid after the due date;
  // failed is derived by the UI as runs − paid − pending.
  const runs = listPayroll(db, `WHERE p.week_start BETWEEN ? AND ?${teamPayroll}`, [wkFrom, wkTo, ...tp()]);
  const settled = runs.filter((r) => r.status === 'paid' || r.status === 'late');
  const late = settled.filter((r) => r.status === 'late');
  const pendingRuns = runs.filter((r) => r.status === 'pending');

  const expensesByCategory = all<{ category: FinanceSummary['expensesByCategory'][number]['category']; amount: number }>(
    db,
    `SELECT x.category, COALESCE(SUM(x.amount), 0) AS amount FROM expenses x WHERE x.date BETWEEN ? AND ?${teamExpense} GROUP BY x.category ORDER BY amount DESC`,
    [wkFrom, wkTo, ...tp()],
  ).map((r) => ({ category: r.category, amount: round2(Number(r.amount)) }));

  return {
    from: wkFrom,
    to: wkTo,
    totals,
    weeks,
    byCampaign,
    payroll: {
      runs: runs.length,
      paid: settled.length,
      pending: pendingRuns.length,
      late: late.length,
      onTimeRate: round2(onTimeRate(settled)),
      avgDaysLate: round2(avgDaysLate(settled)),
    },
    expensesByCategory,
  };
}

