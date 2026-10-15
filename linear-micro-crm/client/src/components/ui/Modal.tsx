import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import clsx from 'clsx';

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl' | 'full';
  /** Hide the top-right close button. */
  hideClose?: boolean;
  /** Prevent closing on backdrop click (destructive confirmations). */
  persistent?: boolean;
  /** Icon chip shown before the title. */
  icon?: ReactNode;
  tone?: 'default' | 'danger' | 'warning' | 'success';
  className?: string;
  /** Element to focus on open; defaults to the first focusable control. */
  initialFocusRef?: React.RefObject<HTMLElement | null>;
}

const WIDTH = { sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-2xl', xl: 'max-w-4xl', full: 'max-w-[calc(100vw-2rem)]' } as const;
const TONE = {
  default: 'bg-primary-soft text-primary',
  danger: 'bg-danger-soft text-danger',
  warning: 'bg-warning-soft text-warning',
  success: 'bg-success-soft text-success',
} as const;

const FOCUSABLE = 'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

let openCount = 0;

export function Modal({ open, onClose, title, description, children, footer, size = 'md', hideClose, persistent, icon, tone = 'default', className, initialFocusRef }: ModalProps) {
  const id = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  // Scroll lock + focus management
  useEffect(() => {
    if (!open) return;
    restoreRef.current = document.activeElement as HTMLElement | null;
    openCount += 1;
    const prevOverflow = document.body.style.overflow;
    const prevPad = document.body.style.paddingRight;
    const scrollbar = window.innerWidth - document.documentElement.clientWidth;
    document.body.style.overflow = 'hidden';
    if (scrollbar > 0) document.body.style.paddingRight = `${scrollbar}px`;

    const raf = requestAnimationFrame(() => {
      const target = initialFocusRef?.current ?? panelRef.current?.querySelector<HTMLElement>(`${FOCUSABLE}:not([data-modal-close])`) ?? panelRef.current;
      target?.focus({ preventScroll: true });
    });

    return () => {
      cancelAnimationFrame(raf);
      openCount = Math.max(0, openCount - 1);
      if (openCount === 0) {
        document.body.style.overflow = prevOverflow;
        document.body.style.paddingRight = prevPad;
      }
      restoreRef.current?.focus?.({ preventScroll: true });
    };
  }, [open, initialFocusRef]);

  // Escape + focus trap
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== 'Tab' || !panelRef.current) return;
      const nodes = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((n) => n.offsetParent !== null || n === document.activeElement);
      if (nodes.length === 0) { e.preventDefault(); panelRef.current.focus(); return; }
      const first = nodes[0]!;
      const last = nodes[nodes.length - 1]!;
      const activeEl = document.activeElement as HTMLElement | null;
      if (e.shiftKey && (activeEl === first || !panelRef.current.contains(activeEl))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && activeEl === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open || typeof document === 'undefined') return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-end justify-center p-0 sm:items-center sm:p-4"
      onMouseDown={(e) => { if (!persistent && e.target === e.currentTarget) onClose(); }}
    >
      <div className="absolute inset-0 animate-fade-in bg-fg/40 backdrop-blur-sm dark:bg-bg/70" aria-hidden />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? `${id}-title` : undefined}
        aria-describedby={description ? `${id}-desc` : undefined}
        tabIndex={-1}
        className={clsx(
          'relative flex max-h-[calc(100dvh-1rem)] w-full flex-col overflow-hidden rounded-t-2xl border border-border bg-surface shadow-modal outline-none sm:max-h-[calc(100dvh-2rem)] sm:rounded-2xl',
          'animate-slide-up sm:animate-scale-in',
          WIDTH[size],
          className,
        )}
      >
        {(title || !hideClose) && (
          <div className="flex items-start gap-3 px-6 pt-6 pb-2">
            {icon && (
              <span className={clsx('mt-0.5 inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl [&_svg]:h-5 [&_svg]:w-5', TONE[tone])} aria-hidden>
                {icon}
              </span>
            )}
            <div className="min-w-0 flex-1">
              {title && <h2 id={`${id}-title`} className="text-lg font-semibold leading-snug text-fg">{title}</h2>}
              {description && <p id={`${id}-desc`} className="mt-1 text-sm leading-relaxed text-muted">{description}</p>}
            </div>
            {!hideClose && (
              <button
                type="button"
                onClick={onClose}
                data-modal-close
                aria-label="Close"
                className="focus-ring -mr-2 -mt-2 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface-2 hover:text-fg"
              >
                <X className="h-[18px] w-[18px]" aria-hidden />
              </button>
            )}
          </div>
        )}
        <div className={clsx('scrollbar-thin min-h-0 flex-1 overflow-y-auto px-6', title ? 'py-4' : 'pt-6 pb-4')}>{children}</div>
        {footer && (
          <div className="flex flex-col-reverse gap-2 border-t border-border bg-surface-2/50 px-6 py-4 sm:flex-row sm:justify-end [&>button]:w-full sm:[&>button]:w-auto">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
