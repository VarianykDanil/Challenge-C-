// Owned by the Product Designer. Contract: docs/TEAM_CONTRACT.md → "Layout contract".
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import type { UserWithTeam } from '@lm/shared';
import clsx from 'clsx';
import { GAUGE_ROLES } from '@/auth/RequireRole';
import { ConfirmDialog } from '@/features/common/ConfirmDialog';
import { ErrorBoundary } from '@/features/common/ErrorBoundary';
// Smart release 1.1 (p7): imported by file path, not through the barrels, to keep the shell's first download small.
import { OfflineBanner } from '@/features/common/OfflineBanner';
import { OutboxBanner } from '@/features/gauges/OutboxBanner';
import { getOutbox } from '@/features/gauges/outbox';
import { FOCUSABLE } from '../ui/Modal';
import { NAV_ITEMS } from './nav';
import { Sidebar, SIDEBAR_COLLAPSED_WIDTH, SIDEBAR_WIDTH } from './Sidebar';
import { Topbar } from './Topbar';

export interface AppShellProps {
  user: UserWithTeam;
  onLogout: () => void;
  children: ReactNode;
  /** Optional replacement for the breadcrumb in the topbar. */
  title?: ReactNode;
  /** Remove the content max-width (for wide tables/boards). */
  fluid?: boolean;
}

const COLLAPSE_KEY = 'lm-sidebar';

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === 'collapsed';
  } catch {
    return false;
  }
}

const visible = (n: HTMLElement) => n.offsetParent !== null || n === document.activeElement;

