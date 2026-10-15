import type { HTMLAttributes } from 'react';
import clsx from 'clsx';

export type BadgeTone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger' | 'info' | 'accent';
export type BadgeVariant = 'soft' | 'solid' | 'outline';

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
  /** Show a leading status dot (uses `color` if given, else the tone colour). */
  dot?: boolean;
  /** Custom colour for the dot — for entity colours (team, campaign). */
  color?: string;
  size?: 'sm' | 'md';
  variant?: BadgeVariant;
}

const SOFT: Record<BadgeTone, string> = {
  neutral: 'bg-surface-2 text-muted ring-1 ring-inset ring-border',
  primary: 'bg-primary-soft text-primary',
  success: 'bg-success-soft text-success',
  warning: 'bg-warning-soft text-warning',
  danger: 'bg-danger-soft text-danger',
  info: 'bg-info-soft text-info',
  accent: 'bg-accent-soft text-accent',
};

const SOLID: Record<BadgeTone, string> = {
  neutral: 'bg-fg text-bg',
  primary: 'bg-primary text-primary-fg',
  success: 'bg-success text-status-fg',
  warning: 'bg-warning text-status-fg',
  danger: 'bg-danger text-status-fg',
  info: 'bg-info text-status-fg',
  accent: 'bg-accent text-accent-fg',
};

const OUTLINE: Record<BadgeTone, string> = {
  neutral: 'ring-1 ring-inset ring-border text-muted',
  primary: 'ring-1 ring-inset ring-primary/40 text-primary',
  success: 'ring-1 ring-inset ring-success/40 text-success',
  warning: 'ring-1 ring-inset ring-warning/40 text-warning',
  danger: 'ring-1 ring-inset ring-danger/40 text-danger',
  info: 'ring-1 ring-inset ring-info/40 text-info',
  accent: 'ring-1 ring-inset ring-accent/40 text-accent',
};

/**
 * Pill label. Children may mix a leading icon (`<svg>`) with text — icons are kept inline, sized to
 * the pill and spaced from the label, so an icon + text badge always renders on one line.
 */
export function Badge({ tone = 'neutral', dot, color, size = 'md', variant = 'soft', className, children, ...rest }: BadgeProps) {
  const styles = variant === 'solid' ? SOLID : variant === 'outline' ? OUTLINE : SOFT;
  return (
    <span
      className={clsx(
        'inline-flex max-w-full items-center gap-1.5 whitespace-nowrap rounded-full font-medium leading-none',
        size === 'sm' ? 'h-5 px-2 text-[11px]' : 'h-6 px-2.5 text-xs',
        styles[tone],
        className,
      )}
      {...rest}
    >
      {(dot || color) && (
        <span
          className={clsx('h-1.5 w-1.5 shrink-0 rounded-full', !color && 'bg-current')}
          style={color ? { backgroundColor: color } : undefined}
          aria-hidden
        />
      )}
      <span
        className={clsx(
          'min-w-0 truncate',
          // Preflight makes <svg> display:block, which would push the label onto a second line.
          // Icons go before the label (CSS cannot tell a trailing icon from a leading one next to a text node).
          '[&_svg]:mr-1 [&_svg]:inline-block [&_svg]:shrink-0 [&_svg]:align-[-0.2em]',
          size === 'sm' ? '[&_svg]:h-3 [&_svg]:w-3' : '[&_svg]:h-3.5 [&_svg]:w-3.5',
        )}
      >
        {children}
      </span>
    </span>
  );
}
