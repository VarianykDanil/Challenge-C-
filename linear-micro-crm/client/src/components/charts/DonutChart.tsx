import clsx from 'clsx';
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';
import { ChartLegend } from './ChartLegend';
import { ChartTooltip } from './ChartTooltip';
import { EmptyChart } from './EmptyChart';
import { chartTokens, formatNumber, formatPercent, seriesColor } from './theme';

export interface DonutDatum {
  label: string;
  value: number;
  color?: string;
}

export interface DonutChartProps {
  data: DonutDatum[];
  /** Diameter of the ring in px (default 160). */
  height?: number;
  centerLabel?: string;
  /** Defaults to the formatted total. */
  centerValue?: string;
  valueFormatter?: (v: number) => string;
  className?: string;
  /** Legend with values beside the ring (default true). */
  showLegend?: boolean;
  /** Slices beyond this count fold into "Other" (default 6 — part-to-whole stops reading past that). */
  maxSlices?: number;
  ariaLabel?: string;
  emptyMessage?: string;
}

interface Slice extends DonutDatum {
  share: number;
  fill: string;
}

/**
 * Part-to-whole ring with a centre figure and a legend that carries every value, so colour is never
 * the only way to read it.
 */
export function DonutChart({
  data,
  height = 160,
  centerLabel,
  centerValue,
  valueFormatter,
  className,
  showLegend = true,
  maxSlices = 6,
  ariaLabel,
  emptyMessage = 'Nothing to show yet',
}: DonutChartProps) {
  const fmt = valueFormatter ?? formatNumber;
  const clean = data.filter((d) => Number.isFinite(d.value) && d.value > 0);
  const total = clean.reduce((sum, d) => sum + d.value, 0);

  if (clean.length === 0 || total <= 0) return <EmptyChart height={height} message={emptyMessage} className={className} />;

  let folded: DonutDatum[] = clean;
  if (clean.length > maxSlices) {
    const keep = clean.slice(0, Math.max(1, maxSlices - 1));
    const rest = clean.slice(keep.length).reduce((sum, d) => sum + d.value, 0);
    folded = [...keep, { label: 'Other', value: rest }];
  }
  const slices: Slice[] = folded.map((d, i) => ({
    ...d,
    share: d.value / total,
    fill: d.label === 'Other' && !d.color ? chartTokens.muted : seriesColor(i, d.color),
  }));

  const summary =
    ariaLabel ??
    `Donut chart${centerLabel ? ` of ${centerLabel}` : ''}: ${slices.map((s) => `${s.label} ${fmt(s.value)} (${formatPercent(s.share)})`).join(', ')}; total ${fmt(total)}.`;

  return (
    <div className={clsx('flex flex-wrap items-center gap-x-6 gap-y-3', className)}>
      <div role="img" aria-label={summary} className="relative shrink-0" style={{ width: height, height }}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart margin={{ top: 0, right: 0, bottom: 0, left: 0 }}>
            <Tooltip
              content={<ChartTooltip hideLabel valueFormatter={(v) => `${fmt(v)} · ${formatPercent(v / total)}`} />}
              isAnimationActive={false}
            />
            <Pie
              data={slices}
              dataKey="value"
              nameKey="label"
              cx="50%"
              cy="50%"
              innerRadius="68%"
              outerRadius="96%"
              startAngle={90}
              endAngle={-270}
              minAngle={slices.length > 1 ? 3 : 0}
              stroke={chartTokens.surface}
              strokeWidth={2}
              isAnimationActive={false}
            >
              {slices.map((s, i) => (
                <Cell key={`${s.label}-${i}`} fill={s.fill} />
              ))}
            </Pie>
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center px-4 text-center">
          <span className="text-xl font-semibold leading-none text-fg">{centerValue ?? fmt(total)}</span>
          {centerLabel && <span className="mt-1 max-w-full truncate text-[11px] text-muted">{centerLabel}</span>}
        </div>
      </div>
      {showLegend && (
        <ChartLegend
          vertical
          className="min-w-[8rem] flex-1"
          items={slices.map((s) => ({ label: s.label, color: s.fill, shape: 'square', value: `${fmt(s.value)} · ${formatPercent(s.share)}` }))}
        />
      )}
    </div>
  );
}
