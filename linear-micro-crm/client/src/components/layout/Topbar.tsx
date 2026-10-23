// Topbar — owned by the Product Designer.
import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { BellOff, ChevronDown, ChevronRight, Circle, Globe, Info, LogOut, Menu as MenuIcon, Moon, Search, Settings, Sun, SunMoon } from 'lucide-react';
import clsx from 'clsx';
import { BRAND, POSITION_LABELS, ROLE_LABELS, personName, type UserWithTeam } from '@lm/shared';
import { Avatar } from '../ui/Avatar';
import { Badge } from '../ui/Badge';
import { Dropdown } from '../ui/Dropdown';
import { ErrorBoundary } from '@/features/common/ErrorBoundary';
import { NotificationsBell } from './NotificationsBell';
import { ThemeToggle, useTheme } from './theme';
import { NAV_ICONS } from './Sidebar';
import { QuickSearch } from '@/features/office/QuickSearch';
import type { NavItem } from './nav';

export interface TopbarProps {
  user: UserWithTeam;
  items: NavItem[];
  onLogout: () => void;
  onOpenMenu: () => void;
  /** Ref to the hamburger so the drawer can hand focus back to it. */
  menuButtonRef?: RefObject<HTMLButtonElement | null>;
  /** Optional slot replacing the breadcrumb (e.g. a page-specific title). */
  title?: ReactNode;
  /** Show the unread dot on the bell. Off by default: nothing produces notifications yet. */
  hasNotifications?: boolean;
  /** Called when the notifications menu opens. */
  onNotifications?: () => void;
}

const SECTION_LABELS: Record<NonNullable<NavItem['section']>, string> = { main: 'Workspace', manage: 'Manage', me: 'Account' };

/** Longest-prefix match of the current path against the nav items. */
export function matchNavItem(items: NavItem[], pathname: string): NavItem | undefined {
  return items
    .filter((i) => (i.to === '/' ? pathname === '/' : pathname === i.to || pathname.startsWith(`${i.to}/`)))
    .sort((a, b) => b.to.length - a.to.length)[0];
}

