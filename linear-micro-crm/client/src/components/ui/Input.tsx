import { forwardRef, useId, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from 'react';
import clsx from 'clsx';

export interface FieldProps {
  label?: string;
  hint?: string;
  error?: string;
  required?: boolean;
  /** Shows an "Optional" tag next to the label. */
  optional?: boolean;
  children: ReactNode;
  className?: string;
  htmlFor?: string;
  /** Render as a <div> instead of a <label> (when the child is not a single native control). */
  as?: 'label' | 'div';
  /** Something small on the right of the label row, e.g. a "Forgot?" link. */
  trailing?: ReactNode;
}

export function Field({ label, hint, error, required, optional, children, className, htmlFor, as = 'label', trailing }: FieldProps) {
  const Tag = as;
  return (
    <Tag className={clsx('block text-sm', className)} htmlFor={as === 'label' ? htmlFor : undefined}>
      {label && (
        <span className="mb-1.5 flex items-center justify-between gap-2">
          <span className="font-medium text-fg">
            {label}
            {required && <span className="ml-0.5 text-danger" aria-hidden>*</span>}
            {optional && <span className="ml-1.5 text-xs font-normal text-subtle">Optional</span>}
          </span>
          {trailing && <span className="text-xs text-muted">{trailing}</span>}
        </span>
      )}
      {children}
      {error ? (
        <span className="mt-1.5 block text-xs font-medium text-danger" role="alert">{error}</span>
      ) : hint ? (
        <span className="mt-1.5 block text-xs text-muted">{hint}</span>
      ) : null}
    </Tag>
  );
}

/** Shared control chrome so Input, Select and Textarea look identical. */
export const controlClass = (invalid?: boolean) =>
  clsx(
    'w-full rounded-lg border bg-surface text-sm text-fg shadow-card transition-[border-color,box-shadow] duration-150 placeholder:text-subtle',
    'focus:outline-none focus:border-primary focus:ring-[3px] focus:ring-primary/20',
    'disabled:cursor-not-allowed disabled:bg-surface-2 disabled:text-muted disabled:shadow-none',
    'read-only:bg-surface-2/60',
    invalid ? 'border-danger focus:border-danger focus:ring-danger/20' : 'border-border hover:border-border-strong',
  );

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  invalid?: boolean;
  leftIcon?: ReactNode;
  rightIcon?: ReactNode;
  /** Short text addon on the right, e.g. a unit ("%", "£"). */
  suffix?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
}

const INPUT_SIZE = { sm: 'h-8 px-2.5', md: 'h-10 px-3', lg: 'h-12 px-3.5 text-base' } as const;

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, invalid, leftIcon, rightIcon, suffix, size = 'md', ...rest },
  ref,
) {
  return (
    <span className="relative block">
      {leftIcon && (
        <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted [&_svg]:h-4 [&_svg]:w-4" aria-hidden>
          {leftIcon}
        </span>
      )}
      <input
        ref={ref}
        className={clsx(controlClass(invalid), INPUT_SIZE[size], leftIcon && 'pl-9', (rightIcon || suffix) && 'pr-9', className)}
        aria-invalid={invalid || undefined}
        {...rest}
      />
      {(rightIcon || suffix) && (
        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted [&_svg]:h-4 [&_svg]:w-4" aria-hidden>
          {rightIcon ?? suffix}
        </span>
      )}
    </span>
  );
});

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean;
  /** Show "n / max" counter when maxLength is set. */
  showCount?: boolean;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { className, invalid, showCount, maxLength, value, ...rest },
  ref,
) {
  const id = useId();
  const len = typeof value === 'string' ? value.length : 0;
  return (
    <span className="relative block">
      <textarea
        ref={ref}
        className={clsx(controlClass(invalid), 'min-h-[88px] px-3 py-2 leading-relaxed', className)}
        aria-invalid={invalid || undefined}
        aria-describedby={showCount && maxLength ? id : undefined}
        maxLength={maxLength}
        value={value}
        {...rest}
      />
      {showCount && maxLength && (
        <span id={id} className="pointer-events-none absolute bottom-2 right-3 text-[11px] tabular text-subtle">
          {len} / {maxLength}
        </span>
      )}
    </span>
  );
});
