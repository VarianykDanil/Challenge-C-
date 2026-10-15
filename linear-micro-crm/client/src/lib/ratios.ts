// Owned by the Frontend Developer. Thin wrappers over the shared benchmark/insight logic (@lm/shared),
// extended with the derived overall stop→sale conversion that the shared RatioKey does not cover.
import {
  BENCHMARK_RATIOS,
  RATIO_KEYS,
  RATIO_LABELS as SHARED_RATIO_LABELS,
  RATIO_SHORT_LABELS as SHARED_RATIO_SHORT_LABELS,
  benchmarkSeverity,
  benchmarkStatus,
  coachingInsights,
  weakestStage,
  type BenchmarkSeverity,
  type RatioKey as BenchmarkKey,
} from '@lm/shared';

export type { BenchmarkKey };
export { coachingInsights, weakestStage };

export type RatioTone = 'success' | 'warning' | 'danger';
export type RatioKey = BenchmarkKey | 'overallConversion';

export const BENCHMARK_KEYS: readonly BenchmarkKey[] = RATIO_KEYS;

/** Expected overall stop→sale conversion when every stage hits benchmark. */
export const BENCHMARK_OVERALL: number = RATIO_KEYS.reduce((acc, k) => acc * BENCHMARK_RATIOS[k], 1);

export const RATIO_LABELS: Record<RatioKey, string> = { ...SHARED_RATIO_LABELS, overallConversion: 'Overall conversion' };
export const RATIO_SHORT_LABELS: Record<RatioKey, string> = { ...SHARED_RATIO_SHORT_LABELS, overallConversion: 'Conv. %' };

export function benchmarkFor(key: RatioKey): number {
  return key === 'overallConversion' ? BENCHMARK_OVERALL : BENCHMARK_RATIOS[key];
}

/** Map the shared traffic-light severity onto the UI tone names. */
export function severityTone(severity: BenchmarkSeverity): RatioTone {
  return severity === 'good' ? 'success' : severity === 'watch' ? 'warning' : 'danger';
}

/** Colour a ratio against its benchmark using the shared tolerance/danger thresholds. */
export function ratioTone(key: RatioKey, value: number): RatioTone {
  if (!Number.isFinite(value)) return 'danger';
  const benchmark = benchmarkFor(key);
  const status = benchmarkStatus(value, benchmark);
  const relativeDelta = benchmark > 0 ? (value - benchmark) / benchmark : 0;
  return severityTone(benchmarkSeverity({ status, relativeDelta }));
}

export const TONE_TEXT: Record<RatioTone, string> = {
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-danger',
};
export const TONE_BG: Record<RatioTone, string> = {
  success: 'bg-success/10 text-success',
  warning: 'bg-warning/10 text-warning',
  danger: 'bg-danger/10 text-danger',
};
