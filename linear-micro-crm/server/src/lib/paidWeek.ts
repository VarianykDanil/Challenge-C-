/**
 * Release 1.3 — OWNED BY P1 pay-rule (review fix). A PAID week as it was paid, for a statement that arrives after
 * payment (lib/payRule.ts applyConfirmedSales): the lead's rule is "the difference (corrected pay − paid pay) becomes an
 * adjustment line on the person's next unpaid invoice". So the week is recalculated from the run's OWN stored inputs —
 * the day rate, the campaign rates, the logged subs, the bonuses, the corrections and the deductions it was paid with
 * (payroll_runs.breakdown_json, lib/payWeek.ts snapshotOf) — with the statement's confirmed subs, never from gauges,
 * rates or a day rate changed since. Reads only; one query at most (a 1.2 run's live gauges).
 *
 *  - A 1.3 week: shared calculateWeekPay on the stored inputs. A run stored before the inputs were kept (P1's first
 *    build) is rebuilt from its own per-campaign figures (logged, paid for, the average rate per sub).
 *  - A 1.2 plan week calculated by 1.3: the stored plan, the sales and team sales it paid on.
 *  - A 1.2 run made by the 1.2 code (no stored calculation): the run's own columns (days, sales, team sales,
 *    deductions) with the person's plan; 1.2 paid on the logged sales, which the run's `sales` column holds. The split
 *    of those sales per campaign comes from today's gauges, exact unless gauges at several campaigns were changed
 *    after payment (then the difference is put on the campaigns with the most sales).
 * Every figure is anchored on what was paid: gross(confirmations) = paid + calc(confirmations) − calc(as paid), so a
 * statement that confirms exactly what was paid for changes nothing, whatever the rounding or the plan of the day.
 */
import { calculatePayroll, calculateWeekPay, round2, type PaidAs, type PayPlan, type WeekConfirmation, type WeekPaySale } from '@lm/shared';
import { getPayPlan } from '../db/queries.ts';
import type { Db } from '../db/connection.ts';
import { loadWeekFacts, parseSnapshot, type PayUser, type RunSnapshot, type SnapshotInputs } from './payWeek.ts';

/** The stored run columns a paid week is read from. */
export interface PaidRunColumns {
  gross: number;
  deductions: number;
  daysWorked: number;
  sales: number;
  teamSales: number;
  breakdownJson: string | null;
  /** What the run paid in commission and plan bonus (a 1.2 run is corrected at the rate it was paid at). */
  commission?: number;
  bonus?: number;
}

export interface PaidWeek {
  /** What the run paid (its gross). */
  paid: number;
  rule: 'base-or-commission' | 'plan';
  /** Per campaign: the subs logged when the week was paid, and the subs it was paid for. */
  asPaid: ReadonlyMap<number, { logged: number; paidFor: number }>;
  /**
   * The week's gross with these confirmed subs per campaign (every other campaign as paid), anchored on `paid`; the
   * paid-as of a 1.3 week (null for a plan week).
   */
  grossWith(confirmed: ReadonlyMap<number, number>): { gross: number; paidAs: PaidAs | null };
}

/** The code and the rate for a campaign confirmed in a week the person logged none of its subs. */
export type ExtraCampaign = (campaignId: number) => { campaignCode: string; rate: number };

export function paidWeekOf(db: Db, user: PayUser, monday: string, run: PaidRunColumns, extra: ExtraCampaign): PaidWeek {
  const paid = round2(Number(run.gross));
  const snap = parseSnapshot(run.breakdownJson);
  if (snap?.rule === 'base-or-commission') return ruleWeek(snap, monday, paid, extra);
  if (snap?.rule === 'plan' && snap.inputs?.plan) return storedPlanWeek(snap, paid);
  return legacyPlanWeek(db, user, monday, run, paid);
}

const constant = (paid: number, paidAs: PaidAs | null, rule: PaidWeek['rule'], asPaid: PaidWeek['asPaid']): PaidWeek => ({
  paid, rule, asPaid, grossWith: () => ({ gross: paid, paidAs }),
});

function asPaidOf(snap: RunSnapshot): Map<number, { logged: number; paidFor: number }> {
  return new Map(snap.result.perCampaign.map((c) => [c.campaignId, { logged: c.logged, paidFor: c.confirmed }]));
}

/** A run stored before its inputs were kept: one row per campaign at the week's average rate per sub. */
function inputsFromFigures(snap: RunSnapshot, monday: string): SnapshotInputs {
  const sales: WeekPaySale[] = snap.result.perCampaign.map((c) => ({
    campaignId: c.campaignId, campaignCode: c.code, date: monday, logged: c.logged, rate: c.rate, awaitsStatement: c.awaitsStatement !== false,
  }));
  const confirmations: WeekConfirmation[] = snap.result.perCampaign
    .filter((c) => c.statementConfirmed)
    .map((c) => ({ campaignId: c.campaignId, confirmed: c.confirmed, campaignCode: c.code, rate: c.rate }));
  return { sales, confirmations, deductions: snap.result.deductions };
}

