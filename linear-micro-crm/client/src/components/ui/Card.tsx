import type { HTMLAttributes, ReactNode } from 'react';
import clsx from 'clsx';

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  padded?: boolean;
  /** Lift on hover (use for clickable cards). */
  hoverable?: boolean;
  /** Flat variant without shadow, for nesting inside other cards. */
  flat?: boolean;
  /** Tinted background for callouts. */
  tone?: 'default' | 'primary' | 'accent' | 'success' | 'warning' | 'danger' | 'info';
}

const TONE: Record<NonNullable<CardProps['tone']>, string> = {
  default: 'border-border bg-surface',
  primary: 'border-primary/20 bg-primary-soft',
  accent: 'border-accent/20 bg-accent-soft',
  success: 'border-success/20 bg-success-soft',
  warning: 'border-warning/20 bg-warning-soft',
  danger: 'border-danger/20 bg-danger-soft',
  info: 'border-info/20 bg-info-soft',
};

export function Card({ className, padded = true, hoverable, flat, tone = 'default', ...rest }: CardProps) {
  return (
    <div
      className={clsx(
        'rounded-xl border',
        TONE[tone],
        !flat && tone === 'default' && 'shadow-card',
        hoverable && 'card-hover cursor-pointer',
        padded && 'p-5',
        className,
      )}
      {...rest}
    />
  );
}

export interface CardHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  /** Small icon rendered in a chip before the title. */
  icon?: ReactNode;
  className?: string;
}

export function CardHeader({ title, description, actions, icon, className }: CardHeaderProps) {
  return (
    // The actions wrap under the title rather than squeeze it below 10rem (1.3.1 UI review: "Client accounts" read "C…"
    // and its description one word a line in a 213 px card at 1024 px).
    <div className={clsx('mb-4 flex flex-wrap items-start justify-between gap-x-4 gap-y-2', className)}>
      <div className="flex min-w-[min(100%,10rem)] flex-1 items-start gap-3">
        {icon && (
          <span className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary [&_svg]:h-4 [&_svg]:w-4" aria-hidden>
            {icon}
          </span>
        )}
        <div className="min-w-0">
          <h3 className="truncate font-sans text-sm font-semibold tracking-normal text-fg">{title}</h3>
          {description && <p className="mt-0.5 text-xs leading-relaxed text-muted">{description}</p>}
        </div>
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

export interface CardFooterProps { children: ReactNode; className?: string }
/** Bottom strip separated by a hairline; pass `padded={false}` on the Card and pad the body yourself, or let it bleed with negative margins. */
export function CardFooter({ children, className }: CardFooterProps) {
  return <div className={clsx('-mx-5 -mb-5 mt-5 flex items-center justify-between gap-3 rounded-b-xl border-t border-border bg-surface-2/60 px-5 py-3 text-sm', className)}>{children}</div>;
}
