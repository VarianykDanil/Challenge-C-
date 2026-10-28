import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { CheckCircle2, Info, TriangleAlert, X, XCircle } from 'lucide-react';
import clsx from 'clsx';
import { useMediaQuery } from '@/lib/useMediaQuery';

export type ToastTone = 'success' | 'error' | 'info' | 'warning';
export interface ToastMessage {
  id: number;
  title: string;
  description?: string;
  tone: ToastTone;
  /** Auto-dismiss delay in ms; 0 keeps it until dismissed. */
  duration?: number;
  /** Optional inline action, e.g. Undo. */
  action?: { label: string; onClick: () => void };
  /**
   * A heads-up the person did not just cause (a "Needs attention" item). It goes away as soon as a form opens or a
   * field gets the focus, so it never sits over what they are filling in; it stays in the bell.
   */
  notice?: boolean;
}

/** Window event a dialog fires when it opens (components/ui/Modal.tsx): notices make way for it. */
export const DIALOG_OPEN_EVENT = 'lm:dialog-open';

const FORM_FIELD = 'input:not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"]), textarea, select, [contenteditable="true"]';

interface ToastContextValue {
  toast: (t: Omit<ToastMessage, 'id'>) => number;
  success: (title: string, description?: string) => number;
  error: (title: string, description?: string) => number;
  info: (title: string, description?: string) => number;
  warning: (title: string, description?: string) => number;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const ICON: Record<ToastTone, { icon: typeof Info; cls: string }> = {
  success: { icon: CheckCircle2, cls: 'text-success' },
  error: { icon: XCircle, cls: 'text-danger' },
  warning: { icon: TriangleAlert, cls: 'text-warning' },
  info: { icon: Info, cls: 'text-info' },
};

const ACCENT: Record<ToastTone, string> = {
  success: 'before:bg-success',
  error: 'before:bg-danger',
  warning: 'before:bg-warning',
  info: 'before:bg-info',
};

/** On a phone a notice sits over the top of the page, so it goes sooner (it stays in the bell). */
const PHONE_NOTICE_MS = 5000;

function ToastItem({ t, onDismiss }: { t: ToastMessage; onDismiss: (id: number) => void }) {
  const [leaving, setLeaving] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const phone = useMediaQuery('(max-width: 639.98px)');
  const asked = t.duration ?? (t.tone === 'error' ? 6000 : 4000);
  const duration = t.notice && phone && asked ? Math.min(asked, PHONE_NOTICE_MS) : asked;

  const close = useCallback(() => {
    setLeaving(true);
    setTimeout(() => onDismiss(t.id), 160);
  }, [onDismiss, t.id]);

  const disarm = () => { if (timer.current) clearTimeout(timer.current); timer.current = null; };
  const arm = useCallback(() => {
    if (!duration) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(close, duration);
  }, [close, duration]);

  useEffect(() => { arm(); return disarm; }, [arm]);

  const { icon: Icon, cls } = ICON[t.tone];
  return (
    <div
      role={t.tone === 'error' ? 'alert' : 'status'}
      // Pause the auto-dismiss while hovered or while any control inside has keyboard focus.
      onMouseEnter={disarm}
      onMouseLeave={arm}
      onFocus={disarm}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) arm(); }}
      // On phones the action and the dismiss button are at least 40 px to tap. The dismiss button fills the 40 px right
      // padding from the top corner, so the text keeps its width and stays clear of it.
      className={clsx(
        'pointer-events-auto relative flex w-[min(92vw,360px)] items-start gap-3 overflow-hidden rounded-xl border border-border bg-surface p-3.5 pr-10 shadow-pop',
        'before:absolute before:inset-y-0 before:left-0 before:w-1 before:content-[""]',
        ACCENT[t.tone],
        leaving ? 'translate-x-4 opacity-0 transition-[opacity,transform] duration-150' : 'animate-slide-in-right',
      )}
    >
      <Icon className={clsx('mt-0.5 h-5 w-5 shrink-0', cls)} aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold leading-snug text-fg">{t.title}</div>
        {/* a notice keeps to two lines of text on a phone; the bell has the rest */}
        {t.description && <div className={clsx('mt-0.5 text-xs leading-relaxed text-muted', t.notice && 'max-sm:line-clamp-2')}>{t.description}</div>}
        {t.action && (
          <button
            type="button"
            onClick={() => { t.action?.onClick(); close(); }}
            className="focus-ring mt-2 rounded-md text-xs font-semibold text-primary underline-offset-4 hover:underline max-sm:-mx-2 max-sm:-mb-2 max-sm:mt-0.5 max-sm:inline-flex max-sm:min-h-10 max-sm:items-center max-sm:px-2"
          >
            {t.action.label}
          </button>
        )}
      </div>
      <button
        type="button"
        onClick={close}
        aria-label="Dismiss notification"
        // On phones it sits in the corner, so its focus ring is drawn inside (the toast clips anything outside it).
        className="focus-ring absolute right-2 top-2 inline-flex h-7 w-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-2 hover:text-fg max-sm:focus-ring-inset max-sm:right-0 max-sm:top-0 max-sm:h-10 max-sm:w-10 max-sm:rounded-tr-[11px]"
      >
        <X className="h-4 w-4" aria-hidden />
      </button>
    </div>
  );
}

