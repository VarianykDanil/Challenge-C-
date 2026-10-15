import type { ReactNode } from 'react';
import { formatNumber } from './theme';

/** The subset of a Recharts tooltip payload item we render. */
export interface ChartTooltipItem {
  name?: string | number;
  value?: number | string | ReadonlyArray<number | string>;
  color?: string;
  fill?: string;
  stroke?: string;
  dataKey?: string | number;
  payload?: Record<string, unknown>;
}

export interface ChartTooltipProps {
  /** Injected by Recharts */
  active?: boolean;
  /** Injected by Recharts */
  payload?: ReadonlyArray<ChartTooltipItem>;
  /** Injected by Recharts */
  label?: string | number;
  /** Format the heading (usually the x value). */
  labelFormatter?: (label: string) => string;
  /** Format each value; receives the series name/dataKey for per-series formatting. */
  valueFormatter?: (value: number, seriesKey: string) => string;
  /** Extra line under the rows, e.g. a share of total. */
  footer?: (items: ReadonlyArray<ChartTooltipItem>) => ReactNode;
  hideLabel?: boolean;
}

/**
 * Shared tooltip for every Recharts chart: surface background, hairline border, value first and
 * strong, series name second, keyed by a short line of the series colour.
 * Use as `<Tooltip content={<ChartTooltip />} />`.
 */
export function ChartTooltip({ active, payload, label, labelFormatter, valueFormatter, footer, hideLabel }: ChartTooltipProps) {
  if (!active || !payload || payload.length === 0) return null;
  const items = payload.filter((p) => p.value !== undefined && p.value !== null);
  if (items.length === 0) return null;
  const heading = hideLabel || label === undefined || label === null ? null : labelFormatter ? labelFormatter(String(label)) : String(label);

  return (
    <div
      role="presentation"
      className="min-w-[8rem] rounded-md border border-border bg-surface px-3 py-2 text-xs text-fg shadow-md"
      style={{ pointerEvents: 'none' }}
    >
      {heading !== null && heading !== '' && <div className="mb-1.5 font-medium text-muted">{heading}</div>}
      <ul className="m-0 list-none space-y-1 p-0">
        {items.map((item, i) => {
          const key = String(item.dataKey ?? item.name ?? i);
          const raw = Array.isArray(item.value) ? item.value[item.value.length - 1] : item.value;
          const n = typeof raw === 'number' ? raw : Number(raw);
          const text = Number.isFinite(n) ? (valueFormatter ? valueFormatter(n, key) : formatNumber(n)) : String(raw ?? '');
          const color = item.color ?? item.fill ?? item.stroke ?? 'var(--color-muted)';
          return (
            <li key={key} className="flex items-center gap-2">
              <span aria-hidden="true" className="inline-block h-0.5 w-3 shrink-0 rounded-full" style={{ background: color }} />
              <span className="font-semibold tabular-nums text-fg">{text}</span>
              {item.name !== undefined && <span className="truncate text-muted">{String(item.name)}</span>}
            </li>
          );
        })}
      </ul>
      {footer && <div className="mt-1.5 border-t border-border pt-1.5 text-muted">{footer(items)}</div>}
    </div>
  );
}
