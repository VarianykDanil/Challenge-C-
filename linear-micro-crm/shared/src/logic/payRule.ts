/**
 * Release 1.3 — OWNED BY P1 pay-rule (laid down by r3-foundation). The 1.3 pay rule as pure functions (decision 2,
 * quoted in shared/src/types/pay.ts): base = day rate × days worked; commission = the week's paid subs × each
 * campaign's rate in effect on the sale's date; paid the base when commission < base, else the commission (a tie pays
 * commission); manual bonus lines, deductions and adjustments from earlier weeks on top. No automatic bonus, no
 * automatic overrides.
 *
 *   baseAmount       = round2(dayRate × daysWorked)
 *   commissionAmount = Σ over campaigns and rate periods of round2(paid subs × rep rate on those days)
 *   paidAs           = paidAsFor(baseAmount, commissionAmount)            (commission ≥ base → commission)
 *   basePay          = paidAs = 'base' ? baseAmount : 0;  commission = paidAs = 'commission' ? commissionAmount : 0
 *   gross            = basePay + commission + Σ bonuses + Σ adjustments − deductions
 *
 * Paid subs per campaign: the client's confirmed figure for the week when a statement confirmed it, else the logged
 * subs. A confirmed figure below the logged one takes the cancellations off the LATEST days first (the same rule as a
 * statement covering several weeks: from the latest week back), so with a mid-week rate change the later rate loses
 * the subs; a confirmed figure above the logged one pays the extra subs at the latest day's rate.
 */
import type { PaidAs, PayAdjustment, PayLine, WeekCampaignPay } from '../types/pay.ts';
import { dayOfWeek } from './dates.ts';
import { round2 } from './finance.ts';

/** Decision 2: commission ≥ base → commission; below → base. */
export function paidAsFor(baseAmount: number, commissionAmount: number): PaidAs {
  return commissionAmount >= baseAmount ? 'commission' : 'base';
}

/** One campaign's subs on one day, at the rep rate in effect that day. */
export interface WeekPaySale {
  campaignId: number;
  campaignCode: string;
  /** P1: shown in the office's views (optional). */
  campaignName?: string;
  date: string;
  logged: number;
  /** Confirmed by a statement; null/undefined while not confirmed (the logged figure is used). */
  confirmed?: number | null;
  /** £ per sub on that date (campaign_rates). */
  rate: number;
  /**
   * P1: false for a campaign whose client sends no statements (nothing will confirm it, so it is never "not yet
   * confirmed"). Default true.
   */
  awaitsStatement?: boolean;
}

/** P1: a statement's confirmed subs for one campaign and the whole week (sale_confirmations). */
export interface WeekConfirmation {
  campaignId: number;
  confirmed: number;
  /** Only needed when the person logged no subs for that campaign in the week (the extra subs need a code and a rate). */
  campaignCode?: string;
  campaignName?: string;
  rate?: number;
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
  /** P1: per-campaign confirmed subs for the week; they take precedence over the rows' own `confirmed`. */
  confirmations?: readonly WeekConfirmation[];
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
  /** P1: the inputs the sentences need (always set by calculateWeekPay). */
  daysWorked?: number;
  dayRate?: number;
}

// ───────────────────────────── words and numbers ─────────────────────────────

const GBP = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "£1,234.50"; negatives with a real minus sign, "−£20.00". Always pence (pay is exact). */
export function payMoney(n: number): string {
  const v = round2(Number.isFinite(n) ? n : 0);
  const s = GBP.format(Math.abs(v));
  return v < 0 ? `−${s}` : s;
}

/** "+£20.00" / "−£20.00" / "£0.00": a correction's sign always shows. */
export function paySignedMoney(n: number): string {
  const v = round2(Number.isFinite(n) ? n : 0);
  return v > 0 ? `+${payMoney(v)}` : payMoney(v);
}

/** "2026-10-14" → "Wed 14 Oct". */
export function payDayLabel(date: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(date);
  if (!m) return date;
  return `${DAYS[dayOfWeek(date.slice(0, 10))]} ${Number(m[3])} ${MONTHS[Number(m[2]) - 1] ?? m[2]}`;
}

