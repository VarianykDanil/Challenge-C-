import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react';
import clsx from 'clsx';

export interface StatDeltaProps {
  /** Fractional change, e.g. 0.12 = +12%. `null`/`undefined` renders a neutral "—" pill. */
  value: number | null | undefined;
  /** When true, a negative change is good (costs, days late). */
  invert?: boolean;
  /** Trailing text, e.g. "vs last week". */
  label?: string;
  size?: 'sm' | 'md';
  /** Format the number; defaults to a signed whole percentage. */
  format?: (value: number) => string;
  /** Render without the tinted background. */
  plain?: boolean;
  className?: string;
}

const defaultFormat = (v: number) => `${v > 0 ? '+' : ''}${(v * 100).toFixed(Math.abs(v) < 0.1 && v !== 0 ? 1 : 0)}%`;

/** Compact "+12%" pill with a direction arrow; colour never carries the meaning alone. */
export function StatDelta({ value, invert, label, size = 'sm', format = defaultFormat, plain, className }: StatDeltaProps) {
  const isNil = value == null || !Number.isFinite(value);
  const flat = !isNil && Math.abs(value) < 0.0005;
  const good = isNil || flat ? null : invert ? value < 0 : value > 0;
  const Icon = isNil || flat ? Minus : value > 0 ? ArrowUpRight : ArrowDownRight;
  const text = isNil ? '—' : format(value);
  const srText = isNil ? 'no comparison' : flat ? 'no change' : `${value > 0 ? 'up' : 'down'} ${text.replace(/^[+-]/, '')}`;
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1 whitespace-nowrap rounded-full font-semibold tabular',
        size === 'sm' ? 'h-5 px-1.5 text-[11px] [&_svg]:h-3 [&_svg]:w-3' : 'h-6 px-2 text-xs [&_svg]:h-3.5 [&_svg]:w-3.5',
        good === true && (plain ? 'text-success' : 'bg-success-soft text-success'),
        good === false && (plain ? 'text-danger' : 'bg-danger-soft text-danger'),
        good === null && (plain ? 'text-muted' : 'bg-surface-2 text-muted'),
        className,
      )}
      title={label}
    >
      <Icon aria-hidden strokeWidth={2.5} />
      <span aria-hidden>{text}</span>
      <span className="sr-only">{srText}{label ? ` ${label}` : ''}</span>
      {label && size === 'md' && <span className="ml-0.5 font-normal text-muted" aria-hidden>{label}</span>}
    </span>
  );
}
