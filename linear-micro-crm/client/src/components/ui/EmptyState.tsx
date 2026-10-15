import type { ReactNode } from 'react';
import { Inbox } from 'lucide-react';
import clsx from 'clsx';

export interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
  /** Compact variant for inside cards and table bodies. */
  size?: 'sm' | 'md';
  /** Tone of the icon chip. */
  tone?: 'neutral' | 'primary' | 'accent';
}

export function EmptyState({ icon, title, description, action, className, size = 'md', tone = 'neutral' }: EmptyStateProps) {
  return (
    <div
      className={clsx(
        'relative flex flex-col items-center justify-center overflow-hidden rounded-xl border border-dashed border-border-strong/70 text-center',
        size === 'sm' ? 'p-6' : 'p-10 sm:p-14',
        className,
      )}
    >
      <div className="brand-lines pointer-events-none absolute inset-0 opacity-40 [mask-image:radial-gradient(60%_60%_at_50%_30%,black,transparent)]" aria-hidden />
      <div
        className={clsx(
          'relative mb-4 inline-flex items-center justify-center rounded-2xl shadow-card',
          size === 'sm' ? 'h-10 w-10 [&_svg]:h-5 [&_svg]:w-5' : 'h-14 w-14 [&_svg]:h-6 [&_svg]:w-6',
          tone === 'primary' && 'bg-primary-soft text-primary',
          tone === 'accent' && 'bg-accent-soft text-accent',
          tone === 'neutral' && 'bg-surface text-muted ring-1 ring-border',
        )}
        aria-hidden
      >
        {icon ?? <Inbox />}
      </div>
      <h3 className={clsx('relative font-sans font-semibold tracking-normal text-fg', size === 'sm' ? 'text-sm' : 'text-base')}>{title}</h3>
      {description && <p className={clsx('relative mt-1 max-w-sm text-muted', size === 'sm' ? 'text-xs' : 'text-sm')}>{description}</p>}
      {action && <div className="relative mt-5 flex items-center gap-2">{action}</div>}
    </div>
  );
}
