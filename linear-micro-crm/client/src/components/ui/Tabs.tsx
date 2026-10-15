import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import clsx from 'clsx';

export interface TabItem { value: string; label: ReactNode; count?: number; icon?: ReactNode; disabled?: boolean }
export interface TabsProps {
  items: TabItem[];
  value: string;
  onChange: (value: string) => void;
  className?: string;
  variant?: 'underline' | 'pills';
  size?: 'sm' | 'md';
  /** Stretch tabs to fill the row. */
  fullWidth?: boolean;
  'aria-label'?: string;
}

/** Underline or pill tabs with an animated indicator and roving-tabindex keyboard navigation. */
export function Tabs({ items, value, onChange, className, variant = 'underline', size = 'md', fullWidth, 'aria-label': ariaLabel }: TabsProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const [ind, setInd] = useState<{ left: number; width: number } | null>(null);

  const measure = () => {
    const list = listRef.current;
    const el = list?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!list || !el) return setInd(null);
    setInd({ left: el.offsetLeft, width: el.offsetWidth });
  };
  useLayoutEffect(measure, [value, items.length, variant, size, fullWidth]);
  useEffect(() => {
    if (!listRef.current || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(listRef.current);
    return () => ro.disconnect();
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const enabled = items.filter((t) => !t.disabled);
    const idx = enabled.findIndex((t) => t.value === value);
    let next = idx;
    if (e.key === 'ArrowRight') next = (idx + 1) % enabled.length;
    if (e.key === 'ArrowLeft') next = (idx - 1 + enabled.length) % enabled.length;
    if (e.key === 'Home') next = 0;
    if (e.key === 'End') next = enabled.length - 1;
    const t = enabled[next];
    if (t) {
      onChange(t.value);
      listRef.current?.querySelector<HTMLElement>(`[data-value="${t.value}"]`)?.focus();
    }
  };

  const pills = variant === 'pills';
  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label={ariaLabel}
      onKeyDown={onKeyDown}
      className={clsx(
        'relative flex',
        pills ? 'gap-1 rounded-lg bg-surface-2 p-1 ring-1 ring-inset ring-border' : 'gap-1 border-b border-border',
        pills ? 'inline-flex' : 'flex',
        fullWidth && '!flex w-full',
        className,
      )}
    >
      {ind && (
        <span
          aria-hidden
          className={clsx(
            'pointer-events-none absolute transition-[left,width] duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none',
            pills ? 'top-1 bottom-1 rounded-md bg-surface shadow-card ring-1 ring-border/60' : '-bottom-px h-0.5 rounded-full bg-primary',
          )}
          style={{ left: ind.left, width: ind.width }}
        />
      )}
      {items.map((t) => {
        const selected = t.value === value;
        return (
          <button
            key={t.value}
            type="button"
            role="tab"
            data-value={t.value}
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            disabled={t.disabled}
            onClick={() => onChange(t.value)}
            className={clsx(
              'focus-ring relative z-10 inline-flex items-center justify-center gap-2 whitespace-nowrap font-medium transition-colors duration-150 disabled:opacity-40',
              fullWidth && 'flex-1',
              size === 'sm' ? 'text-xs [&_svg]:h-3.5 [&_svg]:w-3.5' : 'text-sm [&_svg]:h-4 [&_svg]:w-4',
              pills
                ? clsx('rounded-md', size === 'sm' ? 'h-7 px-2.5' : 'h-8 px-3.5', selected ? 'text-fg' : 'text-muted hover:text-fg')
                : clsx('rounded-t-md', size === 'sm' ? 'px-2.5 py-2' : 'px-3 py-2.5', selected ? 'text-fg' : 'text-muted hover:text-fg'),
            )}
          >
            {t.icon && <span className="inline-flex shrink-0" aria-hidden>{t.icon}</span>}
            {t.label}
            {t.count != null && (
              <span className={clsx('inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[11px] font-semibold tabular', selected ? 'bg-primary-soft text-primary' : 'bg-surface-3 text-muted')}>
                {t.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
