// Owned by Marketing & Content. Product story and facts for the About page and README.
import type { Role } from '@lm/shared';

export const APP_VERSION = '1.4.0';

export interface StackItem { name: string; detail: string }
export interface RoleSummary { role: Role; title: string; description: string }

export const ABOUT = {
  version: APP_VERSION,
  releaseDate: '2026-10-25',
  madeIn: 'Made in Manchester',

  /** The product story, one paragraph per entry. */
  story: [
    'Linear MCR runs face-to-face sales for well-known brands and charities: B2B and B2C campaigns, private-site events and fundraising days across the North West. Every rep on every event records the same six gauges — stops, to table, presentations, closes, taps and sales — and judges them against the law of averages. That discipline is the business. Until now, it lived on paper, in WhatsApp threads and in people’s heads.',
    'Linear Hub puts the gauges, the people and the money in one place. A rep signs in with their work email and employee ID and sees their own numbers, their ratios against the benchmarks, their next payday and where they sit on their team’s board. A leader can read every team’s numbers, schedules events for their own team and can log a day on behalf of anyone on it. The recruiter runs the pipeline from application to hire, and a hire becomes a rep account on the spot. The office sees campaign payouts, payroll and whether people were paid on time, and can pay them from Linear Hub.',
    'We built it around the way Linear already works rather than asking the business to change. The funnel rule is enforced at the point of entry (you cannot have more presentations than people at the table). The benchmarks are the company’s own. The pay plan is the one on the wall. The aim is simple: fewer questions that take an hour to answer, and coaching that starts with a ratio instead of a hunch.',
  ],

  /** A one-line mission, for hero sections and the README. */
  mission: 'Every stop counted, every payday on time, every trainee able to see the path to owner.',

  whoItsFor: [
    { role: 'rep', title: 'Field representatives', description: 'Log the day in under a minute, see ratios against the benchmarks, check pay and punctuality.' },
    { role: 'leader', title: 'Team and crew leaders', description: 'Create events, log for the team, add new trainees to it, see who needs coaching on which stage, and track the team’s week.' },
    { role: 'recruiter', title: 'Recruiters', description: 'Run the pipeline from application to observation day to hire, with overdue actions surfaced and a rep account created the moment someone is hired.' },
    { role: 'admin', title: 'The office', description: 'People, campaign payouts, payroll runs and paying people, expenses and company finance in one view — and the only place employee IDs are shown.' },
  ] satisfies RoleSummary[],

  stack: [
    { name: 'React 19', detail: 'User interface' },
    { name: 'Vite 6', detail: 'Dev server and build' },
    { name: 'Tailwind CSS v4', detail: 'Semantic design tokens' },
    { name: 'TanStack Query 5', detail: 'Data fetching and caching' },
    { name: 'React Router 7', detail: 'Navigation' },
    { name: 'Recharts', detail: 'Funnels, trends and donuts' },
    { name: 'Express 5', detail: 'JSON API' },
    { name: 'SQLite (node:sqlite)', detail: 'Zero-dependency database' },
    { name: 'TypeScript 5', detail: 'Shared domain types and logic' },
    { name: 'Zod', detail: 'Request validation' },
  ] satisfies StackItem[],

  /** Principles we held to while building. */
  principles: [
    { title: 'Built around the gauges', body: 'Six numbers, in funnel order, validated as you type. Everything else is derived from them.' },
    { title: 'One sign-in per person', body: 'Work email plus employee ID, then a code from an authenticator app — no password yet, so IDs are shown only to the office and to you. Reps see their own numbers and their team; leaders read company-wide and change only their own team; recruiters run the pipeline; the office sees everything.' },
    { title: 'Honest about pay', body: 'Every payslip is itemised against the pay plan, and every payday is tracked for punctuality.' },
    { title: 'Works on a phone in a car park', body: 'Large tap targets, a dark theme and nothing that needs a desk.' },
  ],
} as const;
