// Topbar — owned by the Product Designer.
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Bell, ChevronDown, ChevronRight, Circle, Inbox, Info, LogOut, Menu as MenuIcon, Moon, Search, Settings, Sun, SunMoon } from 'lucide-react';
import clsx from 'clsx';
import { BRAND, POSITION_LABELS, ROLE_LABELS, type UserWithTeam } from '@lm/shared';
import { Avatar } from '../ui/Avatar';
import { Badge } from '../ui/Badge';
import { Dropdown } from '../ui/Dropdown';
import { ThemeToggle, useTheme } from './theme';
import { NAV_ICONS } from './Sidebar';
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

interface QuickNavProps {
  items: NavItem[];
  className?: string;
  /** Ref to the input so the topbar can focus it on ⌘K. */
  inputRef?: RefObject<HTMLInputElement | null>;
  /** Focus the input on mount (popover mode). */
  autoFocus?: boolean;
  /** Render the result list in flow (inside a popover) instead of floating under the field. */
  embedded?: boolean;
  /** Called after a page was chosen. */
  onNavigate?: () => void;
  /** Called on Escape with an empty query (popover mode closes and refocuses its button). */
  onDismiss?: () => void;
}

/**
 * Quick navigation: a combobox that filters the pages this user can open and navigates on Enter.
 * ⌘K / Ctrl+K (handled by the Topbar) focuses it from anywhere.
 */
function QuickNav({ items, className, inputRef: inputRefProp, autoFocus, embedded, onNavigate, onDismiss }: QuickNavProps) {
  const id = useId();
  const navigate = useNavigate();
  const ownRef = useRef<HTMLInputElement>(null);
  const inputRef = inputRefProp ?? ownRef;
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? items.filter((i) => i.label.toLowerCase().includes(q) || i.to.slice(1).startsWith(q)) : items;
  }, [items, query]);

  useEffect(() => { setActive(0); }, [query]);
  useEffect(() => { if (autoFocus) inputRef.current?.focus(); }, [autoFocus, inputRef]);

  const listId = `${id}-list`;
  const optionId = (i: number) => `${id}-opt-${i}`;

  const go = (item: NavItem | undefined) => {
    if (!item) return;
    setQuery('');
    setOpen(false);
    inputRef.current?.blur();
    navigate(item.to);
    onNavigate?.();
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); setOpen(true); setActive((a) => (matches.length ? (a + 1) % matches.length : 0)); break;
      case 'ArrowUp': e.preventDefault(); setOpen(true); setActive((a) => (matches.length ? (a - 1 + matches.length) % matches.length : 0)); break;
      case 'Enter': e.preventDefault(); go(matches[active]); break;
      case 'Escape':
        e.preventDefault();
        if (query) setQuery('');
        else if (onDismiss) onDismiss();
        else { setOpen(false); inputRef.current?.blur(); }
        break;
      case 'Tab': setOpen(false); break;
    }
  };

  return (
    <div
      className={clsx('relative', className)}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(false); }}
    >
      <label htmlFor={`${id}-input`} className="sr-only">Go to page</label>
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" aria-hidden />
      <input
        ref={inputRef}
        id={`${id}-input`}
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && matches[active] ? optionId(active) : undefined}
        aria-keyshortcuts="Meta+K Control+K"
        autoComplete="off"
        spellCheck={false}
        placeholder="Go to page…"
        value={query}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        className="focus-ring h-9 w-full rounded-lg border border-control-border bg-surface pl-9 pr-14 text-sm text-fg shadow-card transition-colors placeholder:text-subtle hover:border-muted focus:border-primary"
      />
      {!embedded && (
        <kbd className="pointer-events-none absolute right-2 top-1/2 hidden -translate-y-1/2 items-center gap-0.5 rounded-md border border-border bg-surface-2 px-1.5 py-0.5 font-sans text-[10px] font-medium text-muted lg:inline-flex" aria-hidden>
          ⌘K
        </kbd>
      )}
      {open && (
        <ul
          id={listId}
          role="listbox"
          aria-label="Pages"
          className={clsx(
            'scrollbar-thin max-h-80 overflow-y-auto text-sm',
            embedded ? 'mt-1.5' : 'absolute left-0 right-0 top-full z-40 mt-1.5 animate-scale-in rounded-xl border border-border bg-surface p-1 shadow-pop',
          )}
        >
          {matches.length === 0 ? (
            <li role="option" aria-selected={false} aria-disabled className="px-2.5 py-2 text-muted">No pages match “{query.trim()}”</li>
          ) : (
            matches.map((m, i) => {
              const Icon = NAV_ICONS[m.icon] ?? Circle;
              return (
                <li
                  key={m.to}
                  id={optionId(i)}
                  role="option"
                  aria-selected={i === active}
                  onMouseEnter={() => setActive(i)}
                  onMouseDown={(e) => e.preventDefault()} // keep focus in the input so blur does not close the list first
                  onClick={() => go(m)}
                  className={clsx('flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-fg', i === active && 'bg-surface-2')}
                >
                  <Icon className="h-4 w-4 shrink-0 text-muted" aria-hidden />
                  <span className="flex-1 truncate">{m.label}</span>
                  {m.section && <span className="text-[11px] text-muted">{SECTION_LABELS[m.section]}</span>}
                </li>
              );
            })
          )}
        </ul>
      )}
    </div>
  );
}

