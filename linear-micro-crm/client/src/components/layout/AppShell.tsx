// Owned by the Product Designer. Contract: docs/TEAM_CONTRACT.md → "Layout contract".
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import type { UserWithTeam } from '@lm/shared';
import clsx from 'clsx';
import { ErrorBoundary } from '@/features/common/ErrorBoundary';
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
        <Topbar user={user} items={items} onLogout={onLogout} onOpenMenu={() => setMobileOpen(true)} menuButtonRef={menuButtonRef} title={title} />
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
    </div>
  );
}
