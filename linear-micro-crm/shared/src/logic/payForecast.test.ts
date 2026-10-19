import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FunnelRatios, PayPlan } from '../types.ts';
import { estimateWeekPay } from './finance.ts';
import { PAY_FORECAST_RULES, bonusLikelihoodFor, payForecastFrom, type PayForecastInput } from './payForecast.ts';

const fieldRep: PayPlan = { id: 1, name: 'Field rep', position: 'field_rep', basePerDay: 60, commissionPerSale: 45, bonusThreshold: 12, bonusAmount: 75, overridePerTeamSale: 0 };
const leader: PayPlan = { id: 2, name: 'Team leader', position: 'team_leader', basePerDay: 80, commissionPerSale: 45, bonusThreshold: 12, bonusAmount: 75, overridePerTeamSale: 5 };
const noBonus: PayPlan = { ...fieldRep, id: 3, name: 'Flat', bonusThreshold: 0, bonusAmount: 0 };
/** 4% stop → sale (0.4 × 0.5 × 0.5 × 0.8 × 0.5): 25 stops per sale. */
const ratios: FunnelRatios = { stopToTable: 0.4, tableToPresentation: 0.5, presentationToClose: 0.5, closeToTap: 0.8, tapToSale: 0.5, overallConversion: 0.04, stopsPerSale: 25 };

function input(over: Partial<PayForecastInput> = {}): PayForecastInput {
  return {
    plan: fieldRep,
    weekStart: '2026-10-12',
    soFar: { days: 3, sales: 11, teamSales: 0 },
    remainingDays: 2,
    dailySales: [2, 2, 2, 2, 2, 2, 2, 2, 2, 2],
    ratios,
    trailingStops: 1000,
    ...over,
  };
}

test('worked example: field rep, 3 days and 11 sales so far, 2 days left at λ = 2', () => {
  const f = payForecastFrom(input());
  assert.equal(f.estimate, true);
  assert.equal(f.weekStart, '2026-10-12');
  assert.equal(f.payday, '2026-10-23');
  assert.equal(f.sales?.likely, 15);
  assert.equal(f.likely, 1050); // 5 × £60 + 15 × £45 + £75 bonus
  assert.equal(f.low, 1050); // every history day is 2, so p10 = p90 = 2
  assert.equal(f.high, 1050);
  assert.equal(f.soFar.gross, 3 * 60 + 11 * 45);
  assert.equal(f.bonusGap, 1);
  assert.ok(Math.abs(f.bonusProbability - (1 - Math.exp(-4))) < 1e-12);
  assert.ok(Math.abs(f.bonusProbability - 0.982) < 0.001);
  assert.equal(f.bonusLikelihood, 'likely');
  assert.equal(f.stopsForBonus, 25);
  assert.deepEqual(f.basis, { weeks: PAY_FORECAST_RULES.windowWeeks, workedDays: 10, salesPerDay: 2 });
});

test('λ = 0 → low = likely = high (only base pay is added for the days left)', () => {
  const f = payForecastFrom(input({ dailySales: [0, 0, 0, 0, 0, 0] }));
  assert.equal(f.low, f.likely);
  assert.equal(f.likely, f.high);
  assert.equal(f.likely, estimateWeekPay(fieldRep, { daysWorked: 5, sales: 11, teamSales: 0 }).gross);
  assert.equal(f.bonusProbability, 0);
  assert.equal(f.bonusLikelihood, 'unlikely');
});

test('remainingDays = 0 → all three equal estimateWeekPay(soFar).gross', () => {
  const f = payForecastFrom(input({ remainingDays: 0, dailySales: [0, 1, 5, 9, 3, 2, 7] }));
  const official = estimateWeekPay(fieldRep, { daysWorked: 3, sales: 11, teamSales: 0 }).gross;
  assert.equal(f.low, official);
  assert.equal(f.likely, official);
  assert.equal(f.high, official);
  assert.equal(f.soFar.gross, official);
  assert.equal(f.bonusProbability, 0, 'no days left and one sale short');
});

test('gap 0 → reached with probability 1 and no stops figure', () => {
  const f = payForecastFrom(input({ soFar: { days: 4, sales: 13, teamSales: 0 } }));
  assert.equal(f.bonusGap, 0);
  assert.equal(f.bonusProbability, 1);
  assert.equal(f.bonusLikelihood, 'reached');
  assert.equal(f.stopsForBonus, null);
});

test('a threshold that pays £0 → none, but the gap still counts from the threshold', () => {
  const f = payForecastFrom(input({ plan: { ...fieldRep, bonusAmount: 0 } }));
  assert.equal(f.bonusLikelihood, 'none');
  assert.equal(f.bonusGap, 1);
  assert.equal(f.bonusProbability, 0);
  assert.equal(f.stopsForBonus, null);
});

test('a plan without a bonus → none, gap 0, probability 0', () => {
  const f = payForecastFrom(input({ plan: noBonus }));
  assert.equal(f.bonusLikelihood, 'none');
  assert.equal(f.bonusGap, 0);
  assert.equal(f.bonusProbability, 0);
  assert.equal(f.stopsForBonus, null);
  assert.equal(f.bonusThreshold, 0);
});

