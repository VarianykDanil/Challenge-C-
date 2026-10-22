/**
 * P1 pay-rule: calculateWeekPay and payExplanation on hand-computed weeks (decision 2: base = £63.50 × days worked;
 * commission = paid subs × each campaign's rate; the higher one is paid, a tie pays commission).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PayAdjustment } from '../types/pay.ts';
import { applySentence, calculateWeekPay, payDayLabel, payExplanation, payMoney, paySignedMoney, payWeekLabel, subsForAmount, type WeekPaySale } from './payRule.ts';

const DAY = 63.5;
/** n subs of BCN (campaign 1) on one day at a rate. */
const bcn = (date: string, logged: number, rate = 10): WeekPaySale => ({ campaignId: 1, campaignCode: 'BCN', date, logged, rate });
const chn = (date: string, logged: number, rate = 12): WeekPaySale => ({ campaignId: 2, campaignCode: 'CHN', date, logged, rate });
const vlt = (date: string, logged: number, rate = 25): WeekPaySale => ({ campaignId: 3, campaignCode: 'VLT', date, logged, rate });
const adj = (a: Partial<PayAdjustment> & Pick<PayAdjustment, 'amount' | 'kind'>): PayAdjustment => ({
  id: 1, userId: 9, targetWeekStart: '2026-10-12', sourceWeekStart: null, note: '', createdBy: 1, createdAt: '2026-10-14T10:00:00.000Z', ...a,
});

test('2 days, no subs: base 2 × £63.50 = £127.00', () => {
  const w = calculateWeekPay({ dayRate: DAY, daysWorked: 2, sales: [] });
  assert.equal(w.baseAmount, 127);
  assert.equal(w.commissionAmount, 0);
  assert.equal(w.paidAs, 'base');
  assert.deepEqual([w.basePay, w.commission, w.bonus, w.overrides, w.gross], [127, 0, 0, 0, 127]);
  assert.deepEqual(w.lines.map((l) => [l.kind, l.label, l.amount, l.paid]), [['base', '2 days × £63.50', 127, true]]);
});

test('3 days, 10 subs × £15 = £150 < base £190.50 → paid the base only', () => {
  const sales = [bcn('2026-10-12', 3, 15), bcn('2026-10-13', 4, 15), bcn('2026-10-14', 3, 15)];
  const w = calculateWeekPay({ dayRate: DAY, daysWorked: 3, sales });
  assert.equal(w.baseAmount, 190.5);
  assert.equal(w.commissionAmount, 150);
  assert.equal(w.paidAs, 'base');
  assert.deepEqual([w.basePay, w.commission, w.gross], [190.5, 0, 190.5]);
  // the commission line is listed, not paid
  assert.deepEqual(w.lines.map((l) => [l.label, l.amount, l.paid]), [['3 days × £63.50', 190.5, true], ['BCN: 10 subs × £15.00', 150, false]]);
});

test('4 days, 18 logged, 2 cancelled by BCN: 16 × £10 = £160 < £254 → base (the owner\'s worked example)', () => {
  const sales = [bcn('2026-10-12', 5), bcn('2026-10-13', 4), bcn('2026-10-14', 5), bcn('2026-10-15', 4)];
  const w = calculateWeekPay({ dayRate: DAY, daysWorked: 4, sales, confirmations: [{ campaignId: 1, confirmed: 16 }] });
  assert.equal(w.baseAmount, 254);
  assert.equal(w.commissionAmount, 160);
  assert.equal(w.paidAs, 'base');
  assert.deepEqual([w.salesLogged, w.salesConfirmed, w.salesCancelled], [18, 16, 2]);
  assert.deepEqual(w.perCampaign, [{ campaignId: 1, code: 'BCN', logged: 18, confirmed: 16, cancelled: 2, statementConfirmed: true, rate: 10, amount: 160 }]);
  assert.equal(w.gross, 254);
  assert.deepEqual(payExplanation(w), [
    'You worked 4 days: base £254.00.',
    'Commission: 16 subs paid (18 logged, 2 cancelled by BCN) = £160.00.',
    "Commission was below your base, so you're paid the base: £254.00.",
  ]);
});

test('5 days, 25 subs × £15 = £375 beats base £317.50 → paid the commission only', () => {
  const sales = [5, 5, 6, 4, 5].map((n, i) => bcn(`2026-10-1${2 + i}`, n, 15));
  const w = calculateWeekPay({ dayRate: DAY, daysWorked: 5, sales });
  assert.equal(w.baseAmount, 317.5);
  assert.equal(w.commissionAmount, 375);
  assert.equal(w.paidAs, 'commission');
  assert.deepEqual([w.basePay, w.commission, w.gross], [0, 375, 375]);
  assert.deepEqual(w.lines.map((l) => [l.kind, l.paid]), [['base', false], ['commission', true]]);
  assert.deepEqual(payExplanation(w), [
    'You worked 5 days: base £317.50.',
    'Commission: 25 subs (not yet confirmed by BCN) = £375.00.',
    "Commission £375.00 beat your base £317.50, so you're paid the commission.",
  ]);
});

