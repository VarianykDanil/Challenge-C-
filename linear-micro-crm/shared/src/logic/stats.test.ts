import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  binomialZ,
  conversionTrend,
  mean,
  poissonTailAtLeast,
  quantile,
  sampleSd,
  twoProportionZ,
  weekSeriesStats,
  zScore,
  type WeekStat,
} from './stats.ts';

const close = (actual: number | null, expected: number, places = 4) => {
  assert.notEqual(actual, null);
  const round = (x: number) => Math.round(x * 10 ** places) / 10 ** places;
  assert.equal(round(actual as number), round(expected));
};

function week(weekStart: string, days: number, stops: number, sales: number): WeekStat {
  return { weekStart, days, stops, table: 0, presentations: 0, closes: 0, taps: 0, sales };
}

test('mean and sampleSd (hand-checked)', () => {
  assert.equal(mean([]), 0);
  assert.equal(mean([2, 4, 4, 4, 5, 5, 7, 9]), 5);
  close(sampleSd([2, 4, 4, 4, 5, 5, 7, 9]), 2.1381);
  assert.equal(sampleSd([]), 0);
  assert.equal(sampleSd([7]), 0, 'fewer than 2 values → 0');
  assert.equal(sampleSd([3, 3, 3]), 0);
});

test('zScore is null for a non-positive or non-finite spread', () => {
  assert.equal(zScore(10, 5, 2.5), 2);
  assert.equal(zScore(10, 5, 0), null);
  assert.equal(zScore(10, 5, -1), null);
  assert.equal(zScore(Infinity, 5, 1), null);
});

test('binomialZ (hand-checked) and its guards', () => {
  close(binomialZ(30, 1000, 0.04), -1.6137);
  assert.equal(binomialZ(5, 0, 0.04), null, 'n = 0');
  assert.equal(binomialZ(5, 100, 0), null, 'p0 = 0');
  assert.equal(binomialZ(5, 100, 1), null, 'p0 = 1');
  assert.equal(binomialZ(5, 100, 1.2), null, 'p0 outside (0,1)');
});

test('twoProportionZ (hand-checked) and its guards', () => {
  close(twoProportionZ(20, 1000, 40, 1000), -2.6216);
  close(twoProportionZ(40, 1000, 20, 1000), 2.6216);
  assert.equal(twoProportionZ(1, 0, 1, 10), null, 'n1 = 0');
  assert.equal(twoProportionZ(1, 10, 1, 0), null, 'n2 = 0');
  assert.equal(twoProportionZ(0, 10, 0, 10), null, 'pooled p = 0');
  assert.equal(twoProportionZ(10, 10, 10, 10), null, 'pooled p = 1');
});

test('poissonTailAtLeast (hand-checked)', () => {
  close(poissonTailAtLeast(1, 2), 0.8647);
  close(poissonTailAtLeast(3, 2), 0.3233);
  assert.equal(poissonTailAtLeast(0, 3), 1);
  assert.equal(poissonTailAtLeast(0, 0), 1, '(0, x) = 1');
  assert.equal(poissonTailAtLeast(-2, 3), 1);
  assert.equal(poissonTailAtLeast(1, 0), 0, 'λ ≤ 0 and k > 0 → 0');
  close(poissonTailAtLeast(1, 4), 0.9817, 4); // 1 − e^−4 (p3's bonus example)
  // large λ stays finite (log-space sum): P(X ≥ 800 | λ = 800) is a little under 0.51
  const big = poissonTailAtLeast(800, 800);
  assert.ok(big > 0.49 && big < 0.52, `large λ: ${big}`);
});

test('quantile uses linear interpolation (type 7)', () => {
  close(quantile([1, 2, 3, 4], 0.9), 3.7);
  assert.equal(quantile([], 0.5), 0);
  assert.equal(quantile([5], 0.9), 5);
  assert.equal(quantile([4, 1, 3, 2], 0), 1, 'unsorted input');
  assert.equal(quantile([4, 1, 3, 2], 1), 4);
  close(quantile([10, 20, 30, 40, 50], 0.6), 34);
});

test('weekSeriesStats ignores weeks off entirely', () => {
  const weeks = [week('2026-08-03', 5, 300, 9), week('2026-08-10', 0, 0, 0), week('2026-08-17', 4, 320, 12), week('2026-08-24', 5, 250, 5)];
  const s = weekSeriesStats(weeks);
  assert.equal(s.weeks, 3);
  assert.equal(s.totalDays, 14);
  assert.equal(s.totalStops, 870);
  assert.equal(s.totalSales, 26);
  close(s.stopsPerDayMean, (60 + 80 + 50) / 3);
  close(s.stopsPerDaySd, sampleSd([60, 80, 50]));
  close(s.pooledConversion, 26 / 870);
  const none = weekSeriesStats([week('2026-08-03', 0, 0, 0)]);
  assert.deepEqual([none.weeks, none.stopsPerDayMean, none.stopsPerDaySd, none.pooledConversion], [0, 0, 0, 0]);
});

test('conversionTrend compares the oldest half with the newest half', () => {
  const mondays = Array.from({ length: 16 }, (_, i) => `2026-${String(6 + Math.floor(i / 4)).padStart(2, '0')}-0${(i % 4) + 1}`);
  // 8 weeks at 4.0% then 8 weeks at 2.5% (1,000 stops a week): a clear decline
  const declining = mondays.map((m, i) => week(m, 5, 1000, i < 8 ? 40 : 25));
  const d = conversionTrend(declining)!;
  assert.equal(d.label, 'declining');
  close(d.earlierConversion, 0.04);
  close(d.recentConversion, 0.025);
  assert.equal(d.earlierStops, 8000);
  assert.equal(d.recentStops, 8000);
  assert.ok(d.z <= -2);
  assert.equal(conversionTrend([...declining].reverse())!.label, 'improving');
  assert.equal(conversionTrend(mondays.map((m) => week(m, 5, 1000, 30)))!.label, 'steady');
  // a half with fewer than 400 stops → null (399 v 8,000)
  const thin = mondays.map((m, i) => week(m, i < 8 ? 1 : 5, i < 8 ? (i === 0 ? 49 : 50) : 1000, 2));
  assert.equal(thin.slice(0, 8).reduce((a, w) => a + w.stops, 0), 399);
  assert.equal(conversionTrend(thin), null);
  assert.notEqual(conversionTrend(thin, { minStops: 399 }), null, 'minStops is configurable');
  assert.equal(conversionTrend([]), null);
  // nobody sold anything: no rate to compare, so steady rather than null
  assert.equal(conversionTrend(mondays.map((m) => week(m, 5, 1000, 0)))!.label, 'steady');
});