export function AppShell({ user, onLogout, children, title, fluid }: AppShellProps) {
  const items = NAV_ITEMS.filter((i) => i.roles.includes(user.role));
  const [collapsed, setCollapsed] = useState<boolean>(readCollapsed);
  const [mobileOpen, setMobileOpen] = useState(false);
  const { pathname } = useLocation();
  const drawerRef = useRef<HTMLDivElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  const toggleCollapsed = useCallback(() => {
    setCollapsed((c) => {
      const next = !c;
      try { localStorage.setItem(COLLAPSE_KEY, next ? 'collapsed' : 'expanded'); } catch { /* ignore */ }
      return next;
    });
  }, []);

  // Close the drawer on navigation.
  useEffect(() => { setMobileOpen(false); }, [pathname]);

  // While open: lock scroll, move focus into the drawer, trap Tab inside it, close on Escape;
  // on close, hand focus back to the hamburger. While closed the drawer is `inert`, so none of
  // its links are tab stops or exposed to assistive tech.
  useEffect(() => {
    if (!mobileOpen) return;
    const drawer = drawerRef.current;
    restoreRef.current = (document.activeElement as HTMLElement | null) ?? menuButtonRef.current;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const focusables = () => Array.from(drawer?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []).filter(visible);
    const raf = requestAnimationFrame(() => {
      const first = drawer?.querySelector<HTMLElement>('[data-drawer-close]') ?? focusables()[0] ?? drawer;
      first?.focus({ preventScroll: true });
    });

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); setMobileOpen(false); return; }
      if (e.key !== 'Tab' || !drawer) return;
      const nodes = focusables();
      if (nodes.length === 0) { e.preventDefault(); drawer.focus(); return; }
      const first = nodes[0]!;
      const last = nodes[nodes.length - 1]!;
      const activeEl = document.activeElement as HTMLElement | null;
      if (e.shiftKey && (activeEl === first || !drawer.contains(activeEl))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (activeEl === last || !drawer.contains(activeEl))) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);

    return () => {
      cancelAnimationFrame(raf);
      document.body.style.overflow = prev;
      document.removeEventListener('keydown', onKey);
      const target = restoreRef.current?.isConnected ? restoreRef.current : menuButtonRef.current;
      target?.focus({ preventScroll: true });
    };
  }, [mobileOpen]);

  const sidebarWidth = collapsed ? SIDEBAR_COLLAPSED_WIDTH : SIDEBAR_WIDTH;

  // Quick gauges is the field screen, and pages are lazy chunks with no service worker: fetch its code (and Log
  // gauges') once the app is idle after sign-in, so it still opens after the signal drops. The shell stays the same
  // size; the browser keeps the module, and the page's own lazy import then resolves from it.
  const canGauge = GAUGE_ROLES.includes(user.role);
  useEffect(() => {
    if (!canGauge || !navigator.onLine) return;
    const load = () => {
      import('@/pages/QuickGauges').catch(() => { /* fetched again when the page opens */ });
    };
    // Safari has no requestIdleCallback: a short timer instead.
    if (typeof window.requestIdleCallback === 'function') {
      const id = window.requestIdleCallback(load, { timeout: 5000 });
      return () => window.cancelIdleCallback(id);
    }
    const id = setTimeout(load, 2000);
    return () => clearTimeout(id);
  }, [canGauge]);

  // p7: signing out with gauges still on this phone asks first. Nothing is deleted: they stay under this person's
  // key and send after their next sign-in on this phone.
  const [unsentOnSignOut, setUnsentOnSignOut] = useState(0);
  const guardedLogout = useCallback(() => {
    const unsent = getOutbox(user.id).length;
    if (unsent > 0) setUnsentOnSignOut(unsent);
    else onLogout();
  }, [user.id, onLogout]);

  return (
    <div className="min-h-full bg-bg text-fg">
      <a
        href="#main"
        className="focus-ring sr-only z-[100] rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-fg focus:not-sr-only focus:fixed focus:left-4 focus:top-4"
      >
        Skip to content
      </a>

      {/* Desktop sidebar */}
      <div
        className="fixed inset-y-0 left-0 z-40 hidden transition-[width] duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none lg:block"
        style={{ width: sidebarWidth }}
      >
        <Sidebar items={items} collapsed={collapsed} onToggleCollapsed={toggleCollapsed} />
      </div>

      {/* Mobile drawer — inert + aria-hidden while closed so it leaves the tab order and the a11y tree */}
      <div
        className={clsx('fixed inset-0 z-50 lg:hidden', mobileOpen ? 'pointer-events-auto' : 'pointer-events-none')}
        inert={!mobileOpen}
        aria-hidden={!mobileOpen}
      >
        <div
          className={clsx('absolute inset-0 bg-ink/50 backdrop-blur-sm transition-opacity duration-200', mobileOpen ? 'opacity-100' : 'opacity-0')}
          onClick={() => setMobileOpen(false)}
        />
        <div
          ref={drawerRef}
          role="dialog"
          aria-modal="true"
          aria-label="Navigation"
          tabIndex={-1}
          className={clsx(
            'absolute inset-y-0 left-0 w-[min(84vw,300px)] shadow-modal outline-none transition-transform duration-250 ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none',
            mobileOpen ? 'translate-x-0' : '-translate-x-full',
          )}
        >
          <Sidebar items={items} collapsed={false} onToggleCollapsed={toggleCollapsed} drawer onClose={() => setMobileOpen(false)} />
        </div>
      </div>

      {/* Content column */}
      <div
        className="flex min-h-full flex-col transition-[padding] duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none lg:[padding-left:var(--sidebar-w)]"
        style={{ ['--sidebar-w' as string]: `${sidebarWidth}px` }}
      >
        <Topbar user={user} items={items} onLogout={guardedLogout} onOpenMenu={() => setMobileOpen(true)} menuButtonRef={menuButtonRef} title={title} />
        {/* p7: "Can't reach Linear Hub" and "N entries waiting to send" stay in view under the topbar. A banner that
            throws hides itself (fallback null) rather than blanking the app. The wrapper is opaque (bg-bg) because the
            banners' soft tints are translucent in dark mode, and scrolled content must not show through them. */}
        <div className="sticky top-16 z-20 bg-bg">
          <ErrorBoundary name="offline-banner" fallback={null}>
            <OfflineBanner gaugeNote={GAUGE_ROLES.includes(user.role)} />
          </ErrorBoundary>
          <ErrorBoundary name="outbox-banner" fallback={null}>
            <OutboxBanner user={user} />
          </ErrorBoundary>
        </div>
        <main
          id="main"
          tabIndex={-1}
          className={clsx('mx-auto w-full flex-1 px-4 py-6 outline-none sm:px-6 lg:px-8 lg:py-8', !fluid && 'max-w-[1440px]')}
        >
          <div key={pathname} className="animate-fade-in">
            <ErrorBoundary name="page" title="This page hit a problem" resetKeys={[pathname]}>{children}</ErrorBoundary>
          </div>
        </main>
      </div>

      <ConfirmDialog
        open={unsentOnSignOut > 0}
        onClose={() => setUnsentOnSignOut(0)}
        onConfirm={() => {
          setUnsentOnSignOut(0);
          onLogout();
        }}
        title="Sign out?"
        description={
          unsentOnSignOut === 1
            ? `1 entry hasn't been sent — it stays on this phone and sends next time you sign in as ${user.firstName}.`
            : `${unsentOnSignOut} entries haven't been sent — they stay on this phone and send next time you sign in as ${user.firstName}.`
        }
        confirmLabel="Sign out"
      />
    </div>
  );
}