/** "2026-10-05" → "w/c 5 Oct". */
export function payWeekLabel(weekStart: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(weekStart);
  return m ? `w/c ${Number(m[3])} ${MONTHS[Number(m[2]) - 1] ?? m[2]}` : weekStart;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const subs = (n: number) => plural(n, 'sub');
/** "BCN", "BCN and CHN", "BCN, CHN and VLT". */
function andList(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}
const stripStop = (s: string) => s.trim().replace(/[.!?]+$/, '');
const whole = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0);
const money = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) ? n : 0);

/** The line label of an adjustment: "Correction for w/c 21 Sep", "Dispute settled for w/c 5 Oct", "Adjustment". */
export function adjustmentLabel(a: Pick<PayAdjustment, 'kind' | 'sourceWeekStart'>): string {
  const forWeek = a.sourceWeekStart ? ` for ${payWeekLabel(a.sourceWeekStart)}` : '';
  switch (a.kind) {
    case 'cancellation':
    case 'statement':
      return `Correction${forWeek}`;
    case 'dispute':
      return `Dispute settled${forWeek}`;
    case 'bonus':
      return 'Bonus';
    default:
      return `Adjustment${forWeek}`;
  }
}

// ───────────────────────────── the week ─────────────────────────────

interface Day {
  date: string;
  rate: number;
  logged: number;
  paid: number;
}

interface CampaignWork {
  campaignId: number;
  code: string;
  name?: string;
  days: Day[];
  statementConfirmed: boolean;
  awaitsStatement: boolean;
}

/** Takes `cancel` subs off the latest days first; returns paid subs per day (same order). */
function cancelFromLatest(days: readonly Day[], cancel: number): number[] {
  const paid = days.map((d) => d.logged);
  let left = cancel;
  for (let i = paid.length - 1; i >= 0 && left > 0; i--) {
    const take = Math.min(paid[i]!, left);
    paid[i]! -= take;
    left -= take;
  }
  return paid;
}

