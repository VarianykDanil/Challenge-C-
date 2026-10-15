import { cloneElement, isValidElement, useId, type ReactElement, type ReactNode } from 'react';
import clsx from 'clsx';

export type TooltipSide = 'top' | 'bottom' | 'left' | 'right';

export interface TooltipProps {
  content: ReactNode;
  children: ReactNode;
  side?: TooltipSide;
  /** Disable the tooltip without unmounting children. */
  disabled?: boolean;
  className?: string;
  /** Delay before showing, in ms (CSS transition-delay). */
  delay?: number;
}

const SIDE: Record<TooltipSide, string> = {
  top: 'bottom-full left-1/2 mb-2 -translate-x-1/2 origin-bottom',
  bottom: 'top-full left-1/2 mt-2 -translate-x-1/2 origin-top',
  left: 'right-full top-1/2 mr-2 -translate-y-1/2 origin-right',
  right: 'left-full top-1/2 ml-2 -translate-y-1/2 origin-left',
};

const ARROW: Record<TooltipSide, string> = {
  top: 'top-full left-1/2 -translate-x-1/2 -mt-px border-t-fg border-x-transparent border-b-transparent',
  bottom: 'bottom-full left-1/2 -translate-x-1/2 -mb-px border-b-fg border-x-transparent border-t-transparent',
  left: 'left-full top-1/2 -translate-y-1/2 -ml-px border-l-fg border-y-transparent border-r-transparent',
  right: 'right-full top-1/2 -translate-y-1/2 -mr-px border-r-fg border-y-transparent border-l-transparent',
};

/**
 * CSS-only tooltip: shows on hover and on keyboard focus of the child. No portal, so wrap
 * triggers that sit inside `overflow-hidden` containers with care (use `side` to steer it).
 */
export function Tooltip({ content, children, side = 'top', disabled, className, delay = 250 }: TooltipProps) {
  const id = useId();
  if (disabled || content == null || content === '') return <>{children}</>;

  const child = isValidElement(children)
    ? cloneElement(children as ReactElement<{ 'aria-describedby'?: string }>, { 'aria-describedby': id })
    : children;

  return (
    <span className={clsx('group/tip relative inline-flex', className)}>
      {child}
      <span
        role="tooltip"
        id={id}
        style={{ transitionDelay: `${delay}ms` }}
        className={clsx(
          'pointer-events-none absolute z-50 w-max max-w-[240px] scale-95 rounded-md bg-fg px-2.5 py-1.5 text-xs font-medium leading-snug text-bg opacity-0 shadow-pop transition-[opacity,transform] duration-150',
          'group-hover/tip:scale-100 group-hover/tip:opacity-100 group-focus-within/tip:scale-100 group-focus-within/tip:opacity-100',
          SIDE[side],
        )}
      >
        {content}
        <span className={clsx('absolute border-[5px]', ARROW[side])} aria-hidden />
      </span>
    </span>
  );
}
