import clsx from 'clsx';

export interface EmptyChartProps {
  /** Height in px, matching the chart it stands in for. */
  height?: number;
  message?: string;
  /** Optional second line, e.g. "Log your first gauges to see the funnel". */
  hint?: string;
  className?: string;
}

/** Placeholder shown in place of a chart when there is nothing to plot. */
export function EmptyChart({ height = 192, message = 'No data for this period', hint, className }: EmptyChartProps) {
  return (
    <div
      role="img"
      aria-label={hint ? `${message}. ${hint}` : message}
      className={clsx('flex w-full flex-col items-center justify-center gap-1 rounded-lg border border-border bg-surface-2 px-4 text-center', className)}
      style={{ height }}
    >
      <svg aria-hidden="true" width="28" height="20" viewBox="0 0 28 20" fill="none" className="text-muted opacity-60">
        <rect x="1" y="11" width="5" height="8" rx="1" fill="currentColor" />
        <rect x="9" y="6" width="5" height="13" rx="1" fill="currentColor" />
        <rect x="17" y="1" width="5" height="18" rx="1" fill="currentColor" opacity="0.5" />
      </svg>
      <span className="text-sm text-muted">{message}</span>
      {hint && <span className="text-xs text-muted opacity-80">{hint}</span>}
    </div>
  );
}
