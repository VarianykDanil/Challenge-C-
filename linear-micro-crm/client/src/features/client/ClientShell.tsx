// Release 1.3 — the client portal's shell — OWNED BY P6 client-portal (laid down by r3-foundation).
// A campaign's client signed in to the portal sees only this: the brand, their campaign, "Updates" and "Security"
// (CLIENT_NAV_ITEMS), and Sign out. Nothing of the staff app loads (no sidebar, search, bell or outbox banners, which
// would all call routes a client session may not use). App.tsx mounts it, lazily, for the /client routes, inside
// U1's PinSetupGate. The campaign comes from GET /client/portal (api/clientPortal.ts).
import type { ReactNode } from 'react';
import { Link, NavLink } from 'react-router-dom';
import { LogOut } from 'lucide-react';
import clsx from 'clsx';
import type { UserWithTeam } from '@lm/shared';
import { useClientPortal } from '@/api/clientPortal';
import { Logo } from '@/components/brand/Logo';
import { NAV_ICONS } from '@/components/layout/Sidebar';
import { CLIENT_NAV_ITEMS } from '@/components/layout/nav';
import { Button } from '@/components/ui';
import { ErrorBoundary } from '@/features/common/ErrorBoundary';
import { fullName } from '@/lib/format';

export interface ClientShellProps {
  user: UserWithTeam;
  onLogout: () => void;
  children: ReactNode;
}

export function ClientShell({ user, onLogout, children }: ClientShellProps) {
  const portal = useClientPortal();
  const campaign = portal.data?.campaign;
  return (
    <div className="min-h-full bg-bg text-fg">
      <a
        href="#main"
        className="focus-ring sr-only z-[100] rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-fg focus:not-sr-only focus:fixed focus:left-4 focus:top-4"
      >
        Skip to content
      </a>
      <header className="sticky top-0 z-30 border-b border-border bg-topbar backdrop-blur-md">
        <div className="mx-auto flex h-16 w-full max-w-3xl items-center justify-between gap-3 px-4 sm:px-6">
          <Link to="/client" className="focus-ring flex min-h-10 min-w-0 items-center gap-3 rounded-lg text-fg" aria-label="Client portal home">
            <Logo size={28} title="" />
          </Link>
          <div className="flex min-w-0 items-center gap-2">
            <span className="hidden min-w-0 truncate text-right text-sm leading-tight text-muted sm:block">
              <span className="block truncate font-medium text-fg">{fullName(user)}</span>
              {campaign && <span className="block truncate text-xs">{campaign.name}</span>}
            </span>
            <Button variant="ghost" onClick={onLogout} leftIcon={<LogOut className="h-4 w-4" />} className="h-10">
              Sign out
            </Button>
          </div>
        </div>
        <nav aria-label="Client portal" className="mx-auto flex w-full max-w-3xl gap-1 px-2 sm:px-4">
          {CLIENT_NAV_ITEMS.map((item) => {
            const Icon = NAV_ICONS[item.icon];
            return (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  clsx(
                    'focus-ring inline-flex h-11 items-center gap-2 rounded-t-lg border-b-2 px-3 text-sm font-medium transition-colors',
                    isActive ? 'border-primary text-primary' : 'border-transparent text-muted hover:text-fg',
                  )
                }
              >
                {Icon && <Icon className="h-4 w-4" aria-hidden />}
                {item.label}
              </NavLink>
            );
          })}
        </nav>
      </header>
      <main id="main" tabIndex={-1} className="mx-auto w-full max-w-3xl px-4 py-6 outline-none sm:px-6 sm:py-8">
        <ErrorBoundary name="client-page" title="This page hit a problem">{children}</ErrorBoundary>
      </main>
    </div>
  );
}
