// On a phone, a secondary part of the dashboard (the charts) folds away behind one 44 px button, so the page is a
// couple of screens instead of seven; the choice is kept on this phone. From 640 px up it is always open.
import { useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import clsx from 'clsx';
import { useMediaQuery } from '@/lib/useMediaQuery';

function readOpen(key: string): boolean {
  try {
    return localStorage.getItem(key) === 'open';
  } catch {
    return false;
  }
}

export function PhoneFold({ id, title, hint, children }: { id: string; title: string; hint?: string; children: ReactNode }) {
  const phone = useMediaQuery('(max-width: 639.98px)');
  const key = `lm-fold:${id}`;
  const [open, setOpen] = useState(() => readOpen(key));
  if (!phone) return <>{children}</>;
  const toggle = () => {
    const next = !open;
    setOpen(next);
    try {
      localStorage.setItem(key, next ? 'open' : 'closed');
    } catch {
      /* the fold just will not be remembered */
    }
  };
  return (
    <div>
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        aria-controls={`fold-${id}`}
        className="focus-ring flex min-h-11 w-full items-center justify-between gap-3 rounded-xl border border-border bg-surface px-4 py-2 text-left shadow-card"
      >
        <span>
          <span className="block text-sm font-semibold text-fg">{title}</span>
          {hint && <span className="block text-xs text-muted">{hint}</span>}
        </span>
        <ChevronDown className={clsx('h-5 w-5 shrink-0 text-muted transition-transform', open && 'rotate-180')} aria-hidden />
      </button>
      <div id={`fold-${id}`} hidden={!open} className="mt-4">
        {open && children}
      </div>
    </div>
  );
}
