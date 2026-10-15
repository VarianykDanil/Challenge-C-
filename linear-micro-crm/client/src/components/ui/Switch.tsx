import { useId, type ReactNode } from 'react';
import clsx from 'clsx';

export interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: ReactNode;
  /** Secondary line under the label. */
  description?: ReactNode;
  disabled?: boolean;
  size?: 'sm' | 'md';
  /** Put the label before the control (default) or after it. */
  labelPosition?: 'start' | 'end';
  className?: string;
  name?: string;
}

export function Switch({ checked, onChange, label, description, disabled, size = 'md', labelPosition = 'start', className, name }: SwitchProps) {
  const id = useId();
  const track = size === 'sm' ? 'h-5 w-9' : 'h-6 w-11';
  const thumb = size === 'sm' ? 'h-4 w-4' : 'h-5 w-5';
  const shift = size === 'sm' ? 'translate-x-4' : 'translate-x-5';

  const control = (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={label ? `${id}-label` : undefined}
      aria-describedby={description ? `${id}-desc` : undefined}
      disabled={disabled}
      name={name}
      onClick={() => onChange(!checked)}
      className={clsx(
        'focus-ring relative inline-flex shrink-0 items-center rounded-full border-2 border-transparent transition-colors duration-200 disabled:opacity-50',
        track,
        checked ? 'bg-primary' : 'bg-surface-3 hover:bg-border-strong',
      )}
    >
      <span
        aria-hidden
        className={clsx(
          'pointer-events-none inline-block rounded-full bg-ink-fg shadow-[0_1px_2px_rgb(0_0_0/0.25)] ring-0 transition-transform duration-200 ease-out',
          thumb,
          checked ? shift : 'translate-x-0',
        )}
      />
    </button>
  );

  if (!label) return <span className={className}>{control}</span>;

  return (
    <div className={clsx('flex items-center gap-3', labelPosition === 'start' ? 'justify-between' : 'flex-row-reverse justify-end', className)}>
      <label htmlFor={id} id={`${id}-label`} className={clsx('cursor-pointer select-none text-sm font-medium text-fg', disabled && 'cursor-not-allowed opacity-60')}>
        <span className="block">{label}</span>
        {description && <span id={`${id}-desc`} className="mt-0.5 block text-xs font-normal text-muted">{description}</span>}
      </label>
      {control}
    </div>
  );
}
