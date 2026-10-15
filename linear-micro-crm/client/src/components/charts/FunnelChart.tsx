import { Fragment, useLayoutEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import {
  GAUGE_KEYS,
  GAUGE_LABELS,
  GAUGE_SHORT_LABELS,
  RATIO_SHORT_LABELS,
  benchmarkSeverity,
  compareToBenchmark,
  funnelRatios,
  ratioKeys,
  type BenchmarkComparison,
  type Benchmarks,
  type FunnelRatios,
  type GaugeKey,
  type GaugeTotals,
  type RatioStep,
} from '@lm/shared';
import { EmptyChart } from './EmptyChart';
import { chartTokens, formatNumber, formatPercent, seriesColor, wash } from './theme';

export interface FunnelChartProps {
  totals: GaugeTotals;
  ratios?: FunnelRatios;
  /** compare against benchmark ratios and colour steps */
  showBenchmarks?: boolean;
  /** `horizontal` (default): six columns left→right. `vertical`: six rows with bars growing right. */
  orientation?: 'horizontal' | 'vertical';
  compact?: boolean;
  className?: string;
  /** Override the company benchmarks (defaults to BENCHMARK_RATIOS). */
  benchmarks?: Benchmarks;
  /** Height in px of the bar area in the horizontal layout (default 120, compact 56). */
  barHeight?: number;
  ariaLabel?: string;
  emptyMessage?: string;
}

/** One hue, light → dark towards the sale: an ordinal ramp for ordered stages. */
const STAGE_OPACITY = [0.35, 0.48, 0.61, 0.74, 0.87, 1];

const STATUS_TEXT = { above: 'above benchmark', on_track: 'on track', below: 'below benchmark' } as const;

/** Width of the chart's container, so the ratio chips can change layout before they would overlap. */
function useContainerWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState<number>(Number.POSITIVE_INFINITY);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setWidth(el.getBoundingClientRect().width);
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}
const STATUS_GLYPH = { above: '▲', on_track: '●', below: '▼' } as const;

function severityColor(c: BenchmarkComparison): string {
  const severity = benchmarkSeverity(c);
  return severity === 'good' ? chartTokens.success : severity === 'watch' ? chartTokens.warning : chartTokens.danger;
}

function RatioChip({
  step,
  comparison,
  fromCount,
  showBenchmarks,
  compact,
  dense = compact,
}: {
  step: RatioStep;
  comparison: BenchmarkComparison;
  fromCount: number;
  showBenchmarks: boolean;
  compact: boolean;
  /** Drop the "/ benchmark" suffix (the tooltip keeps it) so the chip fits a narrow slot. */
  dense?: boolean;
}) {
  const noData = fromCount <= 0;
  const pct = noData ? '—' : formatPercent(comparison.actual);
  const coloured = showBenchmarks && !noData;
  const color = coloured ? severityColor(comparison) : chartTokens.muted;
  const title = noData
    ? `${step.label}: no data yet`
    : coloured
      ? `${step.label}: ${pct} vs ${formatPercent(comparison.benchmark)} benchmark — ${STATUS_TEXT[comparison.status]}`
      : `${step.label}: ${pct}`;
  return (
    <span
      title={title}
      className={clsx(
        'inline-flex max-w-full items-center gap-1 overflow-hidden whitespace-nowrap rounded-full font-semibold tabular-nums text-fg',
        compact ? 'px-1.5 py-px text-[10px] leading-4' : 'px-2 py-0.5 text-[11px] leading-4',
      )}
      style={{ background: coloured ? wash(color, 16) : chartTokens.surface2 }}
    >
      {coloured && (
        <span aria-hidden="true" className="text-[8px] leading-none" style={{ color }}>
          {STATUS_GLYPH[comparison.status]}
        </span>
      )}
      <span>{pct}</span>
      {coloured && !dense && <span className="font-normal text-muted">/ {formatPercent(comparison.benchmark)}</span>}
    </span>
  );
}

/**
 * The six-stage sales funnel as proportional bars with the stage-to-stage ratio between each pair.
 * With `showBenchmarks` each ratio chip is graded against the company benchmark (green at or above,
 * amber a little under, red well under) with a glyph and tooltip so colour is never the only signal.
 */
