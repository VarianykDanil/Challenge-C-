import clsx from 'clsx';

export interface ProgressBarProps {
  value: number;
  max?: number;
  tone?: 'primary' | 'success' | 'warning' | 'danger' | 'accent' | 'info';
  /** Entity colour override (hex). */
  color?: string;
  label?: string;
  showValue?: boolean;
  /** Format the value text; defaults to a rounded percentage. */
  formatValue?: (value: number, max: number) => string;
  size?: 'xs' | 'sm' | 'md' | 'lg';
  /** Optional benchmark marker as a fraction of max (e.g. the law-of-averages target). */
  marker?: number;
  /** Fill colour follows the value: danger < 50%, warning < 100%, success ≥ 100% of the marker or max. */
  auto?: boolean;
  className?: string;
}

const TONE = {
  primary: 'bg-primary',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
  accent: 'bg-accent',
  info: 'bg-info',
} as const;

const SIZE = { xs: 'h-1', sm: 'h-1.5', md: 'h-2.5', lg: 'h-3.5' } as const;

export function ProgressBar({ value, max = 100, tone = 'primary', color, label, showValue, formatValue, size = 'md', marker, auto, className }: ProgressBarProps) {
  const ratio = max > 0 ? Math.max(0, value / max) : 0;
  const pct = Math.min(100, ratio * 100);
  const target = marker ?? 1;
  const autoTone = ratio >= target ? 'success' : ratio >= target * 0.5 ? 'warning' : 'danger';
  const fill = color ? undefined : TONE[auto ? autoTone : tone];
  const text = formatValue ? formatValue(value, max) : `${Math.round(pct)}%`;
  return (
    <div className={className}>
      {(label || showValue) && (
        <div className="mb-1.5 flex items-baseline justify-between gap-3 text-xs">
          <span className="font-medium text-muted">{label}</span>
          {showValue && <span className="tabular font-semibold text-fg">{text}</span>}
        </div>
      )}
      <div
        className={clsx('relative w-full overflow-hidden rounded-full bg-surface-3/80', SIZE[size])}
        role="progressbar"
        aria-valuenow={Math.round(value)}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-label={label}
      >
        <div
          className={clsx('h-full rounded-full transition-[width] duration-500 ease-out', fill)}
          style={{ width: `${pct}%`, backgroundColor: color }}
        />
        {marker != null && marker > 0 && marker < 1 && (
          <span
            className="absolute inset-y-0 w-0.5 bg-fg/60"
            style={{ left: `${marker * 100}%` }}
            aria-hidden
          />
        )}
      </div>
    </div>
  );
}
