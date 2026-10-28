// How Linear Hub was built, for the About page. Keep it in step with docs/TEAM.md: no invented people.

export interface TeamMember {
  name: string;
  role: string;
  focus: string;
  initials: string;
  /** Hex colour for the initials avatar (passed to <Avatar color />). */
  color: string;
}

export const TEAM_MEMBERS: TeamMember[] = [
  {
    name: 'Noryn System Ltd',
    role: 'Builds, owns and supports it',
    focus: 'Licensed to Linear MCR Limited under a written agreement, with a monthly service for fixes, updates and the connections.',
    initials: 'NS',
    color: '#2563EB',
  },
  {
    name: 'One developer',
    role: 'Directs the work',
    focus: 'Agrees the scope with Linear MCR, splits each release into work packages and decides what ships.',
    initials: 'OD',
    color: '#8B5CF6',
  },
  {
    name: 'AI coding agents',
    role: 'Write the code',
    focus: 'Build the work packages side by side, tests first, each in its own copy of the code.',
    initials: 'AC',
    color: '#EC4899',
  },
  {
    name: 'Automated tests',
    role: 'Check every change',
    focus: 'Over 1,300 tests of the pay, gauge and permission rules, the server and the API run on every change.',
    initials: 'AT',
    color: '#10B981',
  },
  {
    name: 'Independent reviews',
    role: 'Look for what is wrong',
    focus: 'Claims, security, money, reliability, phone use and code are reviewed after each release; a second reviewer checks the first.',
    initials: 'IR',
    color: '#F59E0B',
  },
];
