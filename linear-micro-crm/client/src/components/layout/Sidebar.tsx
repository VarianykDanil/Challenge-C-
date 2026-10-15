// Sidebar — owned by the Product Designer.
import { NavLink } from 'react-router-dom';
import {
  CalendarDays, Circle, Gauge, Info, LayoutDashboard, Megaphone, PanelLeftClose, PanelLeftOpen, Settings, Trophy, UserPlus, Users, Wallet, X,
  type LucideIcon,
} from 'lucide-react';
import clsx from 'clsx';
import { BRAND } from '@lm/shared';
import { Logo, LogoMark } from '../brand/Logo';
import { Tooltip } from '../ui/Tooltip';
import type { NavItem } from './nav';

/** lucide icons keyed by the `icon` string in nav.ts. Add here when adding a nav item. */
export const NAV_ICONS: Record<string, LucideIcon> = {
  LayoutDashboard, CalendarDays, Gauge, Trophy, UserPlus, Wallet, Megaphone, Users, Settings, Info,
};

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
  const groups = SECTION_ORDER
    .map((s) => ({ section: s, items: items.filter((i) => (i.section ?? 'main') === s) }))
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

      {/* Navigation */}
      <nav className={clsx('scrollbar-thin flex-1 overflow-y-auto py-4', compact ? 'px-3' : 'px-3')} aria-label="Main navigation">
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
                    end={item.to === '/'}
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
                      </>
                    )}
                  </NavLink>
                );
                return (
                  <li key={item.to} className={compact ? 'flex justify-center' : undefined}>
                    {compact ? <Tooltip content={item.label} side="right" delay={0}>{link}</Tooltip> : link}
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
          <Tooltip content={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} side="right" delay={0}>
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
