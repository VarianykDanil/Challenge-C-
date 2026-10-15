import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { CheckCircle2, Info, TriangleAlert, X, XCircle } from 'lucide-react';
import clsx from 'clsx';

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
}

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

function ToastItem({ t, onDismiss }: { t: ToastMessage; onDismiss: (id: number) => void }) {
  const [leaving, setLeaving] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const duration = t.duration ?? (t.tone === 'error' ? 6000 : 4000);

  const close = useCallback(() => {
    setLeaving(true);
    setTimeout(() => onDismiss(t.id), 160);
  }, [onDismiss, t.id]);

  const arm = useCallback(() => {
    if (!duration) return;
    timer.current = setTimeout(close, duration);
  }, [close, duration]);
  const disarm = () => { if (timer.current) clearTimeout(timer.current); };

  useEffect(() => { arm(); return disarm; }, [arm]);

  const { icon: Icon, cls } = ICON[t.tone];
  return (
    <div
      role={t.tone === 'error' ? 'alert' : 'status'}
      onMouseEnter={disarm}
      onMouseLeave={arm}
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
        {t.description && <div className="mt-0.5 text-xs leading-relaxed text-muted">{t.description}</div>}
        {t.action && (
          <button
            type="button"
            onClick={() => { t.action?.onClick(); close(); }}
            className="focus-ring mt-2 rounded-md text-xs font-semibold text-primary underline-offset-4 hover:underline"
          >
            {t.action.label}
          </button>
        )}
      </div>
      <button
        type="button"
        onClick={close}
        aria-label="Dismiss notification"
        className="focus-ring absolute right-2 top-2 inline-flex h-7 w-7 items-center justify-center rounded-md text-subtle transition-colors hover:bg-surface-2 hover:text-fg"
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

  const pos = {
    'bottom-right': 'bottom-4 right-4 items-end',
    'top-right': 'top-4 right-4 items-end',
    'bottom-center': 'bottom-4 left-1/2 -translate-x-1/2 items-center',
  }[position];

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className={clsx('pointer-events-none fixed z-[80] flex flex-col gap-2', pos)} aria-live="polite" aria-relevant="additions">
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
