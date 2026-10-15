import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { GaugeTotals } from '../types.ts';
import { BENCHMARK_RATIOS } from '../constants.ts';
import {
  EMPTY_TOTALS,
  benchmarkSeverity,
  benchmarkStatus,
  compareToBenchmark,
  funnelConversion,
  funnelRatios,
  performanceScore,
  periodDeltas,
  projectSales,
  ratioKeys,
  relativeChange,
  salesPerDay,
  stopsNeededFor,
  strongestStage,
  sumGauges,
  validateGaugeFunnel,
  weakestStage,
} from './gauges.ts';

const SAMPLE: GaugeTotals = { stops: 100, table: 40, presentations: 20, closes: 8, taps: 5, sales: 4 };
const AT_BENCHMARK: GaugeTotals = { stops: 1000, table: 350, presentations: 175, closes: 70, taps: 42, sales: 37.8 };

const close = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

test('sumGauges adds partial rows and returns zeros for an empty list', () => {
  assert.deepEqual(sumGauges([]), EMPTY_TOTALS);
  assert.deepEqual(sumGauges([{ stops: 10, sales: 1 }, { stops: 5, table: 2 }, {}]), {
    stops: 15,
    table: 2,
    presentations: 0,
    closes: 0,
    taps: 0,
    sales: 1,
  });
  assert.notEqual(sumGauges([]), EMPTY_TOTALS, 'returns a fresh object, never the shared constant');
});

test('funnelRatios handles zero denominators and computes every ratio', () => {
  const zero = funnelRatios(EMPTY_TOTALS);
  assert.equal(zero.stopToTable, 0);
  assert.equal(zero.overallConversion, 0);
  assert.equal(zero.stopsPerSale, Infinity);

  const r = funnelRatios(SAMPLE);
  close(r.stopToTable, 0.4);
  close(r.tableToPresentation, 0.5);
  close(r.presentationToClose, 0.4);
  close(r.closeToTap, 0.625);
  close(r.tapToSale, 0.8);
  close(r.overallConversion, 0.04);
  close(r.stopsPerSale, 25);

  // a stage with zero volume halfway down gives 0 (not NaN) below it
  const r2 = funnelRatios({ stops: 10, table: 4, presentations: 0, closes: 0, taps: 0, sales: 0 });
  assert.equal(r2.presentationToClose, 0);
  assert.equal(r2.closeToTap, 0);
  assert.equal(Number.isNaN(r2.tapToSale), false);
});

test('validateGaugeFunnel flags non-integers, negatives and inverted stages', () => {
  assert.deepEqual(validateGaugeFunnel(SAMPLE), []);
  assert.deepEqual(validateGaugeFunnel(EMPTY_TOTALS), []);
  const bad = validateGaugeFunnel({ stops: 5, table: 6, presentations: 2.5, closes: -1, taps: 0, sales: 0 });
  assert.ok(bad.some((w) => w.startsWith('table (6) cannot exceed stops (5)')));
  assert.ok(bad.some((w) => w.startsWith('presentations must be a whole number')));
  assert.ok(bad.some((w) => w.startsWith('closes must be a whole number')));
});

test('ratioKeys lists the five steps in funnel order with from/to gauges', () => {
  assert.equal(ratioKeys.length, 5);
  assert.deepEqual(
    ratioKeys.map((r) => r.key),
    ['stopToTable', 'tableToPresentation', 'presentationToClose', 'closeToTap', 'tapToSale'],
  );
  assert.deepEqual(ratioKeys[0], { key: 'stopToTable', from: 'stops', to: 'table', label: 'Stop → table' });
  for (let i = 1; i < ratioKeys.length; i++) assert.equal(ratioKeys[i].from, ratioKeys[i - 1].to);
});

