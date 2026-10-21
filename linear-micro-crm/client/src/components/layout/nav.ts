import type { Role } from '@lm/shared';

export interface NavItem {
  to: string;
  label: string;
  icon: string;
  roles: Role[];
  section?: 'main' | 'manage' | 'me';
  /** 'action': the sidebar renders it as a prominent button above the sections (still listed in ⌘K quick nav). */
  variant?: 'action';
  /** Release 1.3: active on this exact path only (Finance stays unlit on /finance/statements). */
  end?: boolean;
}

/** Icon names map to lucide-react icons in AppShell. */
export const NAV_ITEMS: NavItem[] = [
  { to: '/', label: 'Dashboard', icon: 'LayoutDashboard', roles: ['admin', 'leader', 'recruiter', 'rep'], section: 'main' },
  { to: '/events', label: 'Events', icon: 'CalendarDays', roles: ['admin', 'leader', 'recruiter', 'rep'], section: 'main' },
  // Release 1.3: every venue's numbers and the law of averages (P8), right under Events.
  { to: '/venues', label: 'Venues', icon: 'MapPinned', roles: ['admin', 'leader', 'recruiter', 'rep'], section: 'main' },
  { to: '/gauges', label: 'Gauges', icon: 'Gauge', roles: ['admin', 'leader', 'rep'], section: 'main' },
  // The field screen: six big buttons for the shift tally (pages/QuickGauges.tsx). Same roles as Gauges (GAUGE_ROLES).
  { to: '/quick', label: 'Quick gauges', icon: 'Tally5', roles: ['admin', 'leader', 'rep'], section: 'main', variant: 'action' },
  { to: '/leaderboard', label: 'Leaderboard', icon: 'Trophy', roles: ['admin', 'leader', 'recruiter', 'rep'], section: 'main' },
  // Release 1.2: the COD pack lessons and campaign pitches (L1, L2).
  { to: '/learning', label: 'Learning', icon: 'GraduationCap', roles: ['admin', 'leader', 'recruiter', 'rep'], section: 'main' },
  { to: '/recruitment', label: 'Recruitment', icon: 'UserPlus', roles: ['admin', 'leader', 'recruiter'], section: 'manage' },
  { to: '/finance', label: 'Finance', icon: 'Wallet', roles: ['admin', 'leader', 'recruiter', 'rep'], section: 'manage', end: true },
  // Release 1.3: the clients' commission statements (P3), under Finance, for the office.
  { to: '/finance/statements', label: 'Statements', icon: 'FileSpreadsheet', roles: ['admin'], section: 'manage' },
  { to: '/campaigns', label: 'Campaigns', icon: 'Megaphone', roles: ['admin', 'leader'], section: 'manage' },
  { to: '/team', label: 'Team', icon: 'Users', roles: ['admin', 'leader', 'recruiter', 'rep'], section: 'manage' },
  // Release 1.2: who changed what (U3).
  { to: '/audit', label: 'Audit', icon: 'History', roles: ['admin'], section: 'manage' },
  { to: '/settings', label: 'Settings', icon: 'Settings', roles: ['admin', 'leader', 'recruiter', 'rep'], section: 'me' },
  { to: '/about', label: 'About', icon: 'Info', roles: ['admin', 'leader', 'recruiter', 'rep'], section: 'me' },
];

/**
 * Release 1.3 (r3-foundation): the client portal's only navigation (features/client/ClientShell.tsx, P6). A client
 * account never sees NAV_ITEMS: App.tsx sends it to /client, and no staff item lists the `client` role.
 */
export const CLIENT_NAV_ITEMS: NavItem[] = [
  { to: '/client', label: 'Updates', icon: 'Megaphone', roles: ['client'], section: 'main', end: true },
  { to: '/client/security', label: 'Security', icon: 'ShieldCheck', roles: ['client'], section: 'me' },
];
