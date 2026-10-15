import type { CandidateSource, CandidateStage, DashboardRange, EventType, ExpenseCategory, GaugeKey, Position, Role } from './types.ts';

/** Single source of truth for the brand name (the company is Linear MCR Limited, Manchester). */
export const BRAND = {
  name: 'Linear MCR',
  legalName: 'Linear MCR Limited',
  shortName: 'Linear',
  product: 'Linear Hub',
  tagline: 'Every stop counts.',
  city: 'Manchester',
  address: '1 North Parade, Parsonage Gardens, Manchester',
  website: 'https://www.linear-mcr.co.uk',
  currency: 'GBP',
  locale: 'en-GB',
} as const;

export const POSITION_LABELS: Record<Position, string> = {
  trainee: 'Trainee',
  field_rep: 'Field Representative',
  team_leader: 'Team Leader',
  crew_leader: 'Crew Leader',
  assistant_owner: 'Assistant Owner',
  owner: 'Owner',
  recruiter: 'Recruiter',
};

export const ROLE_LABELS: Record<Role, string> = {
  admin: 'Administrator',
  leader: 'Leader',
  recruiter: 'Recruiter',
  rep: 'Representative',
};

export const STAGE_LABELS: Record<CandidateStage, string> = {
  applied: 'Applied',
  screening: 'Phone screen',
  interview: 'Interview',
  observation: 'Observation day',
  offer: 'Offer',
  hired: 'Hired',
  rejected: 'Rejected',
  withdrawn: 'Withdrawn',
};

export const SOURCE_LABELS: Record<CandidateSource, string> = {
  indeed: 'Indeed',
  linkedin: 'LinkedIn',
  referral: 'Referral',
  website: 'Website',
  walk_in: 'Walk-in',
  agency: 'Agency',
  university: 'University',
  other: 'Other',
};

export const EVENT_TYPE_LABELS: Record<EventType, string> = {
  private_site: 'Private site',
  event: 'Event',
  b2b: 'B2B',
  residential: 'Residential',
  retail: 'Retail',
};

export const EXPENSE_CATEGORY_LABELS: Record<ExpenseCategory, string> = {
  venue: 'Venue fees',
  travel: 'Travel',
  office: 'Office',
  software: 'Software',
  recruitment: 'Recruitment',
  marketing: 'Marketing',
  other: 'Other',
};

export const GAUGE_LABELS = {
  stops: 'Stops',
  table: 'To table',
  presentations: 'Presentations',
  closes: 'Closes',
  taps: 'Taps',
  sales: 'Sales',
} as const;

/**
 * Company benchmark ratios ("law of averages") used to colour performance.
 * A rep at or above these is on track.
 */
export const BENCHMARK_RATIOS = {
  stopToTable: 0.35,
  tableToPresentation: 0.5,
  presentationToClose: 0.4,
  closeToTap: 0.6,
  tapToSale: 0.9,
} as const;

/** Minutes after the event start time after which a check-in counts as late. */
export const LATE_GRACE_MINUTES = 5;

// ───────────────────────── Added by the Logic Builder ─────────────────────────

/** Keys of the five stage-to-stage ratios, in funnel order. */
export type RatioKey = keyof typeof BENCHMARK_RATIOS;

/** Ordered list of the five stage-to-stage ratio keys. */
export const RATIO_KEYS: readonly RatioKey[] = [
  'stopToTable',
  'tableToPresentation',
  'presentationToClose',
  'closeToTap',
  'tapToSale',
] as const;

/** Human labels for each ratio, e.g. for chart chips and coaching copy. */
export const RATIO_LABELS: Record<RatioKey, string> = {
  stopToTable: 'Stop → table',
  tableToPresentation: 'Table → presentation',
  presentationToClose: 'Presentation → close',
  closeToTap: 'Close → tap',
  tapToSale: 'Tap → sale',
};

/** Compact labels for tight layouts (cards, mobile). */
export const RATIO_SHORT_LABELS: Record<RatioKey, string> = {
  stopToTable: 'S→T',
  tableToPresentation: 'T→P',
  presentationToClose: 'P→C',
  closeToTap: 'C→T',
  tapToSale: 'T→S',
};

/** Short gauge labels for compact funnel rendering. */
export const GAUGE_SHORT_LABELS: Record<GaugeKey, string> = {
  stops: 'Stops',
  table: 'Table',
  presentations: 'Pres.',
  closes: 'Closes',
  taps: 'Taps',
  sales: 'Sales',
};

/**
 * Relative tolerance around a benchmark that still counts as "on track".
 * 0.1 means within ±10% of the benchmark value (e.g. 0.45–0.55 for a 0.5 benchmark).
 */
export const BENCHMARK_TOLERANCE = 0.1;

/**
 * Relative shortfall below a benchmark beyond which a stage is graded `poor` (danger) rather than
 * `watch` (warning). 0.25 means more than 25% under the benchmark value.
 */
export const BENCHMARK_DANGER_THRESHOLD = 0.25;

/** Sales per worked day that earns full marks on the volume half of the performance score. */
export const TARGET_SALES_PER_DAY = 2;

/** Weights of the two halves of `performanceScore` (must sum to 1). */
export const PERFORMANCE_WEIGHTS = { funnel: 0.6, volume: 0.4 } as const;

/** Below this many stops the ratios are too noisy to coach on confidently. */
export const MIN_STOPS_FOR_INSIGHTS = 20;

/**
 * Pay weeks run Monday–Sunday and are paid on the Friday after the week ends,
 * i.e. `weekEnd (Sunday) + 5 days`.
 */
export const PAYDAY_DAYS_AFTER_WEEK_END = 5;

export const DASHBOARD_RANGE_LABELS: Record<DashboardRange, string> = {
  week: 'This week',
  month: 'This month',
  quarter: 'This quarter',
};
