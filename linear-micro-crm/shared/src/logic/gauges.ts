/**
 * Gauges and the "law of averages".
 *
 * The six gauges form a funnel (stops ≥ table ≥ presentations ≥ closes ≥ taps ≥ sales).
 * Every stage-to-stage ratio is `next / previous`; a zero denominator gives 0, never NaN.
 */
import type { FunnelRatios, GaugeKey, GaugeTotals } from '../types.ts';
import { GAUGE_KEYS } from '../types.ts';
import {
  BENCHMARK_DANGER_THRESHOLD,
  BENCHMARK_RATIOS,
  BENCHMARK_TOLERANCE,
  PERFORMANCE_WEIGHTS,
  RATIO_KEYS,
  RATIO_LABELS,
  TARGET_SALES_PER_DAY,
  type RatioKey,
} from '../constants.ts';

export type { RatioKey };

/** Absorbs binary floating-point noise at band edges (0.55 / 0.5 − 1 is 0.10000000000000009). */
const REL_EPSILON = 1e-9;

export const EMPTY_TOTALS: GaugeTotals = {
  stops: 0,
  table: 0,
  presentations: 0,
  closes: 0,
  taps: 0,
  sales: 0,
};

/** Benchmarks are a plain map of ratio key → expected ratio (0..1). */
export type Benchmarks = Readonly<Record<RatioKey, number>>;

export type BenchmarkStatus = 'above' | 'on_track' | 'below';

export interface RatioStep {
  key: RatioKey;
  from: GaugeKey;
  to: GaugeKey;
  label: string;
}

export interface BenchmarkComparison {
  key: RatioKey;
  label: string;
  /** Observed ratio, 0..1 */
  actual: number;
  /** Benchmark ratio, 0..1 */
  benchmark: number;
  /** actual − benchmark, in ratio points (e.g. −0.12 = twelve percentage points under) */
  delta: number;
  /** (actual − benchmark) / benchmark; 0 when the benchmark is 0 */
  relativeDelta: number;
  status: BenchmarkStatus;
}

/** The five funnel steps in order, each naming its source and target gauge. */
export const ratioKeys: readonly RatioStep[] = RATIO_KEYS.map((key, i) => ({
  key,
  from: GAUGE_KEYS[i],
  to: GAUGE_KEYS[i + 1],
  label: RATIO_LABELS[key],
}));

/** Sum any list of gauge-shaped rows into one GaugeTotals. */
export function sumGauges(rows: Array<Partial<GaugeTotals>>): GaugeTotals {
  const out: GaugeTotals = { ...EMPTY_TOTALS };
  for (const row of rows) {
    for (const k of GAUGE_KEYS) out[k] += Number(row[k] ?? 0);
  }
  return out;
}

/** `num / den`, or 0 when the denominator is not positive. */
export function safeRatio(num: number, den: number): number {
  return den > 0 ? num / den : 0;
}

/** Stage-to-stage conversion ratios for a set of totals. */
export function funnelRatios(t: GaugeTotals): FunnelRatios {
  return {
    stopToTable: safeRatio(t.table, t.stops),
    tableToPresentation: safeRatio(t.presentations, t.table),
    presentationToClose: safeRatio(t.closes, t.presentations),
    closeToTap: safeRatio(t.taps, t.closes),
    tapToSale: safeRatio(t.sales, t.taps),
    overallConversion: safeRatio(t.sales, t.stops),
    stopsPerSale: t.sales > 0 ? t.stops / t.sales : Infinity,
  };
}

/**
 * Validate that a gauge entry is a proper funnel (each stage ≤ previous).
 * Returns a list of human-readable warnings; empty means valid.
 */
