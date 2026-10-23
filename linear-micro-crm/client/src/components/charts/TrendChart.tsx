import { useId, type ReactNode } from 'react';
import clsx from 'clsx';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { ChartLegend } from './ChartLegend';
import { ChartTooltip } from './ChartTooltip';
import { EmptyChart } from './EmptyChart';
import { AXIS_TICK, CHART_MARGIN, MAX_BAR_SIZE, chartTokens, formatCompact, formatNumber, joinList, seriesColor } from './theme';

export interface TrendSeries {
  key: string;
  label: string;
  color?: string;
}

type DomainItem = number | 'auto' | 'dataMin' | 'dataMax';

export interface TrendChartProps {
  data: Array<Record<string, string | number>>;
  xKey: string;
  series: TrendSeries[];
  height?: number;
  kind?: 'line' | 'area' | 'bar';
  /** format tick labels on x axis */
  xFormatter?: (v: string) => string;
  yFormatter?: (v: number) => string;
  /** Y-axis tick labels only (default: `yFormatter`, else compact numbers); the tooltip keeps `yFormatter`. */
  yTickFormatter?: (v: number) => string;
  stacked?: boolean;
  className?: string;
  /** Draw a horizontal reference (target / benchmark) line at this y value. */
  referenceY?: number;
  /** Label for the reference line, e.g. "Target". */
  referenceLabel?: string;
  /** Default: shown only when there is more than one series. */
  showLegend?: boolean;
  emptyMessage?: string;
  /** Override the generated accessible summary. */
  ariaLabel?: string;
  /** Fix the y axis, e.g. [0, 100] or [0, 'auto']. */
  yDomain?: [DomainItem, DomainItem];
  /** Join line/area segments across missing points. */
  connectNulls?: boolean;
  /** Recharts syncId — hover one chart, highlight the same x in the others. */
  syncId?: string;
}

const KIND_NAME = { line: 'Line', area: 'Area', bar: 'Bar' } as const;

function summarise(
  kind: 'line' | 'area' | 'bar',
  data: TrendChartProps['data'],
  xKey: string,
  series: TrendSeries[],
  fx: (v: string) => string,
  fy: (v: number) => string,
): string {
  const n = data.length;
  const first = fx(String(data[0]?.[xKey] ?? ''));
  const last = fx(String(data[n - 1]?.[xKey] ?? ''));
  const parts = series.map((s) => {
    const values = data.map((d) => Number(d[s.key])).filter((v) => Number.isFinite(v));
    const total = values.reduce((a, b) => a + b, 0);
    const latest = values.length ? values[values.length - 1] : 0;
    return `${s.label} total ${fy(total)}, latest ${fy(latest)}`;
  });
  const span = n > 1 ? `from ${first} to ${last}` : `at ${first}`;
  return `${KIND_NAME[kind]} chart of ${joinList(series.map((s) => s.label))} over ${n} ${n === 1 ? 'point' : 'points'} ${span}. ${parts.join('; ')}.`;
}

/**
 * Time-series chart (line, area or bar) with one y axis, thin marks, a hairline grid and a shared
 * tooltip listing every series at the hovered x. Dots appear only on hover.
 */
