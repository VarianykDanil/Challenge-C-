import { forwardRef, type SelectHTMLAttributes } from 'react';
import { ChevronDown } from 'lucide-react';
import clsx from 'clsx';
import { controlClass } from './Input';

export interface SelectOption { value: string; label: string; disabled?: boolean }
export interface SelectGroup { label: string; options: SelectOption[] }

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size'> {
  options: SelectOption[];
  /** Optional grouped options rendered after `options`. */
  groups?: SelectGroup[];
  placeholder?: string;
  invalid?: boolean;
  size?: 'sm' | 'md' | 'lg';
}

// sm is 40 px tall on phones like every filter row (1.3.1 UI review: the Events, Team and Leaderboard filters and the
// Recruitment "Move to…" were 32 px)
const SELECT_SIZE = { sm: 'h-8 pl-2.5 pr-8 max-sm:h-10', md: 'h-10 pl-3 pr-9', lg: 'h-12 pl-3.5 pr-10 text-base' } as const;

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { options, groups, placeholder, invalid, className, size = 'md', ...rest },
  ref,
) {
  return (
    <span className="relative block">
      <select
        ref={ref}
        className={clsx(controlClass(invalid), SELECT_SIZE[size], 'cursor-pointer appearance-none truncate', className)}
        aria-invalid={invalid || undefined}
        {...rest}
      >
        {placeholder && <option value="">{placeholder}</option>}
        {options.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>{o.label}</option>
        ))}
        {groups?.map((g) => (
          <optgroup key={g.label} label={g.label}>
            {g.options.map((o) => (
              <option key={o.value} value={o.value} disabled={o.disabled}>{o.label}</option>
            ))}
          </optgroup>
        ))}
      </select>
      <ChevronDown
        className={clsx('pointer-events-none absolute top-1/2 -translate-y-1/2 text-muted', size === 'sm' ? 'right-2 h-3.5 w-3.5' : 'right-3 h-4 w-4')}
        aria-hidden
      />
    </span>
  );
});
