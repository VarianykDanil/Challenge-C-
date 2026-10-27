import type { ReactNode } from 'react';
import clsx from 'clsx';
import { StatDelta } from './StatDelta';

export type KpiTone = 'default' | 'primary' | 'accent' | 'success' | 'warning' | 'danger' | 'info';

export interface KpiTileProps {
  label: string;
  value: ReactNode;
  /** fractional change vs previous period, e.g. 0.12 = +12% */
  delta?: number | null;
  deltaLabel?: string;
  /** when true, a negative delta is good (e.g. cost) */
  invertDelta?: boolean;
  icon?: ReactNode;
  hint?: string;
  /**
   * Lines the hint may wrap to before it is clamped (default 2). With 3 (the dashboard's Sales tile) the hint also takes
   * a line of its own under the delta, without the leading "·", so all three lines are its own.
   */
  hintLines?: 2 | 3;
  tone?: KpiTone;
  /** Small chart rendered in the bottom-right (e.g. <Sparkline />). */
  sparkline?: ReactNode;
  className?: string;
  /** Loading skeleton. */
  loading?: boolean;
  /** Smaller tile for dense dashboards. */
  size?: 'sm' | 'md' | 'lg';
  /** Make the whole tile a button/link target. */
  onClick?: () => void;
  /** Small unit or suffix next to the value, e.g. "%" or "/ day". */
  suffix?: ReactNode;
}

const CHIP: Record<KpiTone, string> = {
  default: 'bg-surface-2 text-muted ring-1 ring-inset ring-border',
  primary: 'bg-primary-soft text-primary',
  accent: 'bg-accent-soft text-accent',
  success: 'bg-success-soft text-success',
  warning: 'bg-warning-soft text-warning',
  danger: 'bg-danger-soft text-danger',
  info: 'bg-info-soft text-info',
};

// Literal class names so Tailwind generates both.
const HINT_CLAMP = { 2: 'line-clamp-2', 3: 'line-clamp-3' } as const;

const EDGE: Record<KpiTone, string> = {
  default: '',
  primary: 'before:bg-primary',
  accent: 'before:bg-accent',
  success: 'before:bg-success',
  warning: 'before:bg-warning',
  danger: 'before:bg-danger',
  info: 'before:bg-info',
};

// clamp(): the number shrinks with the viewport instead of truncating (desktop sizes stay 20 / 28 / 36px).
// The figure scales with the tile's own width (container units), never the screen's, and never wraps: a narrow tile
// (six in a row at 1280 px) used to break "£10,440" into "£10,44" over "0".
const VALUE_SIZE = {
  sm: 'text-[clamp(1rem,13cqi,1.25rem)]',
  md: 'text-[clamp(1.0625rem,14cqi,1.75rem)]',
  lg: 'text-[clamp(1.25rem,16cqi,2.25rem)]',
} as const;

export function KpiTile({ label, value, delta, deltaLabel, invertDelta, icon, hint, hintLines = 2, tone = 'default', sparkline, className, loading, size = 'md', onClick, suffix }: KpiTileProps) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      className={clsx(
        '@container relative flex w-full flex-col overflow-hidden rounded-xl border border-border bg-surface text-left shadow-card',
        size === 'sm' ? 'p-4' : 'p-5',
        tone !== 'default' && 'before:absolute before:inset-y-0 before:left-0 before:w-1 before:content-[""]',
        EDGE[tone],
        onClick && 'card-hover focus-ring cursor-pointer',
        className,
      )}
      aria-busy={loading || undefined}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 truncate text-xs font-medium text-muted">{label}</div>
        {icon && (
          <span className={clsx('inline-flex shrink-0 items-center justify-center rounded-lg', size === 'sm' ? 'h-7 w-7 [&_svg]:h-3.5 [&_svg]:w-3.5' : 'h-8 w-8 [&_svg]:h-4 [&_svg]:w-4', CHIP[tone])} aria-hidden>
            {icon}
          </span>
        )}
      </div>

      <div className="mt-3 flex items-end justify-between gap-3">
        <div className="min-w-0">
          {loading ? (
            <div className={clsx('skeleton rounded-md', size === 'sm' ? 'h-6 w-20' : 'h-8 w-28')} aria-hidden />
          ) : (
            <div className={clsx('kpi-number flex min-w-0 flex-wrap items-baseline gap-1 text-fg', VALUE_SIZE[size])}>
              <span className="min-w-0 whitespace-nowrap">{value}</span>
              {suffix && <span className="font-sans text-sm font-medium text-muted">{suffix}</span>}
            </div>
          )}
          {(delta !== undefined || hint) && (
            <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
              {delta !== undefined && !loading && <StatDelta value={delta} invert={invertDelta} />}
              {delta !== undefined && !loading && <span className="line-clamp-2">{deltaLabel ?? 'vs previous period'}</span>}
              {hint && <span className={clsx(HINT_CLAMP[hintLines], hintLines === 3 ? 'basis-full' : delta !== undefined && 'before:mr-2 before:content-["·"]')}>{hint}</span>}
            </div>
          )}
        </div>
        {sparkline && <div className="shrink-0 text-primary [&>*]:block">{sparkline}</div>}
      </div>
    </Tag>
  );
}