/** The 1.3 rule for one person's week (see the header). Pure and deterministic. */
export function calculateWeekPay(input: WeekPayInput): WeekPayResult {
  const dayRate = Math.max(0, money(input.dayRate));
  const daysWorked = Math.min(7, whole(input.daysWorked));
  const baseAmount = round2(dayRate * daysWorked);

  // Group the sales by campaign, each campaign's days in date order.
  const byCampaign = new Map<number, CampaignWork>();
  for (const s of input.sales) {
    let c = byCampaign.get(s.campaignId);
    if (!c) byCampaign.set(s.campaignId, (c = { campaignId: s.campaignId, code: s.campaignCode, name: s.campaignName, days: [], statementConfirmed: false, awaitsStatement: s.awaitsStatement !== false }));
    const logged = whole(s.logged);
    const rate = Math.max(0, money(s.rate));
    const hasOwn = s.confirmed !== null && s.confirmed !== undefined;
    if (hasOwn) c.statementConfirmed = true;
    const existing = c.days.find((d) => d.date === s.date && d.rate === rate);
    const paid = hasOwn ? whole(s.confirmed) : logged;
    if (existing) {
      existing.logged += logged;
      existing.paid += paid;
    } else c.days.push({ date: s.date, rate, logged, paid });
  }
  for (const c of byCampaign.values()) c.days.sort((a, b) => a.date.localeCompare(b.date));

  // A week-level confirmation replaces the logged figure for that campaign.
  for (const conf of input.confirmations ?? []) {
    const confirmed = whole(conf.confirmed);
    let c = byCampaign.get(conf.campaignId);
    if (!c) {
      byCampaign.set(conf.campaignId, (c = { campaignId: conf.campaignId, code: conf.campaignCode ?? String(conf.campaignId), name: conf.campaignName, days: [], statementConfirmed: true, awaitsStatement: true }));
    }
    c.statementConfirmed = true;
    const logged = c.days.reduce((a, d) => a + d.logged, 0);
    if (confirmed <= logged) {
      const paid = cancelFromLatest(c.days, logged - confirmed);
      c.days.forEach((d, i) => (d.paid = paid[i]!));
    } else {
      c.days.forEach((d) => (d.paid = d.logged));
      const extra = confirmed - logged;
      const last = c.days[c.days.length - 1];
      if (last) last.paid += extra;
      else c.days.push({ date: '', rate: Math.max(0, money(conf.rate)), logged: 0, paid: extra });
    }
  }

  const perCampaign: WeekCampaignPay[] = [];
  const commissionLines: PayLine[] = [];
  const campaigns = [...byCampaign.values()].sort((a, b) => a.code.localeCompare(b.code) || a.campaignId - b.campaignId);
  for (const c of campaigns) {
    // Days with no subs logged and none paid say nothing (a worked day at a campaign without a sale).
    const days = c.days.filter((d) => d.logged > 0 || d.paid > 0);
    const logged = days.reduce((a, d) => a + d.logged, 0);
    const confirmed = days.reduce((a, d) => a + d.paid, 0);
    if (logged === 0 && confirmed === 0) continue;
    // Rate periods: consecutive days at the same rate pay as one line.
    const allPeriods: { rate: number; quantity: number; from: string; to: string }[] = [];
    for (const d of days) {
      const last = allPeriods[allPeriods.length - 1];
      if (last && last.rate === d.rate) {
        last.quantity += d.paid;
        if (d.date) last.to = d.date;
      } else allPeriods.push({ rate: d.rate, quantity: d.paid, from: d.date, to: d.date });
    }
    // A period whose subs were all cancelled pays nothing: list it only when nothing else is left to show.
    const kept = allPeriods.filter((p) => p.quantity > 0);
    const periods = kept.length ? kept : allPeriods.slice(-1);
    let amount = 0;
    const many = allPeriods.length > 1;
    const cancelled = Math.max(0, logged - confirmed);
    periods.forEach((p, i) => {
      const lineAmount = round2(p.quantity * p.rate);
      amount = round2(amount + lineAmount);
      const first = p === allPeriods[0];
      const when = !many || !p.from ? '' : first ? ` (to ${payDayLabel(p.to)})` : ` (from ${payDayLabel(p.from)})`;
      const notes: string[] = [];
      if (i === 0 && cancelled > 0) notes.push(`${logged} logged, ${cancelled} cancelled by ${c.code}`);
      if (i === 0 && confirmed > logged) notes.push(`${logged} logged, ${confirmed - logged} more confirmed by ${c.code}`);
      if (i === 0 && !c.statementConfirmed && c.awaitsStatement && logged > 0) notes.push(`not yet confirmed by ${c.code}`);
      commissionLines.push({
        kind: 'commission',
        label: `${c.code}: ${subs(p.quantity)} × ${payMoney(p.rate)}${when}`,
        quantity: p.quantity,
        rate: p.rate,
        amount: lineAmount,
        paid: false, // set below once paidAs is known
        campaignId: c.campaignId,
        campaignCode: c.code,
        ...(notes.length ? { note: notes.join('; ') } : {}),
      });
    });
    const latestRate = periods.length ? periods[periods.length - 1]!.rate : 0;
    perCampaign.push({
      campaignId: c.campaignId,
      code: c.code,
      ...(c.name ? { name: c.name } : {}),
      logged,
      confirmed,
      cancelled,
      statementConfirmed: c.statementConfirmed,
      ...(c.awaitsStatement ? {} : { awaitsStatement: false }),
      rate: confirmed > 0 ? round2(amount / confirmed) : latestRate,
      amount,
    });
  }

  const commissionAmount = round2(perCampaign.reduce((a, c) => a + c.amount, 0));
  const paidAs = paidAsFor(baseAmount, commissionAmount);
  const basePay = paidAs === 'base' ? baseAmount : 0;
  const commission = paidAs === 'commission' ? commissionAmount : 0;

  const lines: PayLine[] = [
    { kind: 'base', label: `${plural(daysWorked, 'day')} × ${payMoney(dayRate)}`, quantity: daysWorked, rate: dayRate, amount: baseAmount, paid: paidAs === 'base' },
    ...commissionLines.map((l) => ({ ...l, paid: paidAs === 'commission' })),
  ];

  let bonus = 0;
  for (const b of input.bonuses ?? []) {
    const amount = round2(money(b.amount));
    bonus = round2(bonus + amount);
    const note = stripStop(b.note ?? '');
    lines.push({ kind: 'bonus', label: note ? `Bonus: ${note}` : 'Bonus', amount, paid: true, adjustmentId: b.id, ...(note ? { note } : {}) });
  }

  let adjustmentsTotal = 0;
  for (const a of input.adjustments ?? []) {
    if (a.kind === 'bonus') continue; // bonuses come in `bonuses`
    const amount = round2(money(a.amount));
    adjustmentsTotal = round2(adjustmentsTotal + amount);
    const note = stripStop(a.note ?? '');
    lines.push({
      kind: 'adjustment',
      label: adjustmentLabel(a),
      amount,
      paid: true,
      adjustmentId: a.id,
      ...(a.sourceWeekStart ? { sourceWeekStart: a.sourceWeekStart } : {}),
      ...(a.campaignId ? { campaignId: a.campaignId } : {}),
      ...(a.campaignCode ? { campaignCode: a.campaignCode } : {}),
      ...(note ? { note } : {}),
    });
  }

  const deductions = round2(Math.max(0, money(input.deductions)));
  if (deductions > 0) lines.push({ kind: 'deduction', label: 'Deductions', amount: -deductions, paid: true });

  const salesLogged = perCampaign.reduce((a, c) => a + c.logged, 0);
  const salesConfirmed = perCampaign.reduce((a, c) => a + c.confirmed, 0);
  return {
    baseAmount,
    commissionAmount,
    paidAs,
    basePay,
    commission,
    bonus,
    overrides: 0,
    deductions,
    adjustmentsTotal,
    gross: round2(basePay + commission + bonus + adjustmentsTotal - deductions),
    salesLogged,
    salesConfirmed,
    salesCancelled: perCampaign.reduce((a, c) => a + c.cancelled, 0),
    perCampaign,
    lines,
    daysWorked,
    dayRate,
  };
}