export function Topbar({ user, items, onLogout, onOpenMenu, menuButtonRef, title, hasNotifications = false, onNotifications }: TopbarProps) {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const { theme, setTheme } = useTheme();
  const current = matchNavItem(items, pathname);
  const fullName = personName(user);
  // Quick gauges (nav item with variant 'action', GAUGE_ROLES only): one tap from the topbar below lg, where the
  // sidebar is a drawer — phones, and iPads held upright. Not shown on the page itself.
  const quick = items.find((i) => i.variant === 'action');
  const QuickIcon = quick ? NAV_ICONS[quick.icon] ?? Circle : null;

  // Below `lg` the quick nav collapses to an icon button that opens a small popover.
  const inlineSearchRef = useRef<HTMLInputElement>(null);
  const searchButtonRef = useRef<HTMLButtonElement>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  useEffect(() => { setSearchOpen(false); }, [pathname]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        if (window.matchMedia('(min-width: 1024px)').matches) {
          inlineSearchRef.current?.focus();
          inlineSearchRef.current?.select();
        } else {
          setSearchOpen(true);
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  const closeSearch = (refocus: boolean) => { setSearchOpen(false); if (refocus) searchButtonRef.current?.focus(); };

  return (
    <header className="sticky top-0 z-30 flex h-16 shrink-0 items-center gap-3 border-b border-border bg-topbar px-4 backdrop-blur-md sm:px-6 lg:px-8">
      <button
        ref={menuButtonRef}
        type="button"
        onClick={onOpenMenu}
        aria-label="Open menu"
        className="focus-ring -ml-2 inline-flex h-10 w-10 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-fg lg:hidden"
      >
        <MenuIcon className="h-5 w-5" aria-hidden />
      </button>

      {/* Breadcrumb / title slot — brand and section never wrap; only the page name truncates. On a phone the page name is
          for screen readers only: the page's own heading right below names it, and beside search, theme, Quick gauges,
          the bell and the avatar it had 72 px ("Recruitm…", 1.3.1 UI review). */}
      <div className="min-w-0 flex-1">
        {title ?? (
          <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-sm">
            <Link to="/" className="focus-ring hidden shrink-0 whitespace-nowrap rounded-md text-muted transition-colors hover:text-fg sm:inline">
              {BRAND.product}
            </Link>
            {current?.section && current.section !== 'main' && (
              <>
                <ChevronRight className="hidden h-3.5 w-3.5 shrink-0 text-subtle sm:inline" aria-hidden />
                <span className="hidden shrink-0 whitespace-nowrap text-muted sm:inline">{SECTION_LABELS[current.section]}</span>
              </>
            )}
            {current && (
              <>
                <ChevronRight className="hidden h-3.5 w-3.5 shrink-0 text-subtle sm:inline" aria-hidden />
                <span className="min-w-[4.5rem] truncate font-semibold text-fg max-sm:sr-only max-sm:min-w-0" aria-current="page">{current.label}</span>
              </>
            )}
          </nav>
        )}
      </div>

      {/* The field may shrink (to 10rem) before the page name does; it never pushes the breadcrumb out. */}
      <QuickSearch user={user} items={items} inputRef={inlineSearchRef} className="hidden w-64 min-w-[10rem] shrink lg:block xl:w-72" />

      <div className="flex shrink-0 items-center gap-1">
        <div className="relative lg:hidden">
          <button
            ref={searchButtonRef}
            type="button"
            onClick={() => setSearchOpen((o) => !o)}
            aria-label="Search or go to a page"
            aria-haspopup="dialog"
            aria-expanded={searchOpen}
            aria-keyshortcuts="Meta+K Control+K"
            className="focus-ring inline-flex h-10 w-10 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface-2 hover:text-fg"
          >
            <Search className="h-[18px] w-[18px]" aria-hidden />
          </button>
          {/* Below lg the panel spans the screen under the top bar (it used to hang off the magnifier and run off the
              left edge of a phone). The header's backdrop blur makes it the containing block, which is full width. */}
          {searchOpen && (
            <div
              role="dialog"
              aria-label="Search or go to a page"
              className="fixed inset-x-4 top-[4.5rem] z-40 mx-auto max-w-md animate-scale-in rounded-xl border border-border bg-surface p-2 shadow-pop"
              onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) closeSearch(false); }}
            >
              <QuickSearch user={user} items={items} autoFocus embedded onNavigate={() => closeSearch(false)} onDismiss={() => closeSearch(true)} />
            </div>
          )}
        </div>
        <ThemeToggle />

        {quick && QuickIcon && pathname !== quick.to && (
          <Link
            to={quick.to}
            aria-label={quick.label}
            title={quick.label}
            data-topbar-quick
            className="focus-ring inline-flex h-10 w-10 items-center justify-center rounded-lg bg-primary-soft text-primary transition-colors hover:bg-primary/15 active:bg-primary/20 lg:hidden"
          >
            <QuickIcon className="h-[18px] w-[18px]" strokeWidth={2.25} aria-hidden />
          </Link>
        )}

        {/* The bell (p5) sits above the page boundary: if it throws, only the bell is swapped for a 40 px retry button. */}
        <ErrorBoundary
          name="bell"
          resetKeys={[pathname]}
          fallback={({ reset }) => (
            <button
              type="button"
              onClick={reset}
              data-error-boundary="bell"
              aria-label="Notifications could not load. Try again"
              title="Notifications could not load. Tap to try again."
              className="focus-ring inline-flex h-10 w-10 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface-2 hover:text-fg"
            >
              <BellOff className="h-[18px] w-[18px]" aria-hidden />
            </button>
          )}
        >
          <NotificationsBell hasNotifications={hasNotifications} onNotifications={onNotifications} />
        </ErrorBoundary>

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
            { label: 'Public page', icon: <Globe />, onSelect: () => navigate('/welcome') },
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
              {/* Name shown on tablets (no sidebar) and from xl; at lg the sidebar leaves too little room. */}
              <span className="hidden min-w-0 flex-col items-start text-left leading-tight md:flex lg:hidden xl:flex">
                <span className="max-w-[140px] truncate text-sm font-medium text-fg">{fullName}</span>
                <span className="max-w-[140px] truncate text-[11px] text-muted">
                  {POSITION_LABELS[user.position]}
                  {user.teamName ? ` · ${user.teamName}` : ''}
                </span>
              </span>
              <ChevronDown className={clsx('hidden h-4 w-4 text-subtle md:block lg:hidden xl:block')} aria-hidden />
            </button>
          }
        />
      </div>
    </header>
  );
}
