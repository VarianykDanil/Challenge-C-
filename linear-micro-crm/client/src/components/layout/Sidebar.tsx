// Sidebar — owned by the Product Designer.
import { NavLink } from 'react-router-dom';
import {
  CalendarDays, Circle, FileSpreadsheet, Gauge, GraduationCap, History, Info, LayoutDashboard, MapPinned, Megaphone, PanelLeftClose, PanelLeftOpen, Settings, ShieldCheck, Tally5, Trophy, UserPlus, Users, Wallet, X,
  type LucideIcon,
} from 'lucide-react';
import clsx from 'clsx';
import { BRAND } from '@lm/shared';
import { useAuth } from '@/auth/AuthProvider';
// By file path (not the gauges barrel), and without lib/dates (date-fns): only the small tally store joins the shell.
import { localDayISO, useStoredTallies } from '@/features/gauges/tallyStore';
import { Logo, LogoMark } from '../brand/Logo';
import { Tooltip } from '../ui/Tooltip';
import { ErrorBoundary } from '@/features/common/ErrorBoundary';
// Release 1.3 slot (P6): unread client posts on the Campaigns item.
import { CampaignsNavBadge } from '@/features/client/CampaignsNavBadge';
import type { NavItem } from './nav';

/** lucide icons keyed by the `icon` string in nav.ts. Add here when adding a nav item. */
export const NAV_ICONS: Record<string, LucideIcon> = {
  LayoutDashboard, CalendarDays, Gauge, Tally5, Trophy, UserPlus, Wallet, Megaphone, Users, Settings, Info,
  // Release 1.2
  GraduationCap, History,
  // Release 1.3: Venues (P8), Statements (P3), the client portal's Security (P6)
  MapPinned, FileSpreadsheet, ShieldCheck,
};

/** Today's running stop count across this person's unfinished tallies on this phone, or null when none is under way. */
function useTodayStops(): number | null {
  const { user } = useAuth();
  const today = localDayISO();
  const running = useStoredTallies(user?.id).filter((t) => t.date === today);
  return running.length ? running.reduce((n, t) => n + t.counts.stops, 0) : null;
}

/**
 * A nav item with `variant: 'action'` (Quick gauges): a primary button above the sections, an icon button with a
 * tooltip when the sidebar is collapsed, the same button at the top of the mobile drawer. A pill shows today's stops
 * while a tally is under way.
 */
function ActionLink({ item, compact, onNavigate }: { item: NavItem; compact: boolean; onNavigate?: () => void }) {
  const Icon = NAV_ICONS[item.icon] ?? Circle;
  const stops = useTodayStops();
  const name = stops != null ? `${item.label}: ${stops} stops counted today` : item.label;
  const link = (
    <NavLink
      to={item.to}
      onClick={onNavigate}
      aria-label={name}
      data-nav-action={item.to}
      className={({ isActive }) =>
        clsx(
          'focus-ring relative flex h-11 items-center gap-3 rounded-xl text-sm font-semibold text-primary-fg shadow-card transition-[background-color,box-shadow,transform] duration-150 active:scale-[0.985]',
          compact ? 'w-11 justify-center px-0' : 'w-full px-3.5',
          isActive ? 'bg-primary-hover ring-2 ring-primary/35 ring-offset-2 ring-offset-sidebar' : 'bg-primary hover:bg-primary-hover',
        )
      }
    >
      <Icon className="h-5 w-5 shrink-0" strokeWidth={2.25} aria-hidden />
      {!compact && <span className="min-w-0 flex-1 truncate">{item.label}</span>}
      {stops != null &&
        (compact ? (
          <span className="absolute -right-1.5 -top-1.5 inline-flex h-5 min-w-5 items-center justify-center rounded-full border-2 border-sidebar bg-accent px-1 text-[10px] font-bold tabular-nums leading-none text-accent-fg" aria-hidden>
            {stops > 999 ? '999+' : stops}
          </span>
        ) : (
          <span className="shrink-0 rounded-full bg-primary-fg/20 px-2 py-0.5 text-xs font-semibold tabular-nums" aria-hidden>
            {stops} stops
          </span>
        ))}
    </NavLink>
  );
  return compact ? <Tooltip content={stops != null ? `${item.label} · ${stops} stops today` : item.label} side="right" delay={0} portal>{link}</Tooltip> : link;
}

const SECTION_LABELS: Record<NonNullable<NavItem['section']>, string> = {
  main: 'Workspace',
  manage: 'Manage',
  me: 'Account',
};
const SECTION_ORDER: NonNullable<NavItem['section']>[] = ['main', 'manage', 'me'];

export const SIDEBAR_WIDTH = 264;
export const SIDEBAR_COLLAPSED_WIDTH = 76;

export interface SidebarProps {
  items: NavItem[];
  collapsed: boolean;
  onToggleCollapsed: () => void;
  /** Mobile drawer mode: full width content, with a close button. */
  drawer?: boolean;
  onClose?: () => void;
  className?: string;
}

