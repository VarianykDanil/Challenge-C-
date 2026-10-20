import type { Role } from '@lm/shared';

export interface NavItem {
  to: string;
  label: string;
  icon: string;
  roles: Role[];
  section?: 'main' | 'manage' | 'me';
  /** 'action': the sidebar renders it as a prominent button above the sections (still listed in ⌘K quick nav). */
  variant?: 'action';
}

/** Icon names map to lucide-react icons in AppShell. */
export const NAV_ITEMS: NavItem[] = [
  { to: '/', label: 'Dashboard', icon: 'LayoutDashboard', roles: ['admin', 'leader', 'recruiter', 'rep'], section: 'main' },
  { to: '/events', label: 'Events', icon: 'CalendarDays', roles: ['admin', 'leader', 'recruiter', 'rep'], section: 'main' },
  { to: '/gauges', label: 'Gauges', icon: 'Gauge', roles: ['admin', 'leader', 'rep'], section: 'main' },
  // The field screen: six big buttons for the shift tally (pages/QuickGauges.tsx). Same roles as Gauges (GAUGE_ROLES).
  { to: '/quick', label: 'Quick gauges', icon: 'Tally5', roles: ['admin', 'leader', 'rep'], section: 'main', variant: 'action' },
  { to: '/leaderboard', label: 'Leaderboard', icon: 'Trophy', roles: ['admin', 'leader', 'recruiter', 'rep'], section: 'main' },
  // Release 1.2: the COD pack lessons and campaign pitches (L1, L2).
  { to: '/learning', label: 'Learning', icon: 'GraduationCap', roles: ['admin', 'leader', 'recruiter', 'rep'], section: 'main' },
  { to: '/recruitment', label: 'Recruitment', icon: 'UserPlus', roles: ['admin', 'leader', 'recruiter'], section: 'manage' },
  { to: '/finance', label: 'Finance', icon: 'Wallet', roles: ['admin', 'leader', 'recruiter', 'rep'], section: 'manage' },
  { to: '/campaigns', label: 'Campaigns', icon: 'Megaphone', roles: ['admin', 'leader'], section: 'manage' },
  { to: '/team', label: 'Team', icon: 'Users', roles: ['admin', 'leader', 'recruiter', 'rep'], section: 'manage' },
  // Release 1.2: who changed what (U3).
  { to: '/audit', label: 'Audit', icon: 'History', roles: ['admin'], section: 'manage' },
  { to: '/settings', label: 'Settings', icon: 'Settings', roles: ['admin', 'leader', 'recruiter', 'rep'], section: 'me' },
  { to: '/about', label: 'About', icon: 'Info', roles: ['admin', 'leader', 'recruiter', 'rep'], section: 'me' },
];