export function validateGaugeFunnel(t: GaugeTotals): string[] {
  const warnings: string[] = [];
  for (const k of GAUGE_KEYS) {
    if (!Number.isInteger(t[k]) || t[k] < 0) warnings.push(`${k} must be a whole number ≥ 0`);
  }
  for (let i = 1; i < GAUGE_KEYS.length; i++) {
    const prev: GaugeKey = GAUGE_KEYS[i - 1];
    const cur: GaugeKey = GAUGE_KEYS[i];
    if (t[cur] > t[prev]) warnings.push(`${cur} (${t[cur]}) cannot exceed ${prev} (${t[prev]})`);
  }
  return warnings;
}

/**
 * Classify an actual ratio against its benchmark.
 * Within ±`tolerance` (relative, default 10%) is `on_track`; otherwise `above` or `below`.
 * A zero benchmark is `on_track` at 0 and `above` for anything positive.
 */
export function benchmarkStatus(
  actual: number,
  benchmark: number,
  tolerance: number = BENCHMARK_TOLERANCE,
): BenchmarkStatus {
  if (benchmark <= 0) return actual > 0 ? 'above' : 'on_track';
  const rel = (actual - benchmark) / benchmark;
  if (rel > tolerance + REL_EPSILON) return 'above';
  if (rel < -tolerance - REL_EPSILON) return 'below';
  return 'on_track';
}

/** Severity used to colour benchmark chips: `good` at/above, `watch` a little under, `poor` well under. */
export type BenchmarkSeverity = 'good' | 'watch' | 'poor';

/**
 * Grade a comparison for traffic-light colouring. `above` and `on_track` are `good`; `below` is `watch`
 * until the shortfall passes `dangerThreshold` (relative, default 25%), after which it is `poor`.
 */
export function benchmarkSeverity(
  comparison: Pick<BenchmarkComparison, 'status' | 'relativeDelta'>,
  dangerThreshold: number = BENCHMARK_DANGER_THRESHOLD,
): BenchmarkSeverity {
  if (comparison.status !== 'below') return 'good';
  return comparison.relativeDelta < -dangerThreshold - REL_EPSILON ? 'poor' : 'watch';
}

/** Compare each of the five stage ratios with its benchmark, in funnel order. */
export function compareToBenchmark(
  ratios: FunnelRatios,
  benchmarks: Benchmarks = BENCHMARK_RATIOS,
  tolerance: number = BENCHMARK_TOLERANCE,
): BenchmarkComparison[] {
  return RATIO_KEYS.map((key) => {
    const actual = Number.isFinite(ratios[key]) ? ratios[key] : 0;
    const benchmark = benchmarks[key];
    const delta = actual - benchmark;
    return {
      key,
      label: RATIO_LABELS[key],
      actual,
      benchmark,
      delta,
      relativeDelta: benchmark > 0 ? delta / benchmark : 0,
      status: benchmarkStatus(actual, benchmark, tolerance),
    };
  });
}

function hasActivity(ratios: FunnelRatios): boolean {
  return RATIO_KEYS.some((k) => ratios[k] > 0);
}

/**
 * The stage furthest below its benchmark (lowest actual/benchmark), or null when there is no
 * activity at all. Ties resolve to the earliest stage — fixing the top of the funnel first
 * lifts every stage below it.
 */
export function weakestStage(
  ratios: FunnelRatios,
  benchmarks: Benchmarks = BENCHMARK_RATIOS,
): BenchmarkComparison | null {
  if (!hasActivity(ratios)) return null;
  const rows = compareToBenchmark(ratios, benchmarks);
  let best: BenchmarkComparison | null = null;
  for (const r of rows) {
    if (best === null || r.relativeDelta < best.relativeDelta) best = r;
  }
  return best;
}

/** The stage furthest above its benchmark, or null when nothing is above. */
export function strongestStage(
  ratios: FunnelRatios,
  benchmarks: Benchmarks = BENCHMARK_RATIOS,
): BenchmarkComparison | null {
  if (!hasActivity(ratios)) return null;
  const rows = compareToBenchmark(ratios, benchmarks);
  let best: BenchmarkComparison | null = null;
  for (const r of rows) {
    if (best === null || r.relativeDelta > best.relativeDelta) best = r;
  }
  return best;
}