export function Sidebar({ items, collapsed, onToggleCollapsed, drawer, onClose, className }: SidebarProps) {
  const compact = collapsed && !drawer;
  const actions = items.filter((i) => i.variant === 'action');
  const groups = SECTION_ORDER
    .map((s) => ({ section: s, items: items.filter((i) => i.variant !== 'action' && (i.section ?? 'main') === s) }))
    .filter((g) => g.items.length > 0);

  return (
    <aside
      aria-label="Primary"
      className={clsx('flex h-full flex-col border-r border-border bg-sidebar', className)}
      data-collapsed={compact || undefined}
    >
      {/* Brand */}
      <div className={clsx('flex h-16 shrink-0 items-center border-b border-border/70', compact ? 'justify-center px-0' : 'justify-between px-5')}>
        <NavLink to="/" className="focus-ring rounded-lg text-fg" aria-label={`${BRAND.product} home`}>
          {compact ? <LogoMark size={30} title="" /> : <Logo size={30} title="" />}
        </NavLink>
        {drawer && onClose && (
          <button type="button" onClick={onClose} aria-label="Close menu" data-drawer-close className="focus-ring -mr-2 inline-flex h-9 w-9 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-fg">
            <X className="h-5 w-5" aria-hidden />
          </button>
        )}
      </div>

      {/* Action buttons (Quick gauges): pinned above the scrolling list, so they never scroll away. Collapsed-sidebar
          tooltips use Tooltip's portal mode, so the list's overflow never clips them. */}
      {actions.length > 0 && (
        <ul className={clsx('flex shrink-0 flex-col gap-2 px-3 pt-4', compact && 'items-center')} aria-label="Quick actions">
          {actions.map((item) => (
            <li key={item.to} className={compact ? 'flex justify-center' : undefined}>
              <ActionLink item={item} compact={compact} onNavigate={drawer ? onClose : undefined} />
            </li>
          ))}
        </ul>
      )}

      {/* Navigation */}
      <nav className={clsx('scrollbar-thin flex-1 overflow-y-auto py-4', compact ? 'px-3' : 'px-3', actions.length > 0 && 'pt-5')} aria-label="Main navigation">
        {groups.map((g, gi) => (
          <div key={g.section} className={clsx(gi > 0 && 'mt-5')}>
            {!compact ? (
              <div className="eyebrow mb-2 px-3">{SECTION_LABELS[g.section]}</div>
            ) : (
              gi > 0 && <div className="mx-auto mb-3 h-px w-6 bg-border" aria-hidden />
            )}
            <ul className="flex flex-col gap-0.5">
              {g.items.map((item) => {
                const Icon = NAV_ICONS[item.icon] ?? Circle;
                const link = (
                  <NavLink
                    to={item.to}
                    end={item.end ?? item.to === '/'}
                    onClick={drawer ? onClose : undefined}
                    className={({ isActive }) =>
                      clsx(
                        'focus-ring group relative flex h-10 items-center gap-3 rounded-lg text-sm font-medium transition-colors duration-150',
                        compact ? 'w-10 justify-center px-0' : 'px-3',
                        isActive ? 'bg-primary-soft text-primary' : 'text-muted hover:bg-surface-2 hover:text-fg',
                      )
                    }
                  >
                    {({ isActive }) => (
                      <>
                        {isActive && !compact && <span className="absolute left-0 top-2 bottom-2 w-[3px] rounded-r-full bg-primary" aria-hidden />}
                        <Icon className={clsx('h-[18px] w-[18px] shrink-0 transition-transform duration-150', !isActive && 'group-hover:scale-105')} strokeWidth={isActive ? 2.25 : 2} aria-hidden />
                        {!compact && <span className="truncate">{item.label}</span>}
                        {item.to === '/campaigns' && (
                          <ErrorBoundary name="campaigns-badge" fallback={null}>
                            <CampaignsNavBadge compact={compact} />
                          </ErrorBoundary>
                        )}
                      </>
                    )}
                  </NavLink>
                );
                return (
                  <li key={item.to} className={compact ? 'flex justify-center' : undefined}>
                    {compact ? <Tooltip content={item.label} side="right" delay={0} portal>{link}</Tooltip> : link}
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>

      {/* Footer */}
      <div className={clsx('shrink-0 border-t border-border/70 p-3', compact ? 'flex justify-center' : 'flex items-center justify-between gap-2')}>
        {!compact && (
          <div className="min-w-0 px-2">
            <div className="truncate text-xs font-medium text-fg">{BRAND.name}</div>
            <div className="truncate text-[11px] text-muted">{BRAND.tagline}</div>
          </div>
        )}
        {!drawer && (
          <Tooltip content={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} side="right" delay={0} portal>
            <button
              type="button"
              onClick={onToggleCollapsed}
              aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              aria-expanded={!collapsed}
              className="focus-ring inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface-2 hover:text-fg"
            >
              {collapsed ? <PanelLeftOpen className="h-[18px] w-[18px]" aria-hidden /> : <PanelLeftClose className="h-[18px] w-[18px]" aria-hidden />}
            </button>
          </Tooltip>
        )}
      </div>
    </aside>
  );
}
