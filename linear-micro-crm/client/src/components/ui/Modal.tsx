import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode, type SyntheticEvent } from 'react';
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
  /** Element to focus on open; defaults to the first form control, then the first focusable control. */
  initialFocusRef?: React.RefObject<HTMLElement | null>;
}

// Full-width bottom sheet on phones; capped widths from `sm` up.
const WIDTH = { sm: 'sm:max-w-sm', md: 'sm:max-w-lg', lg: 'sm:max-w-2xl', xl: 'sm:max-w-4xl', full: 'sm:max-w-[calc(100vw-2rem)]' } as const;
const TONE = {
  default: 'bg-primary-soft text-primary',
  danger: 'bg-danger-soft text-danger',
  warning: 'bg-warning-soft text-warning',
  success: 'bg-success-soft text-success',
} as const;

const FOCUSABLE_PARTS = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
];
/** Selector for every keyboard-focusable element. Shared with the mobile nav drawer. */
export const FOCUSABLE = FOCUSABLE_PARTS.join(', ');
// `:not()` must be applied to every entry — appended to the joined list it only qualified the last one.
const FOCUSABLE_NOT_CLOSE = FOCUSABLE_PARTS.map((s) => `${s}:not([data-modal-close])`).join(', ');
const FORM_CONTROL = 'input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled])';

const isVisible = (n: HTMLElement) => n.offsetParent !== null || n === document.activeElement;
const stop = (e: SyntheticEvent) => e.stopPropagation();

let openCount = 0;

/**
 * On a phone, a page that overflows horizontally inflates the layout viewport, so `inset-0` no
 * longer matches what the user can see. While that is the case, pin the overlay to the visual
 * viewport instead; otherwise return nothing and let the CSS `inset-0` apply.
 */
function useVisualViewportBox(open: boolean): CSSProperties | undefined {
  const [box, setBox] = useState<CSSProperties | undefined>(undefined);
  useEffect(() => {
    if (!open) { setBox(undefined); return; }
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => {
      const inflated = document.documentElement.clientWidth - vv.width > 1 && vv.scale <= 1.01;
      setBox(inflated ? { left: vv.offsetLeft, top: vv.offsetTop, width: vv.width, height: vv.height } : undefined);
    };
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    window.addEventListener('scroll', update, true);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [open]);
  return box;
}

export function Modal({ open, onClose, title, description, children, footer, size = 'md', hideClose, persistent, icon, tone = 'default', className, initialFocusRef }: ModalProps) {
  const id = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const box = useVisualViewportBox(open);

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
      const panel = panelRef.current;
      if (!panel) return;
      // A field with `autoFocus` (or anything already focused inside the dialog) wins.
      if (document.activeElement && document.activeElement !== panel && panel.contains(document.activeElement)) return;
      const first = (selector: string) => Array.from(panel.querySelectorAll<HTMLElement>(selector)).find(isVisible);
      const target = initialFocusRef?.current ?? first(FORM_CONTROL) ?? first(FOCUSABLE_NOT_CLOSE) ?? panel;
      target.focus({ preventScroll: true });
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

  // Escape + focus trap. Handled on the overlay itself (keys inside the dialog bubble to it) and,
  // as a fallback, on the document for the moment focus sits outside the panel (e.g. on <body>).
  const handleKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== 'Tab' || !panelRef.current) return;
    const nodes = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(isVisible);
    if (nodes.length === 0) { e.preventDefault(); panelRef.current.focus(); return; }
    const first = nodes[0]!;
    const last = nodes[nodes.length - 1]!;
    const activeEl = document.activeElement as HTMLElement | null;
    if (e.shiftKey && (activeEl === first || !panelRef.current.contains(activeEl))) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && (activeEl === last || !panelRef.current.contains(activeEl))) { e.preventDefault(); first.focus(); }
  };
  const handleKeyRef = useRef(handleKey);
  handleKeyRef.current = handleKey;
  useEffect(() => {
    if (!open) return;
    const onDocKey = (e: KeyboardEvent) => handleKeyRef.current(e);
    document.addEventListener('keydown', onDocKey);
    return () => document.removeEventListener('keydown', onDocKey);
  }, [open]);

  if (!open || typeof document === 'undefined') return null;

  return createPortal(
    // React synthetic events bubble through the component tree even across the portal, so a modal
    // opened from inside a clickable table row would otherwise re-trigger the row. Stop them here.
    <div
      className="fixed inset-0 z-[60] flex items-end justify-center p-0 sm:items-center sm:p-4"
      style={box}
      onClick={stop}
      onKeyDown={(e) => {
        // Stopping the synthetic event also stops the native one at <body>, so handle the keys here.
        e.stopPropagation();
        handleKey(e.nativeEvent);
      }}
      onMouseDown={(e) => {
        e.stopPropagation();
        const t = e.target as HTMLElement;
        if (!persistent && (t === e.currentTarget || t.hasAttribute('data-modal-backdrop'))) onClose();
      }}
    >
      <div className="absolute inset-0 animate-fade-in bg-fg/40 backdrop-blur-sm dark:bg-bg/70" data-modal-backdrop aria-hidden />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? `${id}-title` : undefined}
        aria-describedby={description ? `${id}-desc` : undefined}
        tabIndex={-1}
        className={clsx(
          'relative flex max-h-[100dvh] w-full max-w-[100vw] flex-col overflow-hidden rounded-t-2xl border border-border bg-surface shadow-modal outline-none',
          'pb-[env(safe-area-inset-bottom)] sm:max-h-[calc(100dvh-2rem)] sm:rounded-2xl sm:pb-0',
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
                // 40 px to tap on phones. The larger margins keep its footprint in the title row at 28 x 28, as from `sm`
                // up, so a title that fits there still fits; the icon sits 2 px further right.
                className="focus-ring -mr-2 -mt-2 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface-2 hover:text-fg max-sm:-mb-0.5 max-sm:-mr-3 max-sm:-mt-2.5 max-sm:h-10 max-sm:w-10"
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
