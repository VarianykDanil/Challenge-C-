import type { Role } from '@lm/shared';

export interface NavItem { to: string; label: string; icon: string; roles: Role[]; section?: 'main' | 'manage' | 'me' }

/** Icon names map to lucide-react icons in AppShell. */
export const NAV_ITEMS: NavItem[] = [
  { to: '/', label: 'Dashboard', icon: 'LayoutDashboard', roles: ['admin', 'leader', 'recruiter', 'rep'], section: 'main' },
  { to: '/events', label: 'Events', icon: 'CalendarDays', roles: ['admin', 'leader', 'recruiter', 'rep'], section: 'main' },
  { to: '/gauges', label: 'Gauges', icon: 'Gauge', roles: ['admin', 'leader', 'rep'], section: 'main' },
  { to: '/leaderboard', label: 'Leaderboard', icon: 'Trophy', roles: ['admin', 'leader', 'recruiter', 'rep'], section: 'main' },
  { to: '/recruitment', label: 'Recruitment', icon: 'UserPlus', roles: ['admin', 'leader', 'recruiter'], section: 'manage' },
  { to: '/finance', label: 'Finance', icon: 'Wallet', roles: ['admin', 'leader', 'recruiter', 'rep'], section: 'manage' },
  { to: '/campaigns', label: 'Campaigns', icon: 'Megaphone', roles: ['admin', 'leader'], section: 'manage' },
  { to: '/team', label: 'Team', icon: 'Users', roles: ['admin', 'leader', 'recruiter', 'rep'], section: 'manage' },
  { to: '/settings', label: 'Settings', icon: 'Settings', roles: ['admin', 'leader', 'recruiter', 'rep'], section: 'me' },
  { to: '/about', label: 'About', icon: 'Info', roles: ['admin', 'leader', 'recruiter', 'rep'], section: 'me' },
];
