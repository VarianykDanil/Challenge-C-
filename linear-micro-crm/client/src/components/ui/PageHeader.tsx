import type { ReactNode } from 'react';
import clsx from 'clsx';

export interface PageHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  breadcrumbs?: ReactNode;
  /** Small label above the title, e.g. the current period. */
  eyebrow?: ReactNode;
  /** Icon shown in a chip to the left of the title. */
  icon?: ReactNode;
  /** Row rendered under the header, e.g. Tabs or filters. */
  tabs?: ReactNode;
  className?: string;
}

export function PageHeader({ title, description, actions, breadcrumbs, eyebrow, icon, tabs, className }: PageHeaderProps) {
  return (
    <header className={clsx('mb-6 animate-fade-in', className)}>
      {/* 1.3.1 UI review: the title column keeps its full width (up to the row) and the actions wrap under it when both do
          not fit — at 768–1280 px a long event name or the greeting no longer shrinks to a few letters beside the
          buttons. A title longer than the row wraps to two lines before it is cut. */}
      <div className="flex flex-col gap-4 sm:flex-row sm:flex-wrap sm:items-end sm:justify-between">
        <div className="min-w-0 sm:max-w-full sm:shrink-0">
          {breadcrumbs && <nav aria-label="Breadcrumb" className="mb-2 flex items-center gap-1.5 text-xs text-muted [&_a:hover]:text-fg">{breadcrumbs}</nav>}
          {eyebrow && <div className="eyebrow mb-1.5">{eyebrow}</div>}
          <div className="flex items-center gap-3">
            {icon && (
              <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary-soft text-primary shadow-card [&_svg]:h-5 [&_svg]:w-5" aria-hidden>
                {icon}
              </span>
            )}
            <h1 className="line-clamp-2 min-w-0 break-words text-2xl font-bold leading-tight tracking-tight text-fg sm:text-[28px]">{title}</h1>
          </div>
          {description && <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-muted">{description}</p>}
        </div>
        {actions && <div className="flex max-w-full shrink-0 flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {tabs && <div className="mt-5">{tabs}</div>}
    </header>
  );
}