export function Topbar({ user, items, onLogout, onOpenMenu, menuButtonRef, title, hasNotifications = false, onNotifications }: TopbarProps) {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const { theme, setTheme } = useTheme();
  const current = matchNavItem(items, pathname);
  const fullName = `${user.firstName} ${user.lastName}`;

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

      {/* Breadcrumb / title slot — brand and section never wrap; only the page name truncates */}
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
                <span className="min-w-0 truncate font-semibold text-fg" aria-current="page">{current.label}</span>
              </>
            )}
          </nav>
        )}
      </div>

      <QuickNav items={items} inputRef={inlineSearchRef} className="hidden w-64 shrink-0 lg:block xl:w-72" />

      <div className="flex shrink-0 items-center gap-1">
        <div className="relative lg:hidden">
          <button
            ref={searchButtonRef}
            type="button"
            onClick={() => setSearchOpen((o) => !o)}
            aria-label="Go to page"
            aria-haspopup="dialog"
            aria-expanded={searchOpen}
            aria-keyshortcuts="Meta+K Control+K"
            className="focus-ring inline-flex h-10 w-10 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface-2 hover:text-fg"
          >
            <Search className="h-[18px] w-[18px]" aria-hidden />
          </button>
          {searchOpen && (
            <div
              role="dialog"
              aria-label="Go to page"
              className="absolute right-0 top-full z-40 mt-2 w-[min(20rem,calc(100vw-2rem))] animate-scale-in rounded-xl border border-border bg-surface p-2 shadow-pop"
              onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) closeSearch(false); }}
            >
              <QuickNav items={items} autoFocus embedded onNavigate={() => closeSearch(false)} onDismiss={() => closeSearch(true)} />
            </div>
          )}
        </div>
        <ThemeToggle />

        <Dropdown
          align="end"
          width={272}
          onOpenChange={(o) => { if (o) onNotifications?.(); }}
          header={
            <div>
              <div className="text-sm font-semibold text-fg">Notifications</div>
              <div className="mt-0.5 text-xs text-muted">{hasNotifications ? 'You have new activity.' : 'You’re all caught up.'}</div>
            </div>
          }
          items={[
            { label: hasNotifications ? 'New notifications' : 'No new notifications', icon: <Inbox />, disabled: !hasNotifications },
            { label: 'Settings', icon: <Settings />, onSelect: () => navigate('/settings'), separatorBefore: true },
          ]}
          trigger={
            <button
              type="button"
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
          }
        />

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
