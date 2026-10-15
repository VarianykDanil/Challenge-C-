import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import clsx from 'clsx';

export interface SegmentedOption<V extends string = string> {
  value: V;
  label: ReactNode;
  icon?: ReactNode;
  disabled?: boolean;
}

export interface SegmentedControlProps<V extends string = string> {
  options: SegmentedOption<V>[];
  value: V;
  onChange: (value: V) => void;
  size?: 'sm' | 'md' | 'lg';
  /** Stretch options to equal widths across the container. */
  fullWidth?: boolean;
  /** Accessible name for the group. */
  'aria-label'?: string;
  className?: string;
}

const SIZE = {
  sm: 'h-8 text-xs [&_button]:px-2.5 [&_svg]:h-3.5 [&_svg]:w-3.5',
  md: 'h-10 text-sm [&_button]:px-3.5 [&_svg]:h-4 [&_svg]:w-4',
  lg: 'h-12 text-base [&_button]:px-4 [&_svg]:h-5 [&_svg]:w-5',
} as const;

/** iOS-style segmented control with a sliding indicator and arrow-key navigation. */
export function SegmentedControl<V extends string = string>({ options, value, onChange, size = 'md', fullWidth, className, 'aria-label': ariaLabel }: SegmentedControlProps<V>) {
  const listRef = useRef<HTMLDivElement>(null);
  const [indicator, setIndicator] = useState<{ left: number; width: number } | null>(null);

  const measure = () => {
    const list = listRef.current;
    if (!list) return;
    const active = list.querySelector<HTMLElement>('[data-active="true"]');
    if (!active) return setIndicator(null);
    setIndicator({ left: active.offsetLeft, width: active.offsetWidth });
  };

  useLayoutEffect(measure, [value, options.length, size, fullWidth]);
  useEffect(() => {
    const list = listRef.current;
    if (!list || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(list);
    return () => ro.disconnect();
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const enabled = options.filter((o) => !o.disabled);
    const idx = enabled.findIndex((o) => o.value === value);
    let next = idx;
    if (e.key === 'ArrowRight') next = (idx + 1) % enabled.length;
    if (e.key === 'ArrowLeft') next = (idx - 1 + enabled.length) % enabled.length;
    if (e.key === 'Home') next = 0;
    if (e.key === 'End') next = enabled.length - 1;
    const target = enabled[next];
    if (target) {
      onChange(target.value);
      listRef.current?.querySelector<HTMLElement>(`[data-value="${target.value}"]`)?.focus();
    }
  };

  return (
    <div
      ref={listRef}
      role="radiogroup"
      aria-label={ariaLabel}
      onKeyDown={onKeyDown}
      className={clsx(
        'relative inline-flex items-stretch gap-0.5 rounded-lg bg-surface-2 p-0.5 ring-1 ring-inset ring-border',
        fullWidth && 'flex w-full',
        SIZE[size],
        className,
      )}
    >
      {indicator && (
        <span
          aria-hidden
          className="absolute top-0.5 bottom-0.5 rounded-md bg-surface shadow-card ring-1 ring-border/60 transition-[left,width] duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none"
          style={{ left: indicator.left, width: indicator.width }}
        />
      )}
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            data-active={active}
            data-value={o.value}
            disabled={o.disabled}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(o.value)}
            className={clsx(
              'focus-ring relative z-10 inline-flex flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium transition-colors duration-150 disabled:opacity-40',
              active ? 'text-fg' : 'text-muted hover:text-fg',
            )}
          >
            {o.icon && <span className="inline-flex shrink-0" aria-hidden>{o.icon}</span>}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
