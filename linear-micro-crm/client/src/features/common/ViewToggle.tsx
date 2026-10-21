// Grid / table (or board / list) toggle with icon buttons.
import type { ReactNode } from 'react';
import clsx from 'clsx';

export interface ViewOption<T extends string> { value: T; label: string; icon: ReactNode }

/**
 * From `sm` up: a 38 px group of 32 x 32 buttons. On phones each button is 40 x 40 to tap and the group is exactly
 * 40 px tall, in line with the toolbar's other 40 px controls: the border is drawn inside the group (no padding),
 * and each button's 3 px inset keeps the look of the larger group.
 */
export function ViewToggle<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: ViewOption<T>[] }) {
  return (
    <div role="radiogroup" aria-label="View" className="inline-flex rounded-lg border border-border bg-surface p-0.5 max-sm:border-0 max-sm:p-0 max-sm:inset-ring max-sm:inset-ring-border">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          aria-label={o.label}
          title={o.label}
          onClick={() => onChange(o.value)}
          className={clsx('group/view inline-flex h-8 w-8 rounded-md transition focus:outline-none focus-visible:ring-2 focus-visible:ring-ring max-sm:h-10 max-sm:w-10 max-sm:p-[3px]', value === o.value ? 'text-primary-fg' : 'text-muted hover:text-fg')}
        >
          <span className={clsx('inline-flex h-full w-full items-center justify-center rounded-md transition', value === o.value ? 'bg-primary' : 'group-hover/view:bg-surface-2')}>
            {o.icon}
          </span>
        </button>
      ))}
    </div>
  );
}
