// Topbar — owned by the Product Designer.
import type { ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Bell, ChevronDown, ChevronRight, Info, LogOut, Menu as MenuIcon, Moon, Search, Settings, Sun, SunMoon } from 'lucide-react';
import clsx from 'clsx';
import { BRAND, POSITION_LABELS, ROLE_LABELS, type UserWithTeam } from '@lm/shared';
import { Avatar } from '../ui/Avatar';
import { Badge } from '../ui/Badge';
import { Dropdown } from '../ui/Dropdown';
import { Tooltip } from '../ui/Tooltip';
import { ThemeToggle, useTheme } from './theme';
import type { NavItem } from './nav';

export interface TopbarProps {
  user: UserWithTeam;
  items: NavItem[];
  onLogout: () => void;
  onOpenMenu: () => void;
  /** Optional slot replacing the breadcrumb (e.g. a page-specific title). */
  title?: ReactNode;
  /** Show the unread dot on the bell. */
  hasNotifications?: boolean;
  onNotifications?: () => void;
}

const SECTION_LABELS: Record<NonNullable<NavItem['section']>, string> = { main: 'Workspace', manage: 'Manage', me: 'Account' };

/** Longest-prefix match of the current path against the nav items. */
export function matchNavItem(items: NavItem[], pathname: string): NavItem | undefined {
  return items
    .filter((i) => (i.to === '/' ? pathname === '/' : pathname === i.to || pathname.startsWith(`${i.to}/`)))
    .sort((a, b) => b.to.length - a.to.length)[0];
}

export function Topbar({ user, items, onLogout, onOpenMenu, title, hasNotifications = true, onNotifications }: TopbarProps) {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const { theme, setTheme } = useTheme();
  const current = matchNavItem(items, pathname);
  const fullName = `${user.firstName} ${user.lastName}`;

  return (
    <header className="sticky top-0 z-30 flex h-16 shrink-0 items-center gap-3 border-b border-border bg-topbar px-4 backdrop-blur-md sm:px-6 lg:px-8">
      <button
        type="button"
        onClick={onOpenMenu}
        aria-label="Open menu"
        className="focus-ring -ml-2 inline-flex h-10 w-10 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-fg lg:hidden"
      >
        <MenuIcon className="h-5 w-5" aria-hidden />
      </button>

      {/* Breadcrumb / title slot */}
      <div className="min-w-0 flex-1">
        {title ?? (
          <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-sm">
            <Link to="/" className="focus-ring hidden rounded-md text-muted transition-colors hover:text-fg sm:inline">
              {BRAND.product}
            </Link>
            {current?.section && current.section !== 'main' && (
              <>
                <ChevronRight className="hidden h-3.5 w-3.5 text-subtle sm:inline" aria-hidden />
                <span className="hidden text-muted sm:inline">{SECTION_LABELS[current.section]}</span>
              </>
            )}
            {current && (
              <>
                <ChevronRight className="hidden h-3.5 w-3.5 text-subtle sm:inline" aria-hidden />
                <span className="truncate font-semibold text-fg" aria-current="page">{current.label}</span>
              </>
            )}
          </nav>
        )}
      </div>

      {/* Search (visual; wired up in a later release) */}
      <label className="relative hidden w-64 md:block lg:w-72">
        <span className="sr-only">Search</span>
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" aria-hidden />
        <input
          type="search"
          placeholder="Search people, events, candidates…"
          className="focus-ring h-9 w-full rounded-lg border border-border bg-surface pl-9 pr-14 text-sm text-fg shadow-card transition-colors placeholder:text-subtle hover:border-border-strong focus:border-primary"
        />
        <kbd className="pointer-events-none absolute right-2 top-1/2 hidden -translate-y-1/2 items-center gap-0.5 rounded-md border border-border bg-surface-2 px-1.5 py-0.5 font-sans text-[10px] font-medium text-subtle lg:inline-flex" aria-hidden>
          ⌘K
        </kbd>
      </label>

      <div className="flex items-center gap-1">
        <ThemeToggle />
        <Tooltip content="Notifications" side="bottom">
          <button
            type="button"
            onClick={onNotifications}
            aria-label={hasNotifications ? 'Notifications (new)' : 'Notifications'}
            className="focus-ring relative inline-flex h-10 w-10 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface-2 hover:text-fg"
          >
            <Bell className="h-[18px] w-[18px]" aria-hidden />
            {hasNotifications && (
              <span className="absolute right-2.5 top-2.5 flex h-2 w-2" aria-hidden>
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-60 motion-reduce:hidden" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-accent ring-2 ring-topbar" />
              </span>
            )}
          </button>
        </Tooltip>

        <div className="mx-1 hidden h-6 w-px bg-border sm:block" aria-hidden />

        <Dropdown
          align="end"
          width={264}
          header={
            <div className="flex items-center gap-3">
              <Avatar name={fullName} color={user.avatarColor} size="md" />
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold text-fg">{fullName}</div>
                <div className="truncate text-xs text-muted">{user.email}</div>
                <div className="mt-1.5 flex flex-wrap items-center gap-1">
                  <Badge tone="primary" size="sm">{POSITION_LABELS[user.position]}</Badge>
                  {user.teamName && <Badge size="sm" variant="outline">{user.teamName}</Badge>}
                </div>
              </div>
            </div>
          }
          items={[
            { label: 'Settings', icon: <Settings />, onSelect: () => navigate('/settings') },
            { label: 'About Linear Hub', icon: <Info />, onSelect: () => navigate('/about') },
            { label: 'Light', icon: <Sun />, checked: theme === 'light', onSelect: () => setTheme('light'), separatorBefore: true },
            { label: 'Dark', icon: <Moon />, checked: theme === 'dark', onSelect: () => setTheme('dark') },
            { label: 'Match system', icon: <SunMoon />, checked: theme === 'system', onSelect: () => setTheme('system') },
            { label: 'Sign out', icon: <LogOut />, tone: 'danger', onSelect: onLogout, separatorBefore: true },
          ]}
          trigger={
            <button
              type="button"
              className="focus-ring inline-flex h-10 max-w-[220px] items-center gap-2.5 rounded-lg pl-1 pr-2 transition-colors hover:bg-surface-2"
              aria-label={`Account menu for ${fullName}, ${ROLE_LABELS[user.role]}`}
            >
              <Avatar name={fullName} color={user.avatarColor} size="sm" />
              <span className="hidden min-w-0 flex-col items-start text-left leading-tight md:flex">
                <span className="max-w-[140px] truncate text-sm font-medium text-fg">{fullName}</span>
                <span className="max-w-[140px] truncate text-[11px] text-muted">
                  {POSITION_LABELS[user.position]}
                  {user.teamName ? ` · ${user.teamName}` : ''}
                </span>
              </span>
              <ChevronDown className={clsx('hidden h-4 w-4 text-subtle md:block')} aria-hidden />
            </button>
          }
        />
      </div>
    </header>
  );
}