export function ToastProvider({ children, position = 'bottom-right' }: { children: ReactNode; position?: 'bottom-right' | 'top-right' | 'bottom-center' }) {
  const [items, setItems] = useState<ToastMessage[]>([]);
  const seq = useRef(0);

  const dismiss = useCallback((id: number) => setItems((prev) => prev.filter((i) => i.id !== id)), []);

  // Notices make way for forms: a dialog opening, or the focus moving into a field outside the toasts.
  useEffect(() => {
    const clearNotices = () => setItems((prev) => (prev.some((i) => i.notice) ? prev.filter((i) => !i.notice) : prev));
    const onFocus = (e: FocusEvent) => {
      const el = e.target as HTMLElement | null;
      if (el?.matches?.(FORM_FIELD) && !el.closest('[data-toast-region]')) clearNotices();
    };
    window.addEventListener(DIALOG_OPEN_EVENT, clearNotices);
    document.addEventListener('focusin', onFocus);
    return () => {
      window.removeEventListener(DIALOG_OPEN_EVENT, clearNotices);
      document.removeEventListener('focusin', onFocus);
    };
  }, []);
  const toast = useCallback((t: Omit<ToastMessage, 'id'>) => {
    const id = ++seq.current;
    setItems((prev) => [...prev.slice(-4), { ...t, id }]);
    return id;
  }, []);

  const value = useMemo<ToastContextValue>(() => ({
    toast,
    dismiss,
    success: (title, description) => toast({ title, description, tone: 'success' }),
    error: (title, description) => toast({ title, description, tone: 'error' }),
    info: (title, description) => toast({ title, description, tone: 'info' }),
    warning: (title, description) => toast({ title, description, tone: 'warning' }),
  }), [toast, dismiss]);

  // On a phone they sit at the top, under the top bar: forms open as sheets from the bottom, and a toast there covered
  // the fields being filled in (and the Save button).
  const pos = {
    'bottom-right': 'bottom-4 right-4 items-end max-sm:bottom-auto max-sm:right-0 max-sm:left-0 max-sm:top-[calc(4.25rem+env(safe-area-inset-top))] max-sm:items-center',
    'top-right': 'top-4 right-4 items-end',
    'bottom-center': 'bottom-4 left-1/2 -translate-x-1/2 items-center',
  }[position];

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className={clsx('pointer-events-none fixed z-[80] flex flex-col gap-2', pos)} role="region" aria-label="Notifications" aria-live="polite" aria-relevant="additions" data-toast-region>
        {items.map((t) => <ToastItem key={t.id} t={t} onDismiss={dismiss} />)}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
}