test('fewer than 5 worked days of history: no range, basis.weeks = 0', () => {
  const f = payForecastFrom(input({ dailySales: [4, 4, 4, 4], historyWeeks: 1 }));
  assert.equal(f.basis.weeks, 0);
  assert.equal(f.basis.workedDays, 4);
  assert.equal(f.basis.salesPerDay, 0);
  assert.equal(f.low, f.high);
  assert.equal(f.likely, estimateWeekPay(fieldRep, { daysWorked: 5, sales: 11, teamSales: 0 }).gross);
});

test('likelihood thresholds: likely ≥ 0.6, possible ≥ 0.25, else unlikely', () => {
  assert.equal(bonusLikelihoodFor(0.6), 'likely');
  assert.equal(bonusLikelihoodFor(0.59), 'possible');
  assert.equal(bonusLikelihoodFor(0.25), 'possible');
  assert.equal(bonusLikelihoodFor(0.2499), 'unlikely');
  // gap 6 with 2 days at λ = 2 (Poisson mean 4): P(X ≥ 6) ≈ 0.2149 → unlikely
  const f = payForecastFrom(input({ soFar: { days: 3, sales: 6, teamSales: 0 } }));
  assert.equal(f.bonusGap, 6);
  assert.ok(Math.abs(f.bonusProbability - 0.2149) < 0.0001);
  assert.equal(f.bonusLikelihood, 'unlikely');
  assert.equal(f.stopsForBonus, 150);
});

test('stopsForBonus is null with too few trailing stops or a funnel that never converts', () => {
  assert.equal(payForecastFrom(input({ trailingStops: 19 })).stopsForBonus, null);
  assert.equal(payForecastFrom(input({ ratios: { ...ratios, tapToSale: 0 } })).stopsForBonus, null);
});

test('range from the quantiles: low = floor(d·p10), high = ceil(d·p90)', () => {
  // history 0..9 → mean 4.5, p10 = 0.9, p90 = 8.1; 2 days left
  const f = payForecastFrom(input({ soFar: { days: 3, sales: 5, teamSales: 0 }, dailySales: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] }));
  assert.deepEqual(f.sales, { low: 5 + 1, likely: 5 + 9, high: 5 + 17 });
  assert.equal(f.low, estimateWeekPay(fieldRep, { daysWorked: 5, sales: 6, teamSales: 0 }).gross);
  assert.equal(f.likely, estimateWeekPay(fieldRep, { daysWorked: 5, sales: 14, teamSales: 0 }).gross);
  assert.equal(f.high, estimateWeekPay(fieldRep, { daysWorked: 5, sales: 22, teamSales: 0 }).gross);
});

test('leaders: team sales projected at the team rate for the days left', () => {
  const f = payForecastFrom(input({ plan: leader, soFar: { days: 3, sales: 11, teamSales: 20 }, teamSalesPerDay: 7.4 }));
  // team: 20 + round(2 × 7.4) = 35 → overrides £175
  assert.equal(f.likely, estimateWeekPay(leader, { daysWorked: 5, sales: 15, teamSales: 35 }).gross);
  assert.equal(f.soFar.gross, estimateWeekPay(leader, { daysWorked: 3, sales: 11, teamSales: 20 }).gross);
  // a plan without overrides ignores the team rate
  assert.equal(payForecastFrom(input({ teamSalesPerDay: 50 })).likely, 1050);
});

test('projected days never exceed 7', () => {
  const f = payForecastFrom(input({ soFar: { days: 6, sales: 11, teamSales: 0 }, remainingDays: 3 }));
  assert.equal(f.likely, estimateWeekPay(fieldRep, { daysWorked: 7, sales: 11 + 6, teamSales: 0 }).gross);
});

test('low ≤ likely ≤ high and the sales range is ordered, for randomised fixtures', () => {
  let seed = 12345;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const plans = [fieldRep, leader, noBonus, { ...fieldRep, id: 4, bonusAmount: 0 }];
  for (let i = 0; i < 500; i++) {
    const n = Math.floor(rand() * 40);
    const skewed = rand() < 0.3;
    const dailySales = Array.from({ length: n }, () => (skewed && rand() < 0.1 ? Math.floor(rand() * 40) : Math.floor(rand() * 6)));
    const f = payForecastFrom(input({
      plan: plans[i % plans.length]!,
      soFar: { days: Math.floor(rand() * 6), sales: Math.floor(rand() * 20), teamSales: Math.floor(rand() * 40) },
      remainingDays: Math.floor(rand() * 5),
      dailySales,
      teamSalesPerDay: rand() * 10,
      trailingStops: Math.floor(rand() * 2000),
    }));
    assert.ok(f.low <= f.likely && f.likely <= f.high, `money ordered (${f.low}, ${f.likely}, ${f.high})`);
    assert.ok(f.sales!.low <= f.sales!.likely && f.sales!.likely <= f.sales!.high, 'sales ordered');
    assert.ok(f.bonusProbability >= 0 && f.bonusProbability <= 1);
    assert.equal(f.bonusGap, f.bonusThreshold > 0 ? Math.max(0, f.bonusThreshold - f.soFar.sales) : 0);
    if (f.bonusAmount <= 0 || f.bonusThreshold <= 0) assert.equal(f.bonusLikelihood, 'none');
    assert.ok(Number.isFinite(f.low) && Number.isFinite(f.high));
  }
});