/**
 * Stops → sales conversion implied by the five stage ratios (their product).
 * Equal to `overallConversion` when the ratios came from one set of totals, but lets a
 * "what if I lifted one stage?" projection be computed from edited ratios.
 */
export function funnelConversion(ratios: FunnelRatios): number {
  let p = 1;
  for (const k of RATIO_KEYS) p *= Math.max(0, ratios[k]);
  return p;
}

/** Expected sales from `stops` at the given ratios (not rounded — format in the UI). */
export function projectSales(stops: number, ratios: FunnelRatios): number {
  if (!(stops > 0)) return 0;
  return stops * funnelConversion(ratios);
}

/**
 * Stops needed to land `targetSales` at the given ratios, rounded up.
 * Returns 0 for a non-positive target and `Infinity` when the funnel never converts.
 */
export function stopsNeededFor(targetSales: number, ratios: FunnelRatios): number {
  if (!(targetSales > 0)) return 0;
  const conv = funnelConversion(ratios);
  if (conv <= 0) return Infinity;
  return Math.ceil(targetSales / conv - 1e-9);
}

/** Average sales per worked day; 0 when no days were worked. */
export function salesPerDay(totals: GaugeTotals, days: number): number {
  return days > 0 ? totals.sales / days : 0;
}

export interface PerformanceScoreOptions {
  benchmarks?: Benchmarks;
  /** Sales per day that earns full volume marks (default TARGET_SALES_PER_DAY). */
  targetSalesPerDay?: number;
}

/**
 * 0–100 composite used for leaderboards and coaching:
 *   funnel half (60%): mean over the five stages of min(actual / benchmark, 1)
 *   volume half (40%): min(salesPerDay / target, 1)
 * Each stage is capped at 1 so one brilliant stage cannot hide a weak one.
 */
export function performanceScore(
  ratios: FunnelRatios,
  salesPerDayValue: number,
  options: PerformanceScoreOptions = {},
): number {
  const benchmarks = options.benchmarks ?? BENCHMARK_RATIOS;
  const target = options.targetSalesPerDay ?? TARGET_SALES_PER_DAY;
  let funnel = 0;
  for (const k of RATIO_KEYS) {
    const b = benchmarks[k];
    const a = Number.isFinite(ratios[k]) ? Math.max(0, ratios[k]) : 0;
    funnel += b > 0 ? Math.min(a / b, 1) : a > 0 ? 1 : 0;
  }
  funnel /= RATIO_KEYS.length;
  const spd = Number.isFinite(salesPerDayValue) ? Math.max(0, salesPerDayValue) : 0;
  const volume = target > 0 ? Math.min(spd / target, 1) : spd > 0 ? 1 : 0;
  const score = 100 * (PERFORMANCE_WEIGHTS.funnel * funnel + PERFORMANCE_WEIGHTS.volume * volume);
  return Math.round(Math.min(100, Math.max(0, score)));
}

/**
 * Fractional change from `previous` to `current` (0.12 = +12%).
 * Null when there is no previous value to compare against.
 */
export function relativeChange(current: number, previous: number): number | null {
  if (!Number.isFinite(previous) || previous === 0) return null;
  if (!Number.isFinite(current)) return null;
  return (current - previous) / Math.abs(previous);
}

/** The `deltas` block of the dashboard: sales, conversion and stops vs the previous period. */
export function periodDeltas(
  current: GaugeTotals,
  previous: GaugeTotals,
): { sales: number | null; conversion: number | null; stops: number | null } {
  return {
    sales: relativeChange(current.sales, previous.sales),
    conversion: relativeChange(safeRatio(current.sales, current.stops), safeRatio(previous.sales, previous.stops)),
    stops: relativeChange(current.stops, previous.stops),
  };
}
