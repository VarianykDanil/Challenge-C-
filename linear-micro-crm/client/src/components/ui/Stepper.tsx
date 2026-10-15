import { useEffect, useId, useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react';
import { Minus, Plus } from 'lucide-react';
import clsx from 'clsx';

export interface StepperProps {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  label?: string;
  /** Short hint under the label, e.g. the funnel stage above. */
  hint?: string;
  size?: 'sm' | 'md' | 'lg';
  disabled?: boolean;
  /** Highlight state, e.g. when a funnel rule is violated. */
  invalid?: boolean;
  /** Stretch to the container width (good for phone forms). */
  fullWidth?: boolean;
  className?: string;
  name?: string;
}

const SIZE = {
  sm: { h: 'h-9', btn: 'w-9 [&_svg]:h-4 [&_svg]:w-4', text: 'text-base' },
  md: { h: 'h-12', btn: 'w-12 [&_svg]:h-5 [&_svg]:w-5', text: 'text-xl' },
  lg: { h: 'h-14', btn: 'w-14 [&_svg]:h-6 [&_svg]:w-6', text: 'text-2xl' },
} as const;

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

/**
 * Numeric +/- control tuned for fast field entry on a phone: big tap targets, press-and-hold
 * auto-repeat, direct typing, arrow keys, and no native spinners.
 */
export function Stepper({ value, onChange, min = 0, max = Number.MAX_SAFE_INTEGER, step = 1, label, hint, size = 'md', disabled, invalid, fullWidth, className, name }: StepperProps) {
  const id = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const holdInterval = useRef<ReturnType<typeof setInterval> | null>(null);
  const latest = useRef(value);
  latest.current = value;

  const set = (n: number) => onChange(clamp(Math.round(n / step) * step, min, max));
  const bump = (dir: 1 | -1) => set(latest.current + dir * step);

  const stopHold = () => {
    if (holdTimer.current) clearTimeout(holdTimer.current);
    if (holdInterval.current) clearInterval(holdInterval.current);
    holdTimer.current = null;
    holdInterval.current = null;
  };
  const startHold = (dir: 1 | -1) => {
    bump(dir);
    holdTimer.current = setTimeout(() => {
      holdInterval.current = setInterval(() => bump(dir), 90);
    }, 420);
  };
  useEffect(() => stopHold, []);

  const commitDraft = () => {
    if (draft == null) return;
    const n = Number(draft);
    if (draft.trim() !== '' && Number.isFinite(n)) set(n);
    setDraft(null);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowUp') { e.preventDefault(); bump(1); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); bump(-1); }
    else if (e.key === 'Enter') { commitDraft(); (e.target as HTMLInputElement).blur(); }
  };

  const s = SIZE[size];
  const atMin = value <= min;
  const atMax = value >= max;
  const btnBase = clsx(
    'focus-ring-inset inline-flex shrink-0 select-none items-center justify-center text-fg transition-colors duration-100 touch-manipulation',
    'hover:bg-surface-2 active:bg-primary-soft active:text-primary disabled:pointer-events-none disabled:text-subtle',
    s.btn,
  );

  return (
    <div className={clsx('inline-flex flex-col', fullWidth && 'w-full', className)}>
      {label && (
        <label htmlFor={id} className="mb-1.5 flex items-baseline justify-between text-sm font-medium text-fg">
          <span>{label}</span>
          {hint && <span className="text-xs font-normal text-muted">{hint}</span>}
        </label>
      )}
      <div
        className={clsx(
          'inline-flex items-stretch overflow-hidden rounded-xl border bg-surface shadow-card transition-[border-color,box-shadow] duration-150',
          'focus-within:border-primary focus-within:ring-[3px] focus-within:ring-primary/20',
          invalid ? 'border-danger' : 'border-control-border',
          disabled && 'opacity-60',
          fullWidth && 'w-full',
          s.h,
        )}
      >
        <button
          type="button"
          className={clsx(btnBase, 'border-r border-border')}
          aria-label={label ? `Decrease ${label}` : 'Decrease'}
          disabled={disabled || atMin}
          onPointerDown={(e) => { if (e.button === 0) startHold(-1); }}
          onPointerUp={stopHold}
          onPointerLeave={stopHold}
          onPointerCancel={stopHold}
          onContextMenu={(e) => e.preventDefault()}
          tabIndex={-1}
        >
          <Minus strokeWidth={2.5} aria-hidden />
        </button>
        <input
          id={id}
          name={name}
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          role="spinbutton"
          aria-valuenow={value}
          aria-valuemin={min}
          aria-valuemax={max === Number.MAX_SAFE_INTEGER ? undefined : max}
          aria-invalid={invalid || undefined}
          disabled={disabled}
          value={draft ?? String(value)}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setDraft(e.target.value.replace(/[^\d-]/g, ''))}
          onFocus={(e) => e.target.select()}
          onBlur={commitDraft}
          onKeyDown={onKeyDown}
          className={clsx('kpi-number min-w-0 flex-1 bg-transparent text-center text-fg outline-none selection:bg-primary-soft selection:text-primary', s.text, fullWidth ? 'w-full' : 'w-16')}
        />
        <button
          type="button"
          className={clsx(btnBase, 'border-l border-border')}
          aria-label={label ? `Increase ${label}` : 'Increase'}
          disabled={disabled || atMax}
          onPointerDown={(e) => { if (e.button === 0) startHold(1); }}
          onPointerUp={stopHold}
          onPointerLeave={stopHold}
          onPointerCancel={stopHold}
          onContextMenu={(e) => e.preventDefault()}
          tabIndex={-1}
        >
          <Plus strokeWidth={2.5} aria-hidden />
        </button>
      </div>
    </div>
  );
}