test('7 days over two campaigns: BCN 20 × £12 + VLT 9 × £25 = £465 ≥ base £444.50 → commission', () => {
  const sales = [
    bcn('2026-10-12', 6, 12), bcn('2026-10-13', 5, 12), bcn('2026-10-17', 5, 12), bcn('2026-10-18', 4, 12),
    vlt('2026-10-14', 3), vlt('2026-10-15', 4), vlt('2026-10-16', 2),
  ];
  const w = calculateWeekPay({ dayRate: DAY, daysWorked: 7, sales });
  assert.equal(w.baseAmount, 444.5);
  assert.equal(w.commissionAmount, 465);
  assert.equal(w.paidAs, 'commission');
  assert.deepEqual(w.perCampaign.map((c) => [c.code, c.logged, c.amount]), [['BCN', 20, 240], ['VLT', 9, 225]]);
  assert.equal(w.gross, 465);
});

test('a tie pays commission: 3 days = £190.50 and 15 subs × £12.70 = £190.50', () => {
  const w = calculateWeekPay({ dayRate: DAY, daysWorked: 3, sales: [bcn('2026-10-12', 15, 12.7)] });
  assert.equal(w.baseAmount, 190.5);
  assert.equal(w.commissionAmount, 190.5);
  assert.equal(w.paidAs, 'commission');
  assert.deepEqual([w.basePay, w.commission], [0, 190.5]);
  assert.equal(payExplanation(w)[2], "Commission £190.50 matched your base, so you're paid the commission.");
});

test('zero days and nothing else: all zero, nothing to pay', () => {
  const w = calculateWeekPay({ dayRate: DAY, daysWorked: 0, sales: [] });
  assert.deepEqual([w.baseAmount, w.commissionAmount, w.gross], [0, 0, 0]);
  assert.equal(w.paidAs, 'commission', 'paidAsFor(0, 0) is a tie');
  assert.deepEqual(payExplanation(w), ['No days worked this week, so no base.', 'No subs logged this week, so no commission.', "Nothing to pay from this week's work."]);
});

test('the rate changes mid-week: each day pays the rate in effect; cancellations come off the latest days first', () => {
  // Mon–Tue 10 subs at £15, Wed–Fri 15 subs at £20 (BCN raised its rate from Wed 14 Oct): 150 + 300 = £450 > £317.50
  const sales = [
    bcn('2026-10-12', 6, 15), bcn('2026-10-13', 4, 15),
    bcn('2026-10-14', 5, 20), bcn('2026-10-15', 5, 20), bcn('2026-10-16', 5, 20),
  ];
  const logged = calculateWeekPay({ dayRate: DAY, daysWorked: 5, sales });
  assert.equal(logged.commissionAmount, 450);
  assert.deepEqual(logged.lines.filter((l) => l.kind === 'commission').map((l) => [l.label, l.amount]), [
    ['BCN: 10 subs × £15.00 (to Tue 13 Oct)', 150],
    ['BCN: 15 subs × £20.00 (from Wed 14 Oct)', 300],
  ]);
  assert.equal(logged.perCampaign[0]!.rate, 18, 'weighted £450 / 25');
  // 3 cancelled: Friday 5 → 2, so 10 × £15 + 12 × £20 = £390 (still above the base)
  const confirmed = calculateWeekPay({ dayRate: DAY, daysWorked: 5, sales, confirmations: [{ campaignId: 1, confirmed: 22 }] });
  assert.equal(confirmed.commissionAmount, 390);
  assert.equal(confirmed.paidAs, 'commission');
  assert.equal(confirmed.gross, 390);
  // 17 cancelled: Wed–Fri lose all 15, Tue loses 2 → 8 × £15 = £120, below the base
  const most = calculateWeekPay({ dayRate: DAY, daysWorked: 5, sales, confirmations: [{ campaignId: 1, confirmed: 8 }] });
  assert.equal(most.commissionAmount, 120);
  assert.deepEqual(most.lines.filter((l) => l.kind === 'commission').map((l) => l.label), ['BCN: 8 subs × £15.00 (to Tue 13 Oct)']);
  assert.equal(most.paidAs, 'base');
  assert.equal(most.gross, 317.5);
});

