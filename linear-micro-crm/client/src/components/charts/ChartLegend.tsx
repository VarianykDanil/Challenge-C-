import clsx from 'clsx';

export interface LegendItem {
  label: string;
  color: string;
  /** Pre-formatted value shown after the label (e.g. "1,284" or "38%"). */
  value?: string;
  /** Mirror the mark: a line key for lines, a square for bars/areas/slices. */
  shape?: 'line' | 'square';
}

export interface ChartLegendProps {
  items: ReadonlyArray<LegendItem>;
  className?: string;
  /** Stack rows vertically (donut side legend) instead of wrapping inline. */
  vertical?: boolean;
}

/** Small legend rendered in HTML below or beside a chart. Only render it when there are ≥ 2 series. */
export function ChartLegend({ items, className, vertical }: ChartLegendProps) {
  if (items.length === 0) return null;
  return (
    <ul className={clsx('m-0 list-none p-0 text-xs text-muted', vertical ? 'space-y-1.5' : 'flex flex-wrap gap-x-4 gap-y-1', className)}>
      {items.map((item) => (
        <li key={item.label} className={clsx('flex min-w-0 items-center gap-2', vertical && 'justify-between')}>
          <span className="flex min-w-0 items-center gap-2">
            <span
              aria-hidden="true"
              className={clsx('inline-block shrink-0', item.shape === 'line' ? 'h-0.5 w-3 rounded-full' : 'h-2.5 w-2.5 rounded-sm')}
              style={{ background: item.color }}
            />
            <span className="truncate">{item.label}</span>
          </span>
          {item.value !== undefined && <span className="shrink-0 font-medium tabular-nums text-fg">{item.value}</span>}
        </li>
      ))}
    </ul>
  );
}
