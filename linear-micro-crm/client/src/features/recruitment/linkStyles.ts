// Release 1.3 — OWNED BY P7 recruitment-plus. A router <Link> that looks like the outline / primary / ghost Button
// (40 px tall), for "Schedule", "Open sheet" and the like: navigation stays a real link (new tab, long press).
import clsx from 'clsx';

const BASE =
  'focus-ring inline-flex h-10 shrink-0 select-none items-center justify-center gap-2 whitespace-nowrap rounded-lg px-4 text-sm font-medium transition-[background-color,color,border-color] duration-150 [&_svg]:h-4 [&_svg]:w-4';

const VARIANTS = {
  outline: 'border border-border bg-surface text-fg shadow-card hover:border-border-strong hover:bg-surface-2',
  primary: 'bg-primary text-primary-fg shadow-card hover:bg-primary-hover',
  soft: 'bg-primary-soft text-primary hover:bg-primary/15',
} as const;

export function buttonLinkClass(variant: keyof typeof VARIANTS = 'outline', className?: string): string {
  return clsx(BASE, VARIANTS[variant], className);
}