test('benchmarkStatus uses a ±10% relative band, inclusive at the edges', () => {
  assert.equal(benchmarkStatus(0.5, 0.5), 'on_track');
  assert.equal(benchmarkStatus(0.55, 0.5), 'on_track');
  assert.equal(benchmarkStatus(0.45, 0.5), 'on_track');
  assert.equal(benchmarkStatus(0.5501, 0.5), 'above');
  assert.equal(benchmarkStatus(0.4499, 0.5), 'below');
  assert.equal(benchmarkStatus(0, 0.5), 'below');
  assert.equal(benchmarkStatus(0.5, 0.5, 0), 'on_track');
  assert.equal(benchmarkStatus(0.51, 0.5, 0), 'above');
  // zero benchmark never divides by zero
  assert.equal(benchmarkStatus(0, 0), 'on_track');
  assert.equal(benchmarkStatus(0.1, 0), 'above');
});

test('compareToBenchmark returns one row per stage with delta and status', () => {
  const rows = compareToBenchmark(funnelRatios(SAMPLE));
  assert.equal(rows.length, 5);
  const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
  assert.equal(byKey.stopToTable.status, 'above'); // 0.40 vs 0.35 (+14%)
  assert.equal(byKey.tableToPresentation.status, 'on_track'); // 0.50 vs 0.50
  assert.equal(byKey.presentationToClose.status, 'on_track'); // 0.40 vs 0.40
  assert.equal(byKey.closeToTap.status, 'on_track'); // 0.625 vs 0.60 (+4%)
  assert.equal(byKey.tapToSale.status, 'below'); // 0.80 vs 0.90 (−11%)
  close(byKey.tapToSale.delta, -0.1);
  close(byKey.tapToSale.relativeDelta, -0.1 / 0.9);
  assert.equal(byKey.tapToSale.benchmark, BENCHMARK_RATIOS.tapToSale);
  assert.equal(byKey.tapToSale.label, 'Tap → sale');

  // custom benchmarks are honoured
  const custom = compareToBenchmark(funnelRatios(SAMPLE), { ...BENCHMARK_RATIOS, tapToSale: 0.8 });
  assert.equal(custom.find((r) => r.key === 'tapToSale')?.status, 'on_track');

  // no data: everything below, no NaN
  for (const r of compareToBenchmark(funnelRatios(EMPTY_TOTALS))) {
    assert.equal(r.status, 'below');
    assert.equal(Number.isNaN(r.relativeDelta), false);
  }
});

test('weakestStage / strongestStage pick by relative gap and return null with no activity', () => {
  const r = funnelRatios(SAMPLE);
  assert.equal(weakestStage(r)?.key, 'tapToSale');
  assert.equal(strongestStage(r)?.key, 'stopToTable');
  assert.equal(weakestStage(funnelRatios(EMPTY_TOTALS)), null);
  assert.equal(strongestStage(funnelRatios(EMPTY_TOTALS)), null);
  // ties resolve to the earliest stage in the funnel
  const tie = funnelRatios({ stops: 100, table: 10, presentations: 0, closes: 0, taps: 0, sales: 0 });
  assert.equal(weakestStage(tie)?.key, 'tableToPresentation');
});

test('funnelConversion, projectSales and stopsNeededFor', () => {
  const r = funnelRatios(SAMPLE);
  close(funnelConversion(r), 0.04);
  close(projectSales(200, r), 8);
  assert.equal(projectSales(0, r), 0);
  assert.equal(projectSales(-5, r), 0);
  assert.equal(stopsNeededFor(4, r), 100);
  assert.equal(stopsNeededFor(1, r), 25);
  assert.equal(stopsNeededFor(3, r), 75);
  assert.equal(stopsNeededFor(0, r), 0);
  assert.equal(stopsNeededFor(1, funnelRatios(EMPTY_TOTALS)), Infinity);
  // rounds up: 0.04 conversion, 2 sales → 50 exactly; 0.03 → 66.67 → 67
  const r3 = funnelRatios({ stops: 100, table: 30, presentations: 10, closes: 10, taps: 10, sales: 3 });
  assert.equal(stopsNeededFor(2, r3), 67);
});

