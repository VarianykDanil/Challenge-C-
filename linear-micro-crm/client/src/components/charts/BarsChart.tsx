import clsx from 'clsx';
import { Bar, BarChart, CartesianGrid, Cell, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { ChartLegend } from './ChartLegend';
import { ChartTooltip } from './ChartTooltip';
import { EmptyChart } from './EmptyChart';
import { AXIS_TICK, MAX_BAR_SIZE, chartTokens, formatCompact, formatNumber, seriesColor } from './theme';

export interface BarDatum {
  label: string;
  value: number;
  /** Per-bar colour, e.g. a team or campaign colour from the database. */
  color?: string;
  /** Optional second measure drawn as a neighbouring bar (e.g. target). */
  secondary?: number;
}

export interface BarsChartProps {
  data: BarDatum[];
  height?: number;
  horizontal?: boolean;
  valueFormatter?: (v: number) => string;
  secondaryLabel?: string;
  /** Name of the primary measure (legend / tooltip / accessible summary), e.g. "Sales". */
  label?: string;
  className?: string;
  /** Print the value at the tip of each bar (default true, off automatically past 16 bars). */
  showValues?: boolean;
  /** Default: shown only when a secondary series is present. */
  showLegend?: boolean;
  ariaLabel?: string;
  emptyMessage?: string;
}

/**
 * Categorical bar chart, vertical columns or horizontal bars, with a value at each tip, optional
 * per-bar colours (identity) and an optional secondary series.
 */
export function BarsChart({
  data,
  height,
  horizontal = false,
  valueFormatter,
  secondaryLabel,
  label,
  className,
  showValues,
  showLegend,
  ariaLabel,
  emptyMessage = 'No data for this period',
}: BarsChartProps) {
  const fmt = valueFormatter ?? formatNumber;
  const resolvedHeight = height ?? (horizontal ? Math.max(120, data.length * 32 + 24) : 220);

  if (data.length === 0) return <EmptyChart height={resolvedHeight} message={emptyMessage} className={className} />;

  const hasSecondary = data.some((d) => typeof d.secondary === 'number');
  const customColours = data.some((d) => Boolean(d.color));
  const primaryName = label ?? 'Value';
  const secondaryName = secondaryLabel ?? 'Secondary';
  const values = showValues ?? data.length <= 16;
  const legend = showLegend ?? hasSecondary;
  const longest = data.reduce((m, d) => Math.max(m, d.label.length), 0);
  const categoryWidth = Math.min(160, Math.max(56, longest * 6.5 + 12));

  const summaryItems = data.slice(0, 12).map((d) => `${d.label} ${fmt(d.value)}${hasSecondary && typeof d.secondary === 'number' ? ` (${secondaryName} ${fmt(d.secondary)})` : ''}`);
  const summary =
    ariaLabel ??
    `Bar chart of ${primaryName} by category: ${summaryItems.join(', ')}${data.length > 12 ? ` and ${data.length - 12} more` : ''}.`;

  const margin = horizontal ? { top: 4, right: values ? 48 : 12, bottom: 0, left: 0 } : { top: values ? 20 : 8, right: 12, bottom: 0, left: 0 };
  const valueLabelProps = { fill: chartTokens.fg, fontSize: 11, formatter: (v: number) => fmt(v) } as const;

  return (
    <div className={clsx('w-full', className)}>
      <div role="img" aria-label={summary} style={{ height: resolvedHeight }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} layout={horizontal ? 'vertical' : 'horizontal'} margin={margin} barGap={2} barCategoryGap="25%">
            <CartesianGrid horizontal={!horizontal} vertical={horizontal} stroke={chartTokens.border} strokeWidth={1} />
            {horizontal ? (
              <>
                <XAxis type="number" tick={AXIS_TICK} axisLine={false} tickLine={false} tickFormatter={formatCompact} allowDecimals={false} />
                <YAxis type="category" dataKey="label" width={categoryWidth} tick={AXIS_TICK} axisLine={false} tickLine={false} interval={0} />
              </>
            ) : (
              <>
                <XAxis dataKey="label" type="category" tick={AXIS_TICK} axisLine={false} tickLine={false} tickMargin={8} interval={data.length <= 10 ? 0 : 'preserveStartEnd'} />
                <YAxis type="number" tick={AXIS_TICK} axisLine={false} tickLine={false} width={44} tickFormatter={formatCompact} allowDecimals={false} />
              </>
            )}
            <Tooltip content={<ChartTooltip valueFormatter={(v) => fmt(v)} />} cursor={{ fill: chartTokens.surface2 }} isAnimationActive={false} />
            <Bar
              dataKey="value"
              name={primaryName}
              fill={seriesColor(0)}
              maxBarSize={MAX_BAR_SIZE}
              radius={horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0]}
              activeBar={{ fillOpacity: 0.8 }}
              isAnimationActive={false}
            >
              {customColours && data.map((d, i) => <Cell key={`${d.label}-${i}`} fill={seriesColor(0, d.color)} />)}
              {values && <LabelList dataKey="value" position={horizontal ? 'right' : 'top'} {...valueLabelProps} />}
            </Bar>
            {hasSecondary && (
              <Bar
                dataKey="secondary"
                name={secondaryName}
                fill={seriesColor(1)}
                maxBarSize={MAX_BAR_SIZE}
                radius={horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0]}
                activeBar={{ fillOpacity: 0.8 }}
                isAnimationActive={false}
              >
                {values && <LabelList dataKey="secondary" position={horizontal ? 'right' : 'top'} {...valueLabelProps} />}
              </Bar>
            )}
          </BarChart>
        </ResponsiveContainer>
      </div>
      {legend && (
        <ChartLegend
          className="mt-2"
          items={[
            { label: primaryName, color: seriesColor(0), shape: 'square' },
            ...(hasSecondary ? [{ label: secondaryName, color: seriesColor(1), shape: 'square' as const }] : []),
          ]}
        />
      )}
      <table className="sr-only">
        <caption>{summary}</caption>
        <thead>
          <tr>
            <th scope="col">Category</th>
            <th scope="col">{primaryName}</th>
            {hasSecondary && <th scope="col">{secondaryName}</th>}
          </tr>
        </thead>
        <tbody>
          {data.map((d, i) => (
            <tr key={`${d.label}-${i}`}>
              <th scope="row">{d.label}</th>
              <td>{fmt(d.value)}</td>
              {hasSecondary && <td>{typeof d.secondary === 'number' ? fmt(d.secondary) : '—'}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
