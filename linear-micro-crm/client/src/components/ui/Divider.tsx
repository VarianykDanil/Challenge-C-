import type { ReactNode } from 'react';
import clsx from 'clsx';

export interface DividerProps {
  /** Optional centred label, e.g. "or". */
  label?: ReactNode;
  orientation?: 'horizontal' | 'vertical';
  className?: string;
  /** Extra vertical (or horizontal) spacing. */
  spacing?: 'none' | 'sm' | 'md' | 'lg';
}

const SPACE_H = { none: '', sm: 'my-2', md: 'my-4', lg: 'my-6' } as const;
const SPACE_V = { none: '', sm: 'mx-2', md: 'mx-3', lg: 'mx-4' } as const;

export function Divider({ label, orientation = 'horizontal', className, spacing = 'md' }: DividerProps) {
  if (orientation === 'vertical') {
    return <span role="separator" aria-orientation="vertical" className={clsx('inline-block h-5 w-px self-center bg-border', SPACE_V[spacing], className)} />;
  }
  if (!label) {
    return <hr className={clsx('border-0 border-t border-border', SPACE_H[spacing], className)} />;
  }
  return (
    <div role="separator" className={clsx('flex items-center gap-3', SPACE_H[spacing], className)}>
      <span className="h-px flex-1 bg-border" />
      <span className="text-xs font-medium uppercase tracking-wider text-subtle">{label}</span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}
