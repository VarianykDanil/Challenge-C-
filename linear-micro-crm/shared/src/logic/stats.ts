/**
 * Small, dependency-free statistics for the smart release (p1 foundation; used by p2 pace, p3 forecasts, p4 check-ins).
 * Pure functions: no I/O, deterministic, never NaN — degenerate inputs give 0 or null as documented per function.
 */
import type { GaugeTotals, TrendDirection } from '../types.ts';

/** Arithmetic mean; 0 for an empty list. */
export function mean(xs: ReadonlyArray<number>): number {
  if (!xs.length) return 0;
  let total = 0;
  for (const x of xs) total += x;
  return total / xs.length;
}

/** Sample standard deviation (divides by n − 1); 0 when there are fewer than 2 values. */
export function sampleSd(xs: ReadonlyArray<number>): number {
  const n = xs.length;
  if (n < 2) return 0;
  const mu = mean(xs);
  let ss = 0;
  for (const x of xs) ss += (x - mu) ** 2;
  return Math.sqrt(ss / (n - 1));
}

/** (x − μ) / σ; null when σ ≤ 0 or the result is not finite. */
export function zScore(x: number, mu: number, sd: number): number | null {
  if (!(sd > 0)) return null;
  const z = (x - mu) / sd;
  return Number.isFinite(z) ? z : null;
}

/**
 * One-sample binomial z: (k − n·p0) / √(n·p0·(1 − p0)) — "is k successes in n trials unusual at rate p0?".
 * Null when n is 0 or p0 is not strictly between 0 and 1.
 */
export function binomialZ(k: number, n: number, p0: number): number | null {
  if (!(n > 0) || !(p0 > 0 && p0 < 1)) return null;
  const z = (k - n * p0) / Math.sqrt(n * p0 * (1 - p0));
  return Number.isFinite(z) ? z : null;
}

/**
 * Two-proportion z with a pooled rate: p = (k1 + k2) / (n1 + n2), z = (k1/n1 − k2/n2) / √(p(1 − p)(1/n1 + 1/n2)).
 * Positive when the first proportion is higher. Null when n1 or n2 is 0, or the pooled p is 0 or 1.
 */
export function twoProportionZ(k1: number, n1: number, k2: number, n2: number): number | null {
  if (!(n1 > 0) || !(n2 > 0)) return null;
  const p = (k1 + k2) / (n1 + n2);
  if (!(p > 0 && p < 1)) return null;
  const z = (k1 / n1 - k2 / n2) / Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
  return Number.isFinite(z) ? z : null;
}

/**
 * P(X ≥ k) for X ~ Poisson(λ) = 1 − Σ_{i<k} e^−λ·λ^i / i!, summed iteratively in log space (no factorials, no
 * underflow for large λ). k ≤ 0 → 1; λ ≤ 0 with k > 0 → 0. A fractional k is rounded up (whole events).
 */
export function poissonTailAtLeast(k: number, lambda: number): number {
  const kk = Math.ceil(k);
  if (!(kk > 0)) return 1;
  if (!(lambda > 0)) return 0;
  const logLambda = Math.log(lambda);
  let logTerm = -lambda; // i = 0
  let below = Math.exp(logTerm);
  for (let i = 1; i < kk; i++) {
    logTerm += logLambda - Math.log(i);
    below += Math.exp(logTerm);
  }
  return Math.min(1, Math.max(0, 1 - below));
}

/** Quantile by linear interpolation between order statistics (R type 7, the spreadsheet default); [] → 0. */
export function quantile(xs: ReadonlyArray<number>, q: number): number {
  if (!xs.length) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const qq = Math.min(1, Math.max(0, Number.isFinite(q) ? q : 0));
  const h = (sorted.length - 1) * qq;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  return sorted[lo]! + (h - lo) * (sorted[hi]! - sorted[lo]!);
}

/** One person's gauges for one Mon–Sun week: the six totals, the week's Monday and the distinct worked dates. */
export type WeekStat = GaugeTotals & { weekStart: string; days: number };

export interface WeekSeriesStats {
  /** Weeks with at least one worked day (weeks off are ignored entirely: a week off is not a slow week). */
  weeks: number;
  /** Mean of each worked week's stops ÷ days. */
  stopsPerDayMean: number;
  /** Sample SD of each worked week's stops ÷ days (0 with fewer than 2 worked weeks). */
  stopsPerDaySd: number;
  /** Σ sales ÷ Σ stops over the worked weeks (0..1); 0 when there were no stops. */
  pooledConversion: number;
  totalStops: number;
  totalSales: number;
  totalDays: number;
}

/** Per-week stops-per-day spread and the pooled conversion of a run of weeks. Weeks with days = 0 are skipped. */
export function weekSeriesStats(weeks: ReadonlyArray<WeekStat>): WeekSeriesStats {
  const worked = weeks.filter((w) => w.days > 0);
  const perDay = worked.map((w) => w.stops / w.days);
  let totalStops = 0;
  let totalSales = 0;
  let totalDays = 0;
  for (const w of worked) {
    totalStops += w.stops;
    totalSales += w.sales;
    totalDays += w.days;
  }
  return {
    weeks: worked.length,
    stopsPerDayMean: mean(perDay),
    stopsPerDaySd: sampleSd(perDay),
    pooledConversion: totalStops > 0 ? totalSales / totalStops : 0,
    totalStops,
    totalSales,
    totalDays,
  };
}

export interface ConversionTrendOptions {
  /** Each half needs at least this many stops (default 400). */
  minStops?: number;
  /** |z| at or above this labels the trend (default 2). */
  z?: number;
}

/**
 * Has conversion moved? Splits the weeks (oldest first) into the oldest half and the newest half — 16 completed weeks
 * → 8 v 8; with an odd count the middle week is left out — and compares their pooled conversions with
 * `twoProportionZ(recent, earlier)`. Null when either half has fewer than `minStops` stops. `improving` when z ≥ +2,
 * `declining` when z ≤ −2, otherwise `steady` (also when nobody sold anything, so there is no rate to compare).
 */
export function conversionTrend(weeks: ReadonlyArray<WeekStat>, options: ConversionTrendOptions = {}): TrendDirection | null {
  const minStops = options.minStops ?? 400;
  const threshold = options.z ?? 2;
  const half = Math.floor(weeks.length / 2);
  if (half === 0) return null;
  const sum = (ws: ReadonlyArray<WeekStat>) => ws.reduce((a, w) => ({ stops: a.stops + w.stops, sales: a.sales + w.sales }), { stops: 0, sales: 0 });
  const earlier = sum(weeks.slice(0, half));
  const recent = sum(weeks.slice(weeks.length - half));
  if (earlier.stops < minStops || recent.stops < minStops) return null;
  const z = twoProportionZ(recent.sales, recent.stops, earlier.sales, earlier.stops) ?? 0;
  return {
    label: z >= threshold ? 'improving' : z <= -threshold ? 'declining' : 'steady',
    z,
    recentConversion: recent.sales / recent.stops,
    earlierConversion: earlier.sales / earlier.stops,
    recentStops: recent.stops,
    earlierStops: earlier.stops,
  };
}