export function FunnelChart({
  totals,
  ratios,
  showBenchmarks = false,
  orientation = 'horizontal',
  compact = false,
  className,
  benchmarks,
  barHeight,
  ariaLabel,
  emptyMessage = 'No gauges logged yet',
}: FunnelChartProps) {
  const resolvedBarHeight = barHeight ?? (compact ? 56 : 120);
  const hasData = GAUGE_KEYS.some((k) => totals[k] > 0);
  const [containerRef, width] = useContainerWidth();
  // Chip layout by available width: below ~560px the "/ benchmark" suffix goes (tooltip keeps it);
  // below 420px (300px compact) the five chips collapse into one wrapping "vs benchmark" legend row.
  const chipMode: 'full' | 'tight' | 'legend' = width < (compact ? 300 : 420) ? 'legend' : !compact && width < 560 ? 'tight' : 'full';

  if (!hasData) {
    return (
      <EmptyChart
        height={orientation === 'horizontal' ? resolvedBarHeight + 64 : compact ? 160 : 240}
        message={emptyMessage}
        hint={compact ? undefined : 'Record stops, table, presentations, closes, taps and sales to see the funnel.'}
        className={className}
      />
    );
  }

  const r = ratios ?? funnelRatios(totals);
  const comparisons = compareToBenchmark(r, benchmarks);
  const byKey = new Map(comparisons.map((c) => [c.key, c]));
  const max = Math.max(totals.stops, ...GAUGE_KEYS.map((k) => totals[k]), 1);
  const labels = compact ? GAUGE_SHORT_LABELS : GAUGE_LABELS;
  const colour = seriesColor(0);

  const summary =
    ariaLabel ??
    `Sales funnel: ${GAUGE_KEYS.map((k) => `${formatNumber(totals[k])} ${GAUGE_LABELS[k].toLowerCase()}`).join(', ')} — ${formatPercent(r.overallConversion, 1)} of stops became sales.` +
      (showBenchmarks
        ? ` ${ratioKeys
            .map((step) => {
              const c = byKey.get(step.key)!;
              return totals[step.from] > 0
                ? `${step.label} ${formatPercent(c.actual)} (${STATUS_TEXT[c.status]}, benchmark ${formatPercent(c.benchmark)})`
                : `${step.label} no data`;
            })
            .join('; ')}.`
        : '');

  const barFor = (k: GaugeKey, i: number) => ({ background: colour, opacity: STAGE_OPACITY[i], size: (totals[k] / max) * 100 });

  if (orientation === 'vertical') {
    const labelWidth = compact ? 48 : 104;
    const rowHeight = compact ? 14 : 20;
    const columns = `${labelWidth}px minmax(0, 1fr) auto`;
    return (
      <div role="img" aria-label={summary} className={clsx('w-full', className)}>
        <div className={clsx('flex flex-col', compact ? 'gap-0.5' : 'gap-1')}>
          {GAUGE_KEYS.map((k, i) => {
            const bar = barFor(k, i);
            const step = i < ratioKeys.length ? ratioKeys[i] : null;
            return (
              <Fragment key={k}>
                <div className="grid items-center gap-2" style={{ gridTemplateColumns: columns }}>
                  <span className={clsx('truncate text-muted', compact ? 'text-[10px]' : 'text-xs')}>{labels[k]}</span>
                  <div className="w-full" style={{ height: rowHeight }}>
                    <div
                      className="h-full rounded-r"
                      style={{ width: `${bar.size}%`, minWidth: totals[k] > 0 ? 3 : 0, background: bar.background, opacity: bar.opacity }}
                    />
                  </div>
                  <span className={clsx('min-w-[3ch] text-right font-semibold tabular-nums text-fg', compact ? 'text-xs' : 'text-sm')}>{formatNumber(totals[k])}</span>
                </div>
                {step && (
                  <div className="grid gap-2" style={{ gridTemplateColumns: columns }}>
                    <span />
                    <div className={clsx('flex items-center', compact ? 'py-0' : 'py-0.5')}>
                      <RatioChip step={step} comparison={byKey.get(step.key)!} fromCount={totals[step.from]} showBenchmarks={showBenchmarks} compact={compact} />
                    </div>
                    <span />
                  </div>
                )}
              </Fragment>
            );
          })}
        </div>
      </div>
    );
  }

  // Horizontal: a 12-column grid so each ratio chip sits centred on the boundary between two stages.
  const valueBand = compact ? 16 : 20;
  return (
    <div ref={containerRef} role="img" aria-label={summary} className={clsx('w-full', className)}>
      <div className="grid gap-y-1" style={{ gridTemplateColumns: 'repeat(12, minmax(0, 1fr))' }}>
        {GAUGE_KEYS.map((k, i) => {
          const bar = barFor(k, i);
          const px = (bar.size / 100) * resolvedBarHeight;
          return (
            <div
              key={k}
              className="relative"
              style={{ gridColumn: `${2 * i + 1} / span 2`, gridRow: 1, height: resolvedBarHeight + valueBand }}
            >
              <span
                className={clsx('absolute left-0 right-0 text-center font-semibold tabular-nums leading-none text-fg', compact ? 'text-[11px]' : 'text-sm')}
                style={{ bottom: px + 4 }}
              >
                {formatNumber(totals[k])}
              </span>
              <div
                className={clsx('absolute bottom-0 rounded-t', compact ? 'left-1 right-1' : 'left-1.5 right-1.5')}
                style={{ height: px, minHeight: totals[k] > 0 ? 3 : 0, background: bar.background, opacity: bar.opacity }}
              />
            </div>
          );
        })}
        {GAUGE_KEYS.map((k, i) => (
          <div
            key={`${k}-label`}
            className={clsx('truncate text-center text-muted', compact ? 'text-[10px]' : 'text-[11px]')}
            style={{ gridColumn: `${2 * i + 1} / span 2`, gridRow: 2 }}
          >
            {labels[k]}
          </div>
        ))}
        {chipMode === 'legend' ? (
          <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1" style={{ gridColumn: '1 / -1', gridRow: 3 }}>
            {showBenchmarks && <span className={clsx('text-muted', compact ? 'text-[10px]' : 'text-[11px]')}>vs benchmark:</span>}
            {ratioKeys.map((step) => (
              <span key={step.key} className="inline-flex items-center gap-1">
                <span className={clsx('text-muted', compact ? 'text-[10px]' : 'text-[11px]')}>{RATIO_SHORT_LABELS[step.key]}</span>
                <RatioChip step={step} comparison={byKey.get(step.key)!} fromCount={totals[step.from]} showBenchmarks={showBenchmarks} compact={compact} dense />
              </span>
            ))}
          </div>
        ) : (
          ratioKeys.map((step, i) => (
            <div key={step.key} className="flex min-w-0 justify-center" style={{ gridColumn: `${2 * i + 2} / span 2`, gridRow: 3 }}>
              <RatioChip step={step} comparison={byKey.get(step.key)!} fromCount={totals[step.from]} showBenchmarks={showBenchmarks} compact={compact} dense={compact || chipMode === 'tight'} />
            </div>
          ))
        )}
      </div>
    </div>
  );
}
