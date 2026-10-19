import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flagMoney, payrollFlags, type PayrollFlagInput } from './payrollFlags.ts';

/** A normal field-rep week: 4 days, 9 sales, £645, no bonus, nothing odd. */
type Over = Omit<Partial<PayrollFlagInput>, 'run'> & { run?: Partial<PayrollFlagInput['run']> };

function input(over: Over = {}): PayrollFlagInput {
  const { run, ...rest } = over;
  return {
    run: { gross: 645, sales: 9, daysWorked: 4, bonus: 0, deductions: 0, overrides: 0, ...run },
    priorGross: [610, 655, 590, 700, 640],
    trailingDailySales: [2, 3, 2, 1, 2, 3, 2, 2, 3, 2, 1, 2],
    weekDailySales: [2, 3, 2, 2],
    bonusThreshold: 12,
    recomputedGross: 645,
    recruiter: false,
    ...rest,
  };
}

const codes = (i: PayrollFlagInput) => payrollFlags(i).map((f) => f.code);

test('a normal run → no flags', () => {
  assert.deepEqual(payrollFlags(input()), []);
});

test('high_gross: £780 against prior [300, 320, 290, 310]', () => {
  const flags = payrollFlags(input({ run: { gross: 780 }, priorGross: [300, 320, 290, 310], recomputedGross: 780 }));
  assert.deepEqual(flags.map((f) => f.code), ['high_gross']);
  assert.equal(flags[0]!.severity, 'warning');
  // median of 290, 300, 310, 320 = 305 → 780 / 305 = 2.56
  assert.match(flags[0]!.text, /^£780 is 2\.6× the usual £305/);
});

test('high_gross needs ≥ 3 prior runs and uses at most the 8 newest', () => {
  assert.deepEqual(codes(input({ run: { gross: 780 }, priorGross: [300, 310], recomputedGross: 780 })), []);
  // the 8 newest are all ~£700 (older £100 runs ignored) → £780 is normal
  assert.deepEqual(codes(input({ run: { gross: 780 }, priorGross: [700, 700, 700, 700, 700, 700, 700, 700, 100, 100, 100, 100, 100, 100, 100, 100, 100], recomputedGross: 780 })), []);
  // exactly 2.5× is not "more than" 2.5×
  assert.deepEqual(codes(input({ run: { gross: 750 }, priorGross: [300, 300, 300], recomputedGross: 750 })), []);
});

test('first_payslip (info) when there are no prior runs', () => {
  const flags = payrollFlags(input({ priorGross: [] }));
  assert.deepEqual(flags.map((f) => [f.code, f.severity]), [['first_payslip', 'info']]);
});

test('sales_without_days: 0 days with 2 sales', () => {
  const flags = payrollFlags(input({ run: { gross: 90, sales: 2, daysWorked: 0 }, recomputedGross: 90 }));
  assert.deepEqual(flags.map((f) => f.code), ['sales_without_days']);
  assert.equal(flags[0]!.severity, 'warning');
  assert.match(flags[0]!.text, /^2 sales with no days worked/);
});

test('high_deductions: 60% of the week taken by deductions', () => {
  // earned £500, £300 deducted → gross £200
  const flags = payrollFlags(input({ run: { gross: 200, deductions: 300 }, recomputedGross: 200 }));
  assert.deepEqual(flags.map((f) => f.code), ['high_deductions']);
  assert.equal(flags[0]!.text, 'Deductions of £300 take 60% of the £500 earned');
  // exactly half is fine
  assert.deepEqual(codes(input({ run: { gross: 250, deductions: 250 }, recomputedGross: 250 })), []);
});

test('bonus_single_day: the bonus rests on one big day', () => {
  // 12 sales, 9 of them on one day; usual day 2 → 9 ≥ 3 × 2 and 12 − 9 = 3 < 12
  const run = { gross: 60 * 4 + 45 * 12 + 75, sales: 12, bonus: 75 };
  const flags = payrollFlags(input({ run, weekDailySales: [9, 1, 1, 1], recomputedGross: run.gross }));
  assert.deepEqual(flags.map((f) => f.code), ['bonus_single_day']);
  assert.match(flags[0]!.text, /^The £75 bonus rests on one day: 9 sales against a usual 2 sales a day/);
  // an even week that reached the bonus is fine
  assert.deepEqual(codes(input({ run, weekDailySales: [3, 3, 3, 3], recomputedGross: run.gross })), []);
  // fewer than 10 trailing worked days → no judgement either way
  assert.deepEqual(codes(input({ run, weekDailySales: [9, 1, 1, 1], trailingDailySales: [2, 2, 2], recomputedGross: run.gross })), []);
  // the rest of the week would have reached the bonus anyway
  const big = { gross: 1500, sales: 20, bonus: 75 };
  assert.deepEqual(codes(input({ run: big, weekDailySales: [8, 4, 4, 4], recomputedGross: big.gross, priorGross: [1400, 1450, 1500] })), []);
});

test('stale_amount: the gauges now give a different amount', () => {
  const flags = payrollFlags(input({ recomputedGross: 690 }));
  assert.deepEqual(flags.map((f) => f.code), ['stale_amount']);
  assert.match(flags[0]!.text, /gauges changed since this run was calculated/);
  assert.match(flags[0]!.text, /£690, not £645/);
  // within a penny, or not recomputable → nothing
  assert.deepEqual(codes(input({ recomputedGross: 645.01 })), []);
  assert.deepEqual(codes(input({ recomputedGross: null })), []);
});

test('override_no_days (info): overrides with no days worked', () => {
  const flags = payrollFlags(input({ run: { gross: 120, sales: 0, daysWorked: 0, overrides: 120 }, recomputedGross: 120 }));
  assert.deepEqual(flags.map((f) => [f.code, f.severity]), [['override_no_days', 'info']]);
});

test('a recruiter run with hires gets no sales-based flags', () => {
  // 3 hires (the `sales` column), £100 bonus, a "best day" far above the usual and even 0 days: none of it applies
  const run = { gross: 550, sales: 3, daysWorked: 0, bonus: 100 };
  const flags = payrollFlags(input({ run, recruiter: true, bonusThreshold: 2, weekDailySales: [3], trailingDailySales: Array(12).fill(0), recomputedGross: 550, priorGross: [450, 550, 450] }));
  assert.deepEqual(flags, []);
  // …but the money checks still run for recruiters
  assert.deepEqual(codes(input({ run: { gross: 1400, sales: 3, daysWorked: 5, bonus: 100 }, recruiter: true, priorGross: [450, 450, 450], recomputedGross: 1400 })), ['high_gross']);
});

test('flags come out in a fixed order and money is en-GB', () => {
  const flags = payrollFlags(input({ run: { gross: 90, sales: 2, daysWorked: 0, deductions: 400 }, priorGross: [], recomputedGross: 100 }));
  assert.deepEqual(flags.map((f) => f.code), ['first_payslip', 'sales_without_days', 'high_deductions', 'stale_amount']);
  assert.equal(flagMoney(412.5), '£412.50');
  assert.equal(flagMoney(1050), '£1,050');
  assert.equal(flagMoney(-20), '−£20');
});
