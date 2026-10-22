// Release 1.3 — P8 venue-insights: the law of averages as a scatter — each dot one shift at the venue (stops across,
// sales up; anonymous), with the fitted line through the origin (sales per stop = Σ sales ÷ Σ stops). One series in
// chart slot 1, the fitted line in slot 2, both in the legend; dots carry a surface ring and a 24 px hover target;
// hairline grid; a screen-reader table of the three stop groups. Theme tokens only (light and dark follow index.css).
import { useId } from 'react';
import clsx from 'clsx';
import { CartesianGrid, ReferenceLine, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis } from 'recharts';
import type { VenuePoint, VenueStopBand } from '@lm/shared';
import { AXIS_TICK, EmptyChart, chartTokens, seriesColor } from '@/components/charts';
import { formatDateShort, formatNumber } from '@/lib/format';

export interface LawOfAveragesChartProps {
  points: VenuePoint[];
  /** Sales per stop of the fitted line. */
  fittedRate: number;
  bands: VenueStopBand[];
  height?: number;
  className?: string;
}

const BAND_LABEL: Record<VenueStopBand['band'], string> = { fewest: 'Fewest stops', middle: 'Middle', most: 'Most stops' };

interface DotProps {
  cx?: number;
  cy?: number;
}

/** A 9 px dot with a 2 px surface ring, inside a transparent 24 px hit area. */
function Dot({ cx, cy }: DotProps) {
  if (cx == null || cy == null) return null;
  return (
    <g>
      <circle cx={cx} cy={cy} r={12} fill="transparent" />
      <circle cx={cx} cy={cy} r={4.5} fill={seriesColor(0)} fillOpacity={0.55} stroke={chartTokens.surface} strokeWidth={1.5} />
    </g>
  );
}

interface TipProps {
  active?: boolean;
  payload?: ReadonlyArray<{ payload?: VenuePoint }>;
}

function PointTooltip({ active, payload }: TipProps) {
  const p = active ? payload?.[0]?.payload : undefined;
  if (!p) return null;
  return (
    <div role="presentation" className="rounded-md border border-border bg-surface px-3 py-2 text-xs text-fg shadow-md" style={{ pointerEvents: 'none' }}>
      <div className="mb-1 font-medium text-muted">{formatDateShort(p.date)}</div>
      <div><span className="font-semibold tabular-nums">{formatNumber(p.stops)}</span> <span className="text-muted">stops</span></div>
      <div><span className="font-semibold tabular-nums">{formatNumber(p.sales)}</span> <span className="text-muted">{p.sales === 1 ? 'sale' : 'sales'}</span></div>
    </div>
  );
}

export function LawOfAveragesChart({ points, fittedRate, bands, height = 260, className }: LawOfAveragesChartProps) {
  const id = useId();
  if (!points.length) return <EmptyChart height={height} message="No shifts logged here yet" className={className} />;
  const maxStops = points.reduce((m, p) => Math.max(m, p.stops), 0);
  const maxSales = points.reduce((m, p) => Math.max(m, p.sales), 0);
  const xMax = Math.max(10, Math.ceil((maxStops * 1.05) / 10) * 10);
  const yMax = Math.max(2, Math.ceil(Math.max(maxSales, xMax * fittedRate)));
  const every = fittedRate > 0 ? Math.round(1 / fittedRate) : null;
  const lineLabel = every ? `Fitted: 1 sale every ${formatNumber(every)} stops` : 'Fitted line';
  const summary = `Scatter of ${formatNumber(points.length)} shifts, stops against sales.${every ? ` The fitted line makes a sale every ${formatNumber(every)} stops.` : ''}${bands.length ? ` ${bands.map((b) => `${BAND_LABEL[b.band]} (${formatNumber(b.minStops)}–${formatNumber(b.maxStops)} stops): ${formatNumber(b.salesPerShift)} sales a shift`).join('; ')}.` : ''}`;

  return (
    <div className={clsx('w-full', className)}>
      <div role="img" aria-label={summary} style={{ height }} data-venue-scatter>
        <ResponsiveContainer width="100%" height="100%">
          <ScatterChart margin={{ top: 8, right: 12, bottom: 4, left: 0 }}>
            <CartesianGrid stroke={chartTokens.border} strokeWidth={1} />
            <XAxis
              type="number"
              dataKey="stops"
              name="Stops"
              domain={[0, xMax]}
              tick={AXIS_TICK}
              axisLine={false}
              tickLine={false}
              tickMargin={6}
              label={{ value: 'Stops in the shift', position: 'insideBottom', offset: -2, fill: chartTokens.muted, fontSize: 11 }}
              height={36}
            />
            <YAxis
              type="number"
              dataKey="sales"
              name="Sales"
              domain={[0, yMax]}
              allowDecimals={false}
              tick={AXIS_TICK}
              axisLine={false}
              tickLine={false}
              width={36}
              label={{ value: 'Sales', angle: -90, position: 'insideLeft', offset: 12, fill: chartTokens.muted, fontSize: 11 }}
            />
            <Tooltip content={<PointTooltip />} cursor={false} isAnimationActive={false} />
            {fittedRate > 0 && (
              <ReferenceLine
                segment={[{ x: 0, y: 0 }, { x: xMax, y: xMax * fittedRate }]}
                stroke={seriesColor(1)}
                strokeWidth={2}
                strokeLinecap="round"
                ifOverflow="hidden"
              />
            )}
            <Scatter data={points} shape={<Dot />} isAnimationActive={false} name="Shifts" />
          </ScatterChart>
        </ResponsiveContainer>
      </div>
      {/* the legend mirrors the marks: a ringed dot for shifts, a line key for the fitted line */}
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
        <li className="flex items-center gap-2">
          <span aria-hidden className="inline-block h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: seriesColor(0), opacity: 0.7 }} />
          {formatNumber(points.length)} {points.length === 1 ? 'shift' : 'shifts'} (one dot each)
        </li>
        {fittedRate > 0 && (
          <li className="flex items-center gap-2">
            <span aria-hidden className="inline-block h-0.5 w-3 shrink-0 rounded-full" style={{ background: seriesColor(1) }} />
            {lineLabel}
          </li>
        )}
      </ul>
      {bands.length > 0 && (
        <div className="sr-only">
          <table aria-describedby={`${id}-cap`}>
            <caption id={`${id}-cap`}>Shifts in three groups by stops</caption>
            <thead>
              <tr><th scope="col">Group</th><th scope="col">Stops</th><th scope="col">Shifts</th><th scope="col">Sales a shift</th></tr>
            </thead>
            <tbody>
              {bands.map((b) => (
                <tr key={b.band}><th scope="row">{BAND_LABEL[b.band]}</th><td>{b.minStops}–{b.maxStops}</td><td>{b.shifts}</td><td>{b.salesPerShift}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
