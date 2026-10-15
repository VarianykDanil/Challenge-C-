import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import clsx from 'clsx';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'outline' | 'soft' | 'accent' | 'link';
export type ButtonSize = 'xs' | 'sm' | 'md' | 'lg' | 'icon' | 'icon-sm' | 'icon-xs';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  leftIcon?: ReactNode;
  rightIcon?: ReactNode;
  /** Stretch to the container width. */
  fullWidth?: boolean;
  /** Accessible name for icon-only buttons (also used as the native tooltip). */
  label?: string;
}

const SIZE: Record<ButtonSize, string> = {
  xs: 'h-7 px-2.5 text-xs gap-1.5 rounded-md [&_svg]:h-3.5 [&_svg]:w-3.5',
  sm: 'h-8 px-3 text-sm gap-1.5 rounded-lg [&_svg]:h-4 [&_svg]:w-4',
  md: 'h-10 px-4 text-sm gap-2 rounded-lg [&_svg]:h-4 [&_svg]:w-4',
  lg: 'h-12 px-5 text-base gap-2 rounded-xl [&_svg]:h-5 [&_svg]:w-5',
  icon: 'h-10 w-10 rounded-lg [&_svg]:h-[18px] [&_svg]:w-[18px]',
  'icon-sm': 'h-8 w-8 rounded-lg [&_svg]:h-4 [&_svg]:w-4',
  'icon-xs': 'h-7 w-7 rounded-md [&_svg]:h-3.5 [&_svg]:w-3.5',
};

const VARIANT: Record<ButtonVariant, string> = {
  primary: 'bg-primary text-primary-fg shadow-card hover:bg-primary-hover active:bg-primary-hover',
  accent: 'bg-accent text-accent-fg shadow-card hover:brightness-110 active:brightness-95',
  secondary: 'bg-surface-2 text-fg hover:bg-surface-3 active:bg-surface-3',
  outline: 'border border-border bg-surface text-fg shadow-card hover:bg-surface-2 hover:border-border-strong active:bg-surface-3',
  ghost: 'text-muted hover:bg-surface-2 hover:text-fg active:bg-surface-3',
  soft: 'bg-primary-soft text-primary hover:bg-primary/15 active:bg-primary/20',
  danger: 'bg-danger text-status-fg shadow-card hover:brightness-110 active:brightness-95',
  link: 'h-auto px-0 text-primary underline-offset-4 hover:underline',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', loading, leftIcon, rightIcon, fullWidth, label, className, children, disabled, type = 'button', ...rest },
  ref,
) {
  const iconOnly = size.startsWith('icon');
  return (
    <button
      ref={ref}
      type={type}
      className={clsx(
        'focus-ring relative inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap font-medium transition-[background-color,color,box-shadow,transform,filter,border-color] duration-150 active:scale-[0.985] disabled:pointer-events-none disabled:opacity-50',
        SIZE[size],
        VARIANT[variant],
        fullWidth && 'w-full',
        className,
      )}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      aria-label={label}
      title={iconOnly ? label : undefined}
      {...rest}
    >
      {loading ? (
        <Loader2 className="animate-spin" aria-hidden />
      ) : (
        leftIcon && <span className="inline-flex shrink-0 items-center" aria-hidden>{leftIcon}</span>
      )}
      {children}
      {rightIcon && !loading && <span className="inline-flex shrink-0 items-center" aria-hidden>{rightIcon}</span>}
    </button>
  );
});

export interface ButtonGroupProps { children: ReactNode; className?: string }
/** Visually joins adjacent buttons (use with `outline` or `secondary`). */
export function ButtonGroup({ children, className }: ButtonGroupProps) {
  return (
    <div role="group" className={clsx('inline-flex -space-x-px [&>button]:rounded-none [&>button:first-child]:rounded-l-lg [&>button:last-child]:rounded-r-lg [&>button]:focus-visible:relative [&>button]:focus-visible:z-10', className)}>
      {children}
    </div>
  );
}
