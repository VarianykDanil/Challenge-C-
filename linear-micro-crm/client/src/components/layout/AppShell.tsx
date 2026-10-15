// Owned by the Product Designer. Contract: docs/TEAM_CONTRACT.md → "Layout contract".
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import type { UserWithTeam } from '@lm/shared';
import clsx from 'clsx';
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

export function AppShell({ user, onLogout, children, title, fluid }: AppShellProps) {
  const items = NAV_ITEMS.filter((i) => i.roles.includes(user.role));
  const [collapsed, setCollapsed] = useState<boolean>(readCollapsed);
  const [mobileOpen, setMobileOpen] = useState(false);
  const { pathname } = useLocation();

  const toggleCollapsed = useCallback(() => {
    setCollapsed((c) => {
      const next = !c;
      try { localStorage.setItem(COLLAPSE_KEY, next ? 'collapsed' : 'expanded'); } catch { /* ignore */ }
      return next;
    });
  }, []);

  // Close the drawer on navigation and on Escape; lock scroll while open.
  useEffect(() => { setMobileOpen(false); }, [pathname]);
  useEffect(() => {
    if (!mobileOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMobileOpen(false); };
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', onKey);
    return () => { document.body.style.overflow = prev; document.removeEventListener('keydown', onKey); };
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

      {/* Mobile drawer */}
      <div className={clsx('fixed inset-0 z-50 lg:hidden', mobileOpen ? 'pointer-events-auto' : 'pointer-events-none')} aria-hidden={!mobileOpen}>
        <div
          className={clsx('absolute inset-0 bg-ink/50 backdrop-blur-sm transition-opacity duration-200', mobileOpen ? 'opacity-100' : 'opacity-0')}
          onClick={() => setMobileOpen(false)}
        />
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Navigation"
          className={clsx(
            'absolute inset-y-0 left-0 w-[min(84vw,300px)] shadow-modal transition-transform duration-250 ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none',
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
        <Topbar user={user} items={items} onLogout={onLogout} onOpenMenu={() => setMobileOpen(true)} title={title} />
        <main
          id="main"
          tabIndex={-1}
          className={clsx('mx-auto w-full flex-1 px-4 py-6 outline-none sm:px-6 lg:px-8 lg:py-8', !fluid && 'max-w-[1440px]')}
        >
          <div key={pathname} className="animate-fade-in">{children}</div>
        </main>
      </div>
    </div>
  );
}