export function TrendChart({
  data,
  xKey,
  series,
  height = 220,
  kind = 'line',
  xFormatter,
  yFormatter,
  yTickFormatter,
  stacked = false,
  className,
  referenceY,
  referenceLabel,
  showLegend,
  emptyMessage = 'No data for this period',
  ariaLabel,
  yDomain,
  connectNulls = true,
  syncId,
}: TrendChartProps) {
  const gradientBase = `trend-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const fx = xFormatter ?? ((v: string) => v);
  const fy = yFormatter ?? formatNumber;
  const hasData = data.length > 0 && series.length > 0 && series.some((s) => data.some((d) => Number.isFinite(Number(d[s.key]))));

  if (!hasData) return <EmptyChart height={height} message={emptyMessage} className={className} />;

  const colors = series.map((s, i) => seriesColor(i, s.color));
  const legend = showLegend ?? series.length > 1;
  const label = ariaLabel ?? summarise(kind, data, xKey, series, fx, fy);
  const stackId = stacked ? 'stack' : undefined;

  const axes: ReactNode[] = [
    <CartesianGrid key="grid" vertical={false} stroke={chartTokens.border} strokeWidth={1} />,
    <XAxis
      key="x"
      dataKey={xKey}
      tickFormatter={(v: string | number) => fx(String(v))}
      tick={AXIS_TICK}
      axisLine={false}
      tickLine={false}
      tickMargin={8}
      minTickGap={24}
      interval="preserveStartEnd"
    />,
    <YAxis
      key="y"
      tickFormatter={(v: number) => (yTickFormatter ? yTickFormatter(v) : yFormatter ? yFormatter(v) : formatCompact(v))}
      tick={AXIS_TICK}
      axisLine={false}
      tickLine={false}
      width={44}
      allowDecimals={false}
      domain={yDomain}
    />,
    <Tooltip
      key="tooltip"
      content={<ChartTooltip labelFormatter={fx} valueFormatter={yFormatter ? (v) => yFormatter(v) : undefined} />}
      cursor={kind === 'bar' ? { fill: chartTokens.surface2 } : { stroke: chartTokens.border, strokeWidth: 1 }}
      isAnimationActive={false}
    />,
  ];
  if (referenceY !== undefined) {
    axes.push(
      <ReferenceLine
        key="ref"
        y={referenceY}
        stroke={chartTokens.muted}
        strokeWidth={1}
        strokeDasharray="4 4"
        ifOverflow="extendDomain"
        label={referenceLabel ? { value: referenceLabel, position: 'insideTopRight', fill: chartTokens.muted, fontSize: 11 } : undefined}
      />,
    );
  }

  let marks: ReactNode[];
  if (kind === 'bar') {
    marks = series.map((s, i) => {
      const isTop = !stacked || i === series.length - 1;
      return (
        <Bar
          key={s.key}
          dataKey={s.key}
          name={s.label}
          fill={colors[i]}
          stackId={stackId}
          maxBarSize={MAX_BAR_SIZE}
          radius={isTop ? [4, 4, 0, 0] : 0}
          stroke={stacked ? chartTokens.surface : undefined}
          strokeWidth={stacked ? 1 : 0}
          activeBar={{ fillOpacity: 0.8 }}
          isAnimationActive={false}
        />
      );
    });
  } else if (kind === 'area') {
    marks = [
      <defs key="defs">
        {series.map((s, i) => (
          <linearGradient key={s.key} id={`${gradientBase}-${i}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" style={{ stopColor: colors[i], stopOpacity: stacked ? 0.35 : 0.25 }} />
            <stop offset="100%" style={{ stopColor: colors[i], stopOpacity: stacked ? 0.15 : 0.02 }} />
          </linearGradient>
        ))}
      </defs>,
      ...series.map((s, i) => (
        <Area
          key={s.key}
          type="monotone"
          dataKey={s.key}
          name={s.label}
          stroke={colors[i]}
          strokeWidth={2}
          fill={`url(#${gradientBase}-${i})`}
          stackId={stackId}
          dot={false}
          activeDot={{ r: 4, strokeWidth: 2, stroke: chartTokens.surface, fill: colors[i] }}
          connectNulls={connectNulls}
          isAnimationActive={false}
        />
      )),
    ];
  } else {
    marks = series.map((s, i) => (
      <Line
        key={s.key}
        type="monotone"
        dataKey={s.key}
        name={s.label}
        stroke={colors[i]}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        dot={false}
        activeDot={{ r: 4, strokeWidth: 2, stroke: chartTokens.surface, fill: colors[i] }}
        connectNulls={connectNulls}
        isAnimationActive={false}
      />
    ));
  }

  const common = { data, margin: CHART_MARGIN, syncId };

  return (
    <div className={clsx('w-full', className)}>
      <div role="img" aria-label={label} style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          {kind === 'bar' ? (
            <BarChart {...common} barGap={2} barCategoryGap="25%">
              {axes}
              {marks}
            </BarChart>
          ) : kind === 'area' ? (
            <AreaChart {...common}>
              {axes}
              {marks}
            </AreaChart>
          ) : (
            <LineChart {...common}>
              {axes}
              {marks}
            </LineChart>
          )}
        </ResponsiveContainer>
      </div>
      {legend && (
        <ChartLegend
          className="mt-2"
          items={series.map((s, i) => ({ label: s.label, color: colors[i], shape: kind === 'bar' ? 'square' : 'line' }))}
        />
      )}
      {data.length <= 100 && (
        <div className="sr-only">{/* a <table> treats width as a minimum, so the clipping box must be a div */}<table>
          <caption>{label}</caption>
          <thead>
            <tr>
              <th scope="col">{xKey}</th>
              {series.map((s) => (
                <th key={s.key} scope="col">
                  {s.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.map((d, i) => (
              <tr key={i}>
                <th scope="row">{fx(String(d[xKey]))}</th>
                {series.map((s) => (
                  <td key={s.key}>{Number.isFinite(Number(d[s.key])) ? fy(Number(d[s.key])) : '—'}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
    </div>
  );
}
