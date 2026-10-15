import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PayPlan } from '../types.ts';
import {
  avgDaysLate,
  calculatePayroll,
  daysLate,
  estimateWeekPay,
  isPaidOnTime,
  margin,
  marginAmount,
  nextPayday,
  onTimeRate,
  paydayForWeek,
  payrollStatusFor,
  round2,
  sumMoney,
} from './finance.ts';

const PLAN: PayPlan = {
  id: 1,
  name: 'Field rep',
  position: 'field_rep',
  basePerDay: 50,
  commissionPerSale: 25,
  bonusThreshold: 10,
  bonusAmount: 100,
  overridePerTeamSale: 5,
};

test('round2 rounds to pence without float surprises', () => {
  assert.equal(round2(0.1 + 0.2), 0.3);
  assert.equal(round2(1.005), 1.01);
  assert.equal(round2(10.555), 10.56);
  assert.equal(round2(12.345), 12.35);
  assert.equal(round2(-1.234), -1.23);
  assert.equal(round2(100), 100);
  assert.equal(round2(1e-7), 0);
  assert.equal(Object.is(round2(-0.001), -0), false, 'never returns -0');
  assert.equal(round2(Infinity), Infinity);
});

test('calculatePayroll — worked example from LOGIC.md', () => {
  const pay = calculatePayroll(PLAN, { daysWorked: 5, sales: 12, teamSales: 30, deductions: 20 });
  assert.deepEqual(pay, { basePay: 250, commission: 300, bonus: 100, overrides: 150, deductions: 20, gross: 780 });
});

test('calculatePayroll bonus only when the weekly threshold is reached', () => {
  assert.equal(calculatePayroll(PLAN, { daysWorked: 5, sales: 9, teamSales: 0 }).bonus, 0);
  assert.equal(calculatePayroll(PLAN, { daysWorked: 5, sales: 10, teamSales: 0 }).bonus, 100);
  // a plan with no threshold never pays a bonus
  assert.equal(calculatePayroll({ ...PLAN, bonusThreshold: 0, bonusAmount: 500 }, { daysWorked: 5, sales: 50, teamSales: 0 }).bonus, 0);
});

test('calculatePayroll handles zero and negative inputs', () => {
  assert.deepEqual(calculatePayroll(PLAN, { daysWorked: 0, sales: 0, teamSales: 0 }), {
    basePay: 0,
    commission: 0,
    bonus: 0,
    overrides: 0,
    deductions: 0,
    gross: 0,
  });
  const clamped = calculatePayroll(PLAN, { daysWorked: -2, sales: -1, teamSales: -4 });
  assert.equal(clamped.gross, 0);
  // deductions can push gross negative (an advance larger than the week's pay) — reported, not hidden
  assert.equal(calculatePayroll(PLAN, { daysWorked: 1, sales: 0, teamSales: 0, deductions: 80 }).gross, -30);
});

test('calculatePayroll rounds each component to pence', () => {
  const plan = { ...PLAN, basePerDay: 33.333, commissionPerSale: 0.1 };
  const pay = calculatePayroll(plan, { daysWorked: 3, sales: 3, teamSales: 0 });
  assert.equal(pay.basePay, 100);
  assert.equal(pay.commission, 0.3);
  assert.equal(pay.gross, 100.3);
});

test('estimateWeekPay is an alias of calculatePayroll', () => {
  const input = { daysWorked: 4, sales: 7, teamSales: 2 };
  assert.deepEqual(estimateWeekPay(PLAN, input), calculatePayroll(PLAN, input));
});

test('isPaidOnTime compares calendar days and returns null when unpaid', () => {
  assert.equal(isPaidOnTime('2026-10-23', '2026-10-23'), true);
  assert.equal(isPaidOnTime('2026-10-23', '2026-10-22'), true);
  assert.equal(isPaidOnTime('2026-10-23', '2026-10-24'), false);
  assert.equal(isPaidOnTime('2026-10-23', null), null);
  // a timestamp on the due day still counts as on time
  assert.equal(isPaidOnTime('2026-10-23', '2026-10-23T17:45:00.000Z'), true);
});

test('payrollStatusFor derives pending / paid / late from dates', () => {
  assert.equal(payrollStatusFor('2026-10-23', '2026-10-23', '2026-10-30'), 'paid');
  assert.equal(payrollStatusFor('2026-10-23', '2026-10-26', '2026-10-30'), 'late');
  assert.equal(payrollStatusFor('2026-10-23', null, '2026-10-20'), 'pending');
  assert.equal(payrollStatusFor('2026-10-23', null, '2026-10-23'), 'pending'); // due today, not late yet
  assert.equal(payrollStatusFor('2026-10-23', null, '2026-10-24'), 'late');
});

test('daysLate', () => {
  assert.equal(daysLate('2026-10-23', '2026-10-26'), 3);
  assert.equal(daysLate('2026-10-23', '2026-10-20'), 0);
  assert.equal(daysLate('2026-10-23', '2026-10-23'), 0);
  assert.equal(daysLate('2026-10-23', null), 0);
  assert.equal(daysLate('2026-10-23', null, '2026-10-27'), 4);
  assert.equal(daysLate('2026-10-23', null, '2026-10-21'), 0);
});

test('onTimeRate and avgDaysLate ignore unpaid runs', () => {
  assert.equal(onTimeRate([]), 0);
  const runs = [
    { dueDate: '2026-10-02', paidDate: '2026-10-02' },
    { dueDate: '2026-10-09', paidDate: '2026-10-08' },
    { dueDate: '2026-10-16', paidDate: '2026-10-20' },
    { dueDate: '2026-10-23', paidDate: null },
  ];
  assert.ok(Math.abs(onTimeRate(runs) - 2 / 3) < 1e-12);
  assert.equal(onTimeRate([{ dueDate: '2026-10-23', paidDate: null }]), 0);
  assert.equal(avgDaysLate(runs), 4);
  assert.equal(avgDaysLate(runs.slice(0, 2)), 0);
  assert.equal(avgDaysLate([...runs, { dueDate: '2026-10-30', paidDate: '2026-11-01' }]), 3);
});

test('paydays: Monday–Sunday week paid on the following Friday', () => {
  assert.equal(paydayForWeek('2026-10-12'), '2026-10-23');
  assert.equal(paydayForWeek('2026-10-14'), '2026-10-23'); // any day of the week works
  assert.equal(nextPayday('2026-10-14'), '2026-10-23'); // Wednesday
  assert.equal(nextPayday('2026-10-12'), '2026-10-23'); // Monday
  assert.equal(nextPayday('2026-10-18'), '2026-10-23'); // Sunday, last day of the week
  assert.equal(nextPayday('2026-10-19'), '2026-10-30'); // next Monday rolls over
  assert.equal(nextPayday('2026-10-23'), '2026-10-30'); // on a payday, the current week pays next Friday
  assert.equal(nextPayday('2026-12-30'), '2027-01-08'); // across the year end
});

test('margin and marginAmount', () => {
  assert.equal(margin(1000, 600), 0.4);
  assert.equal(margin(0, 100), 0);
  assert.equal(margin(100, 150), -0.5);
  assert.equal(marginAmount(1000, 600.004), 400);
  assert.equal(marginAmount(100, 150), -50);
});

test('sumMoney avoids drift and ignores non-finite values', () => {
  assert.equal(sumMoney([0.1, 0.2, 0.3]), 0.6);
  assert.equal(sumMoney([]), 0);
  assert.equal(sumMoney([10, Number.NaN, 5.555]), 15.56);
});
