// Owned by Marketing & Content. The five-person squad who built Linear Hub.
// Names here must match docs/TEAM.md and README.md.

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
    name: 'Tomasz Nowak',
    role: 'Backend Developer',
    focus: 'Express 5 API, SQLite schema, deterministic seed data, auth and role rules.',
    initials: 'TN',
    color: '#2563EB',
  },
  {
    name: 'Aisha Rahman',
    role: 'Frontend Developer',
    focus: 'React pages, data hooks, routing, auth flow and the gauge-entry experience.',
    initials: 'AR',
    color: '#8B5CF6',
  },
  {
    name: 'Callum Reid',
    role: 'Product Designer (Brand & UI)',
    focus: 'Design tokens, light and dark themes, UI kit, app shell and the sign-in screen.',
    initials: 'CR',
    color: '#EC4899',
  },
  {
    name: 'Mei-Ling Chen',
    role: 'Logic Builder (Data & Charts)',
    focus: 'Funnel maths, benchmark ratios, payroll calculation and the chart components.',
    initials: 'MC',
    color: '#10B981',
  },
  {
    name: 'Sophie Whitfield',
    role: 'Marketing & Content',
    focus: 'Product story, microcopy, user guide, business case and this About page.',
    initials: 'SW',
    color: '#F59E0B',
  },
];
