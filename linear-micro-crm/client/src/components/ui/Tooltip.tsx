import { cloneElement, isValidElement, useEffect, useId, useRef, useState, type FocusEvent, type PointerEvent, type ReactElement, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
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
  /**
   * Draw the bubble in a portal on `document.body` with fixed positioning, so a scrolling or `overflow-hidden`
   * ancestor (the collapsed sidebar's link list, a table) cannot clip it. Shows on mouse hover and keyboard focus,
   * hides on leave, blur, Escape, scroll and resize.
   */
  portal?: boolean;
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

/** Where the portal bubble's anchor point sits (fixed, viewport coordinates) and how it is shifted from it. */
const PORTAL_SHIFT: Record<TooltipSide, string> = {
  top: '-translate-x-1/2 -translate-y-full origin-bottom',
  bottom: '-translate-x-1/2 origin-top',
  left: '-translate-x-full -translate-y-1/2 origin-right',
  right: '-translate-y-1/2 origin-left',
};
const GAP = 8;

function anchorPoint(r: DOMRect, side: TooltipSide): { top: number; left: number } {
  switch (side) {
    case 'top': return { top: r.top - GAP, left: r.left + r.width / 2 };
    case 'bottom': return { top: r.bottom + GAP, left: r.left + r.width / 2 };
    case 'left': return { top: r.top + r.height / 2, left: r.left - GAP };
    default: return { top: r.top + r.height / 2, left: r.right + GAP };
  }
}

const BUBBLE = 'pointer-events-none z-[60] w-max max-w-[240px] rounded-md bg-fg px-2.5 py-1.5 text-xs font-medium leading-snug text-bg shadow-pop transition-[opacity,scale] duration-150 motion-reduce:transition-none';

/**
 * Tooltip shown on hover and on keyboard focus of the child.
 * - Default: CSS only, drawn inside the trigger. An `overflow` ancestor clips it, so steer it with `side`.
 * - `portal`: drawn on `document.body` beside the trigger, so nothing can clip it (use inside scrolling lists).
 */
export function Tooltip({ content, children, side = 'top', disabled, className, delay = 250, portal }: TooltipProps) {
  const id = useId();
  if (disabled || content == null || content === '') return <>{children}</>;

  const child = isValidElement(children)
    ? cloneElement(children as ReactElement<{ 'aria-describedby'?: string }>, { 'aria-describedby': id })
    : children;

  if (portal) {
    return (
      <PortalTooltip id={id} content={content} side={side} delay={delay} className={className}>
        {child}
      </PortalTooltip>
    );
  }

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

function PortalTooltip({ id, content, side, delay, className, children }: { id: string; content: ReactNode; side: TooltipSide; delay: number; className?: string; children: ReactNode }) {
  const anchorRef = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [point, setPoint] = useState<{ top: number; left: number } | null>(null);

  const show = () => {
    const r = anchorRef.current?.getBoundingClientRect();
    if (!r) return;
    setPoint(anchorPoint(r, side));
    setOpen(true);
  };
  const hide = () => setOpen(false);

  // While open: Escape dismisses it (WCAG 1.4.13); any scroll or resize moves the trigger, so hide rather than float.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    const onMove = () => setOpen(false);
    window.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onMove, true);
    window.addEventListener('resize', onMove);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onMove, true);
      window.removeEventListener('resize', onMove);
    };
  }, [open]);

  // Mouse and pen only: on touch, pointerenter/leave fire around every tap and would flash the label.
  const onPointerEnter = (e: PointerEvent) => { if (e.pointerType !== 'touch') show(); };
  // Keyboard focus only: a click or tap also focuses the link, and the label would stay stuck open after it.
  const onFocus = (e: FocusEvent) => {
    const el = e.target as HTMLElement;
    let visible = true;
    try { visible = el.matches(':focus-visible'); } catch { /* older browsers: treat focus as keyboard focus */ }
    if (visible) show();
  };

  const bubble = (
    <span
      role="tooltip"
      id={id}
      style={{ position: 'fixed', top: point?.top ?? 0, left: point?.left ?? 0, transitionDelay: open ? `${delay}ms` : '0ms' }}
      className={clsx(BUBBLE, PORTAL_SHIFT[side], open && point ? 'scale-100 opacity-100' : 'invisible scale-95 opacity-0')}
    >
      {content}
      <span className={clsx('absolute border-[5px]', ARROW[side])} aria-hidden />
    </span>
  );

  return (
    <span ref={anchorRef} className={clsx('relative inline-flex', className)} onPointerEnter={onPointerEnter} onPointerLeave={hide} onFocus={onFocus} onBlur={hide}>
      {children}
      {typeof document !== 'undefined' ? createPortal(bubble, document.body) : null}
    </span>
  );
}