test('cancellations that change nothing: 18 → 16 subs at £10 stays below the £254 base', () => {
  const sales = [bcn('2026-10-12', 5), bcn('2026-10-13', 4), bcn('2026-10-14', 5), bcn('2026-10-15', 4)];
  const before = calculateWeekPay({ dayRate: DAY, daysWorked: 4, sales });
  const after = calculateWeekPay({ dayRate: DAY, daysWorked: 4, sales, confirmations: [{ campaignId: 1, confirmed: 16 }] });
  assert.deepEqual([before.paidAs, before.gross, after.paidAs, after.gross], ['base', 254, 'base', 254]);
  assert.equal(
    applySentence({ logged: 18, confirmed: 16, campaignCode: 'BCN', effect: 'no-change', before: { gross: 254, paidAs: 'base' }, after: { gross: 254, paidAs: 'base' }, difference: 0 }),
    '2 cancelled by BCN, but the base still applied: no change.',
  );
});

test('a paid week corrected later: 18 × £15 = £270 paid as commission, 2 cancelled → £240, −£30 next week', () => {
  const sales = [bcn('2026-10-05', 6, 15), bcn('2026-10-06', 6, 15), bcn('2026-10-07', 6, 15)];
  const paid = calculateWeekPay({ dayRate: DAY, daysWorked: 3, sales });
  const corrected = calculateWeekPay({ dayRate: DAY, daysWorked: 3, sales, confirmations: [{ campaignId: 1, confirmed: 16 }] });
  assert.deepEqual([paid.gross, corrected.gross], [270, 240]);
  const difference = corrected.gross - paid.gross;
  assert.equal(
    applySentence({ logged: 18, confirmed: 16, campaignCode: 'BCN', effect: 'adjustment', before: { gross: 270, paidAs: 'commission' }, after: { gross: 240, paidAs: 'commission' }, difference, targetWeekStart: '2026-10-19' }),
    'Paid for 18, 2 cancelled by BCN, so −£30.00 on the pay for w/c 19 Oct.',
  );
  // when the cancellations drop the commission below the base, only the part above the base comes back
  const nearBase = calculateWeekPay({ dayRate: DAY, daysWorked: 3, sales: [bcn('2026-10-05', 13, 15)], confirmations: [{ campaignId: 1, confirmed: 11 }] });
  assert.equal(nearBase.gross, 190.5, '11 × £15 = £165 < £190.50 → base');
  assert.equal(round(nearBase.gross - 195), -4.5, '£195 paid as commission → −£4.50, not −£30');
});

test('bonus, a correction from an earlier week and deductions are added after the base-or-commission choice', () => {
  const w = calculateWeekPay({
    dayRate: DAY,
    daysWorked: 4,
    sales: [bcn('2026-10-12', 3)],
    bonuses: [{ id: 7, amount: 50, note: 'Top seller in September — 58 subs.' }],
    adjustments: [adj({ id: 8, kind: 'cancellation', amount: -30, sourceWeekStart: '2026-09-21', note: '2 cancelled by BCN', campaignId: 1, campaignCode: 'BCN' })],
    deductions: 20,
  });
  assert.deepEqual([w.basePay, w.commission, w.bonus, w.adjustmentsTotal, w.deductions, w.gross], [254, 0, 50, -30, 20, 254]);
  assert.deepEqual(w.lines.map((l) => [l.kind, l.label, l.amount]), [
    ['base', '4 days × £63.50', 254],
    ['commission', 'BCN: 3 subs × £10.00', 30],
    ['bonus', 'Bonus: Top seller in September — 58 subs', 50],
    ['adjustment', 'Correction for w/c 21 Sep', -30],
    ['deduction', 'Deductions', -20],
  ]);
  assert.equal(w.lines[3]!.sourceWeekStart, '2026-09-21');
  assert.deepEqual(payExplanation(w).slice(3), [
    'Bonus £50.00: Top seller in September — 58 subs.',
    'Correction for w/c 21 Sep: −£30.00 (2 cancelled by BCN).',
    'Deductions: −£20.00.',
    'Total: £254.00.',
  ]);
});

test('a client confirming more than was logged pays the extra subs at the latest day\'s rate', () => {
  const w = calculateWeekPay({ dayRate: DAY, daysWorked: 2, sales: [bcn('2026-10-12', 2, 15), bcn('2026-10-13', 3, 15)], confirmations: [{ campaignId: 1, confirmed: 7 }] });
  assert.equal(w.commissionAmount, 105);
  assert.deepEqual([w.salesLogged, w.salesConfirmed, w.salesCancelled], [5, 7, 0]);
  assert.equal(w.paidAs, 'base');
  assert.match(payExplanation(w)[1]!, /^Commission: 7 subs paid \(5 logged, 2 more confirmed by BCN\) = £105\.00\.$/);
  // and a statement for a campaign the person logged nothing for pays at the rate it gives
  const only = calculateWeekPay({ dayRate: DAY, daysWorked: 0, sales: [], confirmations: [{ campaignId: 2, confirmed: 3, rate: 12, campaignCode: 'CHN' }] });
  assert.deepEqual([only.commissionAmount, only.paidAs, only.gross], [36, 'commission', 36]);
});