// ───────────────────────────── the sentences ─────────────────────────────

export interface PayExplanationOptions {
  /** Whose week it is, for the office's views ("Jordan worked 4 days"); omitted → "You worked 4 days". */
  name?: string;
  /**
   * Campaign codes whose statement for this week arrived after it was paid (a stored, paid calculation): their
   * subs read "not confirmed by BCN when paid" rather than "not yet confirmed by BCN".
   */
  confirmedSince?: readonly string[];
}

/**
 * The breakdown in sentences, e.g. "You worked 4 days: base £254.00." · "Commission: 16 subs paid (18 logged, 2
 * cancelled by BCN) = £160.00." · "Commission was below your base, so you're paid the base: £254.00." — or
 * "Commission £375.00 beat your base £317.50, so you're paid the commission." Then one sentence per bonus, adjustment
 * and the deductions, and the total when any of those changed it.
 */
export function payExplanation(week: WeekPayResult, opts: PayExplanationOptions = {}): string[] {
  const who = opts.name?.trim() || null;
  const subject = who ?? 'You';
  const your = who ? 'the' : 'your';
  const paidVerb = who ? `${who} is paid` : "you're paid";
  const out: string[] = [];
  const days = week.daysWorked ?? (week.lines.find((l) => l.kind === 'base')?.quantity ?? 0);

  out.push(days > 0 ? `${subject} worked ${plural(days, 'day')}: base ${payMoney(week.baseAmount)}.` : `No days worked this week, so no base.`);

  const logged = week.salesLogged;
  const confirmed = week.salesConfirmed;
  if (logged === 0 && confirmed === 0) {
    out.push('No subs logged this week, so no commission.');
  } else {
    const cancelledParts = week.perCampaign.filter((c) => c.cancelled > 0).map((c) => `${c.cancelled} cancelled by ${c.code}`);
    const extraParts = week.perCampaign.filter((c) => c.confirmed > c.logged).map((c) => `${c.confirmed - c.logged} more confirmed by ${c.code}`);
    const clean = week.perCampaign.filter((c) => c.statementConfirmed && c.cancelled === 0 && c.confirmed <= c.logged && c.logged > 0).map((c) => c.code);
    const pending = week.perCampaign.filter((c) => !c.statementConfirmed && c.awaitsStatement !== false && c.logged > 0).map((c) => c.code);
    const groups: string[] = [];
    if (cancelledParts.length || extraParts.length) groups.push([`${logged} logged`, ...cancelledParts, ...extraParts].join(', '));
    if (clean.length) groups.push(`confirmed by ${andList(clean)}`);
    const since = new Set(opts.confirmedSince ?? []);
    const pendingNow = pending.filter((code) => !since.has(code));
    const pendingThen = pending.filter((code) => since.has(code));
    if (pendingNow.length) groups.push(`not yet confirmed by ${andList(pendingNow)}`);
    if (pendingThen.length) groups.push(`not confirmed by ${andList(pendingThen)} when paid`);
    const anyConfirmed = week.perCampaign.some((c) => c.statementConfirmed);
    out.push(`Commission: ${subs(confirmed)}${anyConfirmed ? ' paid' : ''}${groups.length ? ` (${groups.join('; ')})` : ''} = ${payMoney(week.commissionAmount)}.`);
  }

  const b = week.baseAmount;
  const c = week.commissionAmount;
  if (b === 0 && c === 0) out.push("Nothing to pay from this week's work.");
  else if (week.paidAs === 'base') out.push(`Commission was below ${your} base, so ${paidVerb} the base: ${payMoney(b)}.`);
  else if (b === 0) out.push(`${who ? `${who} is` : "You're"} paid the commission: ${payMoney(c)}.`);
  else if (c === b) out.push(`Commission ${payMoney(c)} matched ${your} base, so ${paidVerb} the commission.`);
  else out.push(`Commission ${payMoney(c)} beat ${your} base ${payMoney(b)}, so ${paidVerb} the commission.`);

  let extras = false;
  for (const l of week.lines) {
    if (l.kind === 'bonus') {
      extras = true;
      out.push(l.note ? `Bonus ${payMoney(l.amount)}: ${l.note}.` : `Bonus: ${payMoney(l.amount)}.`);
    } else if (l.kind === 'adjustment') {
      extras = true;
      out.push(`${l.label}: ${paySignedMoney(l.amount)}${l.note ? ` (${l.note})` : ''}.`);
    } else if (l.kind === 'deduction') {
      extras = true;
      out.push(`Deductions: ${payMoney(l.amount)}.`);
    }
  }
  if (extras) out.push(`Total: ${payMoney(week.gross)}.`);
  return out;
}

