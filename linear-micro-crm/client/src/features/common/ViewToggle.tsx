// Grid / table (or board / list) toggle with icon buttons.
import type { ReactNode } from 'react';
import clsx from 'clsx';

export interface ViewOption<T extends string> { value: T; label: string; icon: ReactNode }

export function ViewToggle<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: ViewOption<T>[] }) {
  return (
    <div role="radiogroup" aria-label="View" className="inline-flex rounded-lg border border-border bg-surface p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          aria-label={o.label}
          title={o.label}
          onClick={() => onChange(o.value)}
          className={clsx('inline-flex h-8 w-8 items-center justify-center rounded-md transition focus:outline-none focus-visible:ring-2 focus-visible:ring-ring', value === o.value ? 'bg-primary text-primary-fg' : 'text-muted hover:bg-surface-2 hover:text-fg')}
        >
          {o.icon}
        </button>
      ))}
    </div>
  );
}