test('several campaigns: one confirmed with cancellations, one still waiting for its statement', () => {
  const w = calculateWeekPay({
    dayRate: DAY,
    daysWorked: 4,
    sales: [bcn('2026-10-12', 6, 15), bcn('2026-10-13', 6, 15), chn('2026-10-14', 5), chn('2026-10-15', 5)],
    confirmations: [{ campaignId: 2, confirmed: 9 }],
  });
  // BCN 12 × £15 = 180; CHN 9 × £12 = 108 → 288 > 254
  assert.equal(w.commissionAmount, 288);
  assert.equal(w.paidAs, 'commission');
  assert.equal(payExplanation(w)[1], 'Commission: 21 subs paid (22 logged, 1 cancelled by CHN; not yet confirmed by BCN) = £288.00.');
  const office = payExplanation(w, { name: 'Jordan' });
  assert.equal(office[0], 'Jordan worked 4 days: base £254.00.');
  assert.equal(office[2], 'Commission £288.00 beat the base £254.00, so Jordan is paid the commission.');
  // the same stored calculation read after BCN's statement arrived (the week was paid before it)
  assert.equal(
    payExplanation(w, { confirmedSince: ['BCN'] })[1],
    'Commission: 21 subs paid (22 logged, 1 cancelled by CHN; not confirmed by BCN when paid) = £288.00.',
  );
});

test('days with no subs add no commission line; garbage inputs are clamped', () => {
  const w = calculateWeekPay({ dayRate: -5, daysWorked: 9, sales: [bcn('2026-10-12', 0), bcn('2026-10-13', Number.NaN)] });
  assert.deepEqual([w.dayRate, w.daysWorked, w.baseAmount, w.commissionAmount], [0, 7, 0, 0]);
  assert.deepEqual(w.perCampaign, []);
  assert.equal(w.lines.length, 1);
  const neg = calculateWeekPay({ dayRate: DAY, daysWorked: 1, sales: [], deductions: -40 });
  assert.equal(neg.deductions, 0, 'a negative deduction never adds money');
  assert.equal(neg.gross, 63.5);
});

test('money and date words', () => {
  assert.equal(payMoney(1234.5), '£1,234.50');
  assert.equal(payMoney(-20), '−£20.00');
  assert.equal(paySignedMoney(20), '+£20.00');
  assert.equal(paySignedMoney(-4.5), '−£4.50');
  assert.equal(payDayLabel('2026-10-23'), 'Fri 23 Oct');
  assert.equal(payWeekLabel('2026-10-05'), 'w/c 5 Oct');
  assert.equal(subsForAmount(94.5, 15), 7, '£94.50 / £15 = 6.3 → 7 subs');
  assert.equal(subsForAmount(90, 15), 6);
  assert.equal(subsForAmount(0, 15), 0);
  assert.equal(subsForAmount(10, 0), Number.POSITIVE_INFINITY);
});

test('applySentence: recalculated and confirmed-as-logged weeks', () => {
  assert.equal(
    applySentence({ logged: 18, confirmed: 16, campaignCode: 'CHN', effect: 'recalculated', before: { gross: 216, paidAs: 'commission' }, after: { gross: 192, paidAs: 'commission' }, difference: -24 }),
    "2 cancelled by CHN: the week's pay goes from £216.00 to £192.00 (not paid yet).",
  );
  assert.equal(
    applySentence({ logged: 12, confirmed: 12, campaignCode: 'BCN', effect: 'no-change', before: { gross: 254, paidAs: 'base' }, after: { gross: 254, paidAs: 'base' }, difference: 0 }),
    'All 12 confirmed by BCN: no change.',
  );
  // a paid week's statement confirming what was paid for, while another correction of that week is undone
  assert.equal(
    applySentence({ logged: 12, confirmed: 12, campaignCode: 'FXB', effect: 'adjustment', before: { gross: 317.5, paidAs: 'base' }, after: { gross: 340, paidAs: 'commission' }, difference: 22.5, targetWeekStart: '2026-10-12', paidFor: 12 }),
    "FXB confirmed all 12 subs paid for, which changes the week's earlier correction: +£22.50 on the pay for w/c 12 Oct.",
  );
});

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