function ruleWeek(snap: RunSnapshot, monday: string, paid: number, extra: ExtraCampaign): PaidWeek {
  const asPaid = asPaidOf(snap);
  if (snap.salaried) return constant(paid, snap.result.paidAs, 'base-or-commission', asPaid);
  const inputs = snap.inputs ?? inputsFromFigures(snap, monday);
  const bonuses = snap.adjustments.filter((a) => a.kind === 'bonus');
  const others = snap.adjustments.filter((a) => a.kind !== 'bonus');
  const calc = (confirmations: readonly WeekConfirmation[]) =>
    calculateWeekPay({ dayRate: snap.dayRate, daysWorked: snap.daysWorked, sales: inputs.sales, confirmations, bonuses, adjustments: others, deductions: inputs.deductions });
  const asCalculated = calc(inputs.confirmations).gross;
  const rates = new Map(inputs.sales.map((s) => [s.campaignId, { campaignCode: s.campaignCode, rate: s.rate }]));
  return {
    paid,
    rule: 'base-or-commission',
    asPaid,
    grossWith(confirmed) {
      const byCampaign = new Map(inputs.confirmations.map((c) => [c.campaignId, c]));
      for (const [campaignId, n] of confirmed) {
        const known = byCampaign.get(campaignId) ?? rates.get(campaignId) ?? extra(campaignId);
        byCampaign.set(campaignId, { ...known, campaignId, confirmed: n });
      }
      const r = calc([...byCampaign.values()]);
      return { gross: round2(paid + r.gross - asCalculated), paidAs: r.paidAs };
    },
  };
}

/** A 1.2 plan's maths on (days, sales, team sales) — the delta of two of these moves a plan week. */
function planGross(plan: Pick<PayPlan, 'basePerDay' | 'commissionPerSale' | 'bonusThreshold' | 'bonusAmount' | 'overridePerTeamSale'>, days: number, sales: number, teamSales: number, deductions: number): number {
  return calculatePayroll({ id: 0, name: '', position: 'field_rep', ...plan }, { daysWorked: days, sales: Math.max(0, sales), teamSales, deductions }).gross;
}

function planWeek(
  paid: number,
  asPaid: Map<number, { logged: number; paidFor: number }>,
  gross: ((sales: number) => number) | null,
  salesPaid: number,
): PaidWeek {
  if (!gross) return constant(paid, null, 'plan', asPaid);
  const asCalculated = gross(salesPaid);
  return {
    paid,
    rule: 'plan',
    asPaid,
    grossWith(confirmed) {
      let sales = salesPaid;
      for (const [campaignId, n] of confirmed) sales += n - (asPaid.get(campaignId)?.paidFor ?? 0);
      return { gross: round2(paid + gross(sales) - asCalculated), paidAs: null };
    },
  };
}

function storedPlanWeek(snap: RunSnapshot, paid: number): PaidWeek {
  const p = snap.inputs!.plan!;
  const deductions = snap.inputs!.deductions;
  // a recruiter is paid on hires: subs never move their pay
  const gross = p.hires !== null ? null : (sales: number) => planGross(p, snap.daysWorked, sales, p.teamSales, deductions);
  return planWeek(paid, asPaidOf(snap), gross, p.sales);
}

function legacyPlanWeek(db: Db, user: PayUser, monday: string, run: PaidRunColumns, paid: number): PaidWeek {
  const facts = loadWeekFacts(db, user, monday);
  const live = new Map<number, number>();
  for (const s of facts.sales) live.set(s.campaignId, (live.get(s.campaignId) ?? 0) + s.logged);
  const salesPaid = Math.max(0, Math.round(Number(run.sales)));
  // the run's sales per campaign: today's gauges, put back to the run's total when gauges changed after payment
  const split = new Map(live);
  let gap = salesPaid - [...live.values()].reduce((a, n) => a + n, 0);
  const order = [...live.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([id]) => id);
  for (const id of order) {
    if (gap === 0) break;
    const n = split.get(id)!;
    const next = Math.max(0, n + gap);
    gap -= next - n;
    split.set(id, next);
  }
  const asPaid = new Map([...split].map(([id, n]) => [id, { logged: n, paidFor: n }]));
  const plan = getPayPlan(db, user.payPlanId);
  const gross = !plan || facts.hires !== null
    ? null
    : (sales: number) => planGross(asPaidPlan(plan, run, salesPaid), Number(run.daysWorked), sales, Number(run.teamSales), Number(run.deductions));
  return planWeek(paid, asPaid, gross, salesPaid);
}

/**
 * The plan a 1.2 run was paid by, as far as its own columns tell (re-review fix: the person may have moved to another
 * plan since): the commission per sale it paid (commission ÷ sales), and its plan bonus — kept at today's plan's
 * threshold when that plan pays the same bonus, else held as paid. Only what moves with the sales matters (the week
 * is anchored on what was paid); with no sales paid, today's plan is all there is to go on.
 */
function asPaidPlan(plan: PayPlan, run: PaidRunColumns, salesPaid: number): PayPlan {
  const commission = Number(run.commission);
  const bonus = Number(run.bonus);
  const out = { ...plan };
  if (salesPaid > 0 && Number.isFinite(commission)) out.commissionPerSale = round2(commission / salesPaid);
  if (Number.isFinite(bonus) && bonus > 0) {
    const sameBonus = plan.bonusAmount === bonus && plan.bonusThreshold > 0 && plan.bonusThreshold <= salesPaid;
    out.bonusAmount = bonus;
    out.bonusThreshold = sameBonus ? plan.bonusThreshold : 0;
  }
  return out;
}