test('salesPerDay guards against zero days', () => {
  assert.equal(salesPerDay({ ...EMPTY_TOTALS, sales: 10 }, 4), 2.5);
  assert.equal(salesPerDay({ ...EMPTY_TOTALS, sales: 10 }, 0), 0);
  assert.equal(salesPerDay(EMPTY_TOTALS, 5), 0);
});

test('performanceScore is a bounded 0–100 composite (60% funnel, 40% volume)', () => {
  const bench = funnelRatios(AT_BENCHMARK);
  assert.equal(performanceScore(bench, 2), 100);
  assert.equal(performanceScore(bench, 0), 60);
  assert.equal(performanceScore(bench, 1), 80);
  assert.equal(performanceScore(funnelRatios(EMPTY_TOTALS), 2), 40);
  assert.equal(performanceScore(funnelRatios(EMPTY_TOTALS), 0), 0);
  // above benchmark is capped, so the score never exceeds 100
  const star = funnelRatios({ stops: 100, table: 80, presentations: 70, closes: 60, taps: 55, sales: 54 });
  assert.equal(performanceScore(star, 9), 100);
  // half of every benchmark with target volume → 60 * 0.5 + 40 = 70
  const half = funnelRatios({ stops: 1000, table: 175, presentations: 43.75, closes: 8.75, taps: 2.625, sales: 1.18125 });
  assert.equal(performanceScore(half, 2), 70);
  // NaN / negative volume treated as zero
  assert.equal(performanceScore(bench, Number.NaN), 60);
  assert.equal(performanceScore(bench, -3), 60);
  // custom target
  assert.equal(performanceScore(bench, 1, { targetSalesPerDay: 1 }), 100);
});

test('relativeChange and periodDeltas return null when there is nothing to compare against', () => {
  close(relativeChange(12, 10)!, 0.2);
  assert.equal(relativeChange(5, 0), null);
  assert.equal(relativeChange(0, 10), -1);
  assert.equal(relativeChange(Number.NaN, 10), null);
  const d = periodDeltas(SAMPLE, { stops: 80, table: 30, presentations: 15, closes: 6, taps: 4, sales: 2 });
  close(d.sales!, 1);
  close(d.stops!, 0.25);
  close(d.conversion!, 0.04 / 0.025 - 1);
  assert.deepEqual(periodDeltas(SAMPLE, EMPTY_TOTALS), { sales: null, conversion: null, stops: null });
});

test('benchmarkSeverity grades below-benchmark stages as watch or poor', () => {
  assert.equal(benchmarkSeverity({ status: 'above', relativeDelta: 0.3 }), 'good');
  assert.equal(benchmarkSeverity({ status: 'on_track', relativeDelta: -0.05 }), 'good');
  assert.equal(benchmarkSeverity({ status: 'below', relativeDelta: -0.11 }), 'watch');
  assert.equal(benchmarkSeverity({ status: 'below', relativeDelta: -0.25 }), 'watch');
  assert.equal(benchmarkSeverity({ status: 'below', relativeDelta: -0.26 }), 'poor');
  assert.equal(benchmarkSeverity({ status: 'below', relativeDelta: -1 }), 'poor');
  assert.equal(benchmarkSeverity({ status: 'below', relativeDelta: -0.2 }, 0.1), 'poor');
  // from real totals: 0.8 vs 0.9 is −11% → watch; 0.2 vs 0.9 → poor
  const rows = compareToBenchmark(funnelRatios(SAMPLE));
  assert.equal(benchmarkSeverity(rows.find((r) => r.key === 'tapToSale')!), 'watch');
  const poor = compareToBenchmark(funnelRatios({ stops: 100, table: 40, presentations: 20, closes: 10, taps: 10, sales: 2 }));
  assert.equal(benchmarkSeverity(poor.find((r) => r.key === 'tapToSale')!), 'poor');
});