/**
 * How a statement changes one person's week, in one sentence (applyConfirmedSales → ApplyPersonResult.sentence):
 *  adjustment    "Paid for 18, 2 cancelled by BCN, so −£20.00 on the pay for w/c 19 Oct."
 *                "BCN confirmed all 18 subs paid for, which changes the week's earlier correction: +£20.00 on the pay for
 *                w/c 26 Oct." (the week's correction for another campaign or an earlier statement is undone)
 *                "Paid for 30, 2 cancelled by BCN, which changes the week's earlier correction: +£10.00 on the pay for
 *                w/c 26 Oct." (the line's total goes the other way from its subs: a later statement took off more)
 *  recalculated  "2 cancelled by BCN: the week's pay goes from £180.00 to £160.00 (not paid yet)."
 *  no change     "2 cancelled by BCN, but the base still applied: no change." / "All 16 confirmed by BCN: no change."
 *  not on it     "Not on BCN's corrected statement: back to the 22 subs logged, so the earlier correction is withdrawn."
 *                (someone the statement it replaces listed; also "…; the week's pay goes from … (not paid yet)." and
 *                "…: no change.")
 */
export function applySentence(r: {
  logged: number;
  confirmed: number;
  campaignCode: string;
  effect: 'recalculated' | 'adjustment' | 'no-change';
  before: { gross: number; paidAs: PaidAs | null };
  after: { gross: number; paidAs: PaidAs | null };
  difference: number;
  targetWeekStart?: string | null;
  /** The subs the week was paid for (as paid; default the logged ones). */
  paidFor?: number;
  /** The correction's total on the later week (default `difference`); 0 when an earlier correction was withdrawn. */
  correctionTotal?: number;
  /** On the statement being replaced but not on this one: `confirmed` is the week as logged (P3's dropped people). */
  notOnStatement?: boolean;
}): string {
  if (r.notOnStatement) {
    const back = `Not on ${r.campaignCode}'s corrected statement: back to the ${r.confirmed} sub${r.confirmed === 1 ? '' : 's'} logged`;
    if (r.effect === 'adjustment') {
      const where = r.targetWeekStart ? ` on the pay for ${payWeekLabel(r.targetWeekStart)}` : ' on the next pay';
      const total = r.correctionTotal ?? r.difference;
      return total === 0 ? `${back}, so the earlier correction is withdrawn.` : `${back}, so ${paySignedMoney(total)}${where}.`;
    }
    if (r.effect === 'recalculated') return `${back}; the week's pay goes from ${payMoney(r.before.gross)} to ${payMoney(r.after.gross)} (not paid yet).`;
    return `${back}: no change.`;
  }
  const cancelled = Math.max(0, r.logged - r.confirmed);
  const extra = Math.max(0, r.confirmed - r.logged);
  const what = cancelled > 0 ? `${cancelled} cancelled by ${r.campaignCode}` : extra > 0 ? `${r.campaignCode} confirmed ${extra} more` : `All ${r.confirmed} confirmed by ${r.campaignCode}`;
  if (r.effect === 'adjustment') {
    const where = r.targetWeekStart ? ` on the pay for ${payWeekLabel(r.targetWeekStart)}` : ' on the next pay';
    const paidFor = r.paidFor ?? r.logged;
    const total = r.correctionTotal ?? r.difference;
    if (total === 0) return `${r.campaignCode} confirmed ${r.confirmed} of the ${paidFor} subs paid for: the earlier correction is withdrawn.`;
    if (r.confirmed === paidFor) return `${r.campaignCode} confirmed all ${paidFor} subs paid for, which changes the week's earlier correction: ${paySignedMoney(total)}${where}.`;
    const change = r.confirmed < paidFor ? `${paidFor - r.confirmed} cancelled by ${r.campaignCode}` : `${r.campaignCode} confirmed ${r.confirmed - paidFor} more`;
    // the total goes the other way from the subs: an earlier correction for the week is partly given back or added to
    const against = (r.confirmed < paidFor && total > 0) || (r.confirmed > paidFor && total < 0);
    if (against) return `Paid for ${paidFor}, ${change}, which changes the week's earlier correction: ${paySignedMoney(total)}${where}.`;
    return `Paid for ${paidFor}, ${change}, so ${paySignedMoney(total)}${where}.`;
  }
  if (r.effect === 'recalculated') return `${what}: the week's pay goes from ${payMoney(r.before.gross)} to ${payMoney(r.after.gross)} (not paid yet).`;
  if (cancelled > 0 || extra > 0) {
    const base = r.before.paidAs === 'base' && r.after.paidAs === 'base';
    return `${what}, but ${base ? 'the base still applied' : 'the pay is the same'}: no change.`;
  }
  return `${what}: no change.`;
}

/** Subs needed to add `gap` pounds at `rate` per sub (0 when nothing is missing; Infinity when the rate is 0). */
export function subsForAmount(gap: number, rate: number): number {
  if (!(gap > 0)) return 0;
  if (!(rate > 0)) return Number.POSITIVE_INFINITY;
  return Math.ceil(round2(gap) / rate - 1e-9);
}
