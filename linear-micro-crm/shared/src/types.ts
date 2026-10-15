/**
 * Linear MCR CRM — shared domain types.
 * These types are the contract between server, client and logic modules.
 * Treat existing fields as frozen; add new OPTIONAL fields only.
 *
 * Conventions
 *  - Dates are ISO strings: `YYYY-MM-DD` for dates, full ISO 8601 for timestamps.
 *  - Money is GBP in pounds as a plain number with up to 2 decimals (e.g. 1234.5).
 *  - IDs are positive integers assigned by the database.
 */

// ───────────────────────────── People ─────────────────────────────

/** Permission role used by the API and the UI navigation. */
export type Role = 'admin' | 'leader' | 'recruiter' | 'rep';

/** Career ladder used by face-to-face sales organisations. */
export type Position =
  | 'trainee'
  | 'field_rep'
  | 'team_leader'
  | 'crew_leader'
  | 'assistant_owner'
  | 'owner'
  /** Office-based recruiter (no field sales; paid Mon–Fri, bonus on hires). */
  | 'recruiter';

export const POSITIONS: Position[] = [
  'trainee',
  'field_rep',
  'team_leader',
  'crew_leader',
  'assistant_owner',
  'owner',
  'recruiter',
];

export type UserStatus = 'active' | 'on_leave' | 'left';

export interface User {
  id: number;
  /** Public employee code, e.g. "LM-0042". Used together with email to sign in. */
  employeeId: string;
  email: string;
  firstName: string;
  lastName: string;
  role: Role;
  position: Position;
  teamId: number | null;
  payPlanId: number;
  startDate: string;
  status: UserStatus;
  phone: string | null;
  /** Hex colour used for the initials avatar, e.g. "#4F46E5". */
  avatarColor: string;
  city: string | null;
}

/** User plus a few joined display fields. */
export interface UserWithTeam extends User {
  teamName: string | null;
  payPlanName: string;
}

export interface Team {
  id: number;
  name: string;
  leaderId: number | null;
  /** Hex colour for charts and badges. */
  color: string;
  memberCount?: number;
  leaderName?: string | null;
}

// ─────────────────────────── Campaigns ───────────────────────────

export type CampaignSector = 'charity' | 'energy' | 'telecoms' | 'broadband' | 'other';
export type CampaignType = 'fundraising' | 'b2c' | 'b2b';

export interface Campaign {
  id: number;
  name: string;
  /** Short display code, e.g. "BCN". */
  code: string;
  sector: CampaignSector;
  type: CampaignType;
  /** What the client pays Linear per confirmed sale. */
  payoutPerSale: number;
  /** Default commission paid to the rep per confirmed sale (pay plans may override). */
  repCommissionPerSale: number;
  color: string;
  active: boolean;
  startDate: string;
  description: string | null;
}

// ───────────────────────────── Events ─────────────────────────────

export type EventType = 'private_site' | 'event' | 'b2b' | 'residential' | 'retail';
export type EventStatus = 'scheduled' | 'live' | 'completed' | 'cancelled';

export interface SalesEvent {
  id: number;
  campaignId: number;
  teamId: number;
  name: string;
  venue: string;
  city: string;
  type: EventType;
  date: string;
  /** "HH:MM" 24h */
  startTime: string;
  endTime: string;
  status: EventStatus;
  targetSales: number;
  notes: string | null;
}

export interface SalesEventWithMeta extends SalesEvent {
  campaignName: string;
  campaignCode: string;
  campaignColor: string;
  teamName: string;
  teamColor: string;
  /** Aggregated gauges for the event (all reps). */
  totals: GaugeTotals;
  repCount: number;
}

// ───────────────────────────── Gauges ─────────────────────────────

/**
 * The six field gauges, in funnel order. Each stage is a subset of the previous:
 * stops ≥ table ≥ presentations ≥ closes ≥ taps ≥ sales.
 */
export const GAUGE_KEYS = ['stops', 'table', 'presentations', 'closes', 'taps', 'sales'] as const;
export type GaugeKey = (typeof GAUGE_KEYS)[number];

export type GaugeTotals = Record<GaugeKey, number>;

export interface GaugeEntry extends GaugeTotals {
  id: number;
  eventId: number;
  userId: number;
  date: string;
  /** ISO timestamp the rep checked in at the event, null if not recorded. */
  checkedInAt: string | null;
  notes: string | null;
  submittedAt: string;
}

export interface GaugeEntryWithMeta extends GaugeEntry {
  userName: string;
  userPosition: Position;
  userAvatarColor: string;
  teamId: number | null;
  teamName: string | null;
  eventName: string;
  eventStartTime: string;
  campaignId: number;
  campaignName: string;
  campaignColor: string;
}

export interface GaugeUpsertInput extends GaugeTotals {
  eventId: number;
  userId: number;
  date: string;
  checkedInAt?: string | null;
  notes?: string | null;
}

/** Stage-to-stage conversion ratios (0..1), plus derived efficiency metrics. */
export interface FunnelRatios {
  stopToTable: number;
  tableToPresentation: number;
  presentationToClose: number;
  closeToTap: number;
  tapToSale: number;
  /** sales / stops */
  overallConversion: number;
  /** stops needed per sale (Infinity when sales = 0) */
  stopsPerSale: number;
}

/** One row of an aggregated gauge summary (per user / team / campaign / day). */
export interface GaugeSummaryRow extends GaugeTotals {
  key: string;
  label: string;
  color: string | null;
  days: number;
  ratios: FunnelRatios;
  /** average sales per worked day */
  salesPerDay: number;
}

export type GaugeGroupBy = 'user' | 'team' | 'campaign' | 'day' | 'week';

// ───────────────────────────── Finance ─────────────────────────────

export interface PayPlan {
  id: number;
  name: string;
  position: Position;
  /** Daily base pay for each day worked. */
  basePerDay: number;
  commissionPerSale: number;
  /** Weekly sales count that unlocks the bonus. */
  bonusThreshold: number;
  bonusAmount: number;
  /** Paid to leaders per sale made by their team (excluding their own). */
  overridePerTeamSale: number;
}

export type PayrollStatus = 'pending' | 'paid' | 'late' | 'failed';

export interface PayrollRun {
  id: number;
  userId: number;
  weekStart: string;
  weekEnd: string;
  daysWorked: number;
  sales: number;
  teamSales: number;
  basePay: number;
  commission: number;
  bonus: number;
  overrides: number;
  deductions: number;
  gross: number;
  dueDate: string;
  paidDate: string | null;
  status: PayrollStatus;
  reference: string;
}

export interface PayrollRunWithUser extends PayrollRun {
  userName: string;
  employeeId: string;
  position: Position;
  teamName: string | null;
  /** true when paidDate is set and <= dueDate */
  onTime: boolean | null;
}

export type ExpenseCategory =
  | 'venue'
  | 'travel'
  | 'office'
  | 'software'
  | 'recruitment'
  | 'marketing'
  | 'other';

export interface Expense {
  id: number;
  date: string;
  category: ExpenseCategory;
  amount: number;
  description: string;
  campaignId: number | null;
  eventId: number | null;
}

export interface FinanceWeek {
  weekStart: string;
  revenue: number;
  payroll: number;
  expenses: number;
  profit: number;
  sales: number;
  /** true when the week has no payroll runs yet (the week in progress) and `payroll` is the live estimate. */
  estimated?: boolean;
}

export interface CampaignFinance {
  campaignId: number;
  campaignName: string;
  campaignColor: string;
  sales: number;
  revenue: number;
  commission: number;
  margin: number;
}

export interface FinanceSummary {
  from: string;
  to: string;
  totals: { revenue: number; payroll: number; expenses: number; profit: number; sales: number };
  weeks: FinanceWeek[];
  byCampaign: CampaignFinance[];
  payroll: {
    runs: number;
    paid: number;
    pending: number;
    late: number;
    /** 0..1 share of paid runs that were paid on or before the due date */
    onTimeRate: number;
    /** average days between due date and paid date for late runs */
    avgDaysLate: number;
  };
  expensesByCategory: { category: ExpenseCategory; amount: number }[];
}

// ─────────────────────────── Recruitment ───────────────────────────

export type CandidateSource =
  | 'indeed'
  | 'linkedin'
  | 'referral'
  | 'website'
  | 'walk_in'
  | 'agency'
  | 'university'
  | 'other';

/** Pipeline stages in order. `hired`, `rejected`, `withdrawn` are terminal. */
export type CandidateStage =
  | 'applied'
  | 'screening'
  | 'interview'
  | 'observation'
  | 'offer'
  | 'hired'
  | 'rejected'
  | 'withdrawn';

export const PIPELINE_STAGES: CandidateStage[] = [
  'applied',
  'screening',
  'interview',
  'observation',
  'offer',
  'hired',
];
export const TERMINAL_STAGES: CandidateStage[] = ['hired', 'rejected', 'withdrawn'];

export interface Candidate {
  id: number;
  firstName: string;
  lastName: string;
  email: string;
  phone: string | null;
  city: string | null;
  source: CandidateSource;
  stage: CandidateStage;
  positionApplied: Position;
  appliedAt: string;
  stageUpdatedAt: string;
  ownerId: number | null;
  referredById: number | null;
  /** 1..5, null until screened */
  rating: number | null;
  notes: string | null;
  nextAction: string | null;
  nextActionAt: string | null;
  /** Set when stage becomes `hired` and a User record is created. */
  hiredUserId: number | null;
}

export interface CandidateWithMeta extends Candidate {
  ownerName: string | null;
  referredByName: string | null;
  /** days since appliedAt (or until hired/closed) */
  daysInPipeline: number;
}

export interface StageChange {
  id: number;
  candidateId: number;
  fromStage: CandidateStage | null;
  toStage: CandidateStage;
  changedAt: string;
  changedById: number | null;
  changedByName?: string | null;
  note: string | null;
}

export interface Interview {
  id: number;
  candidateId: number;
  type: 'phone' | 'first' | 'observation' | 'final';
  scheduledAt: string;
  interviewerId: number | null;
  interviewerName?: string | null;
  outcome: 'pending' | 'passed' | 'failed' | 'no_show';
  notes: string | null;
}

export interface RecruitmentSummary {
  from: string;
  to: string;
  /** Candidates currently in each stage (open pipeline). */
  openByStage: Record<CandidateStage, number>;
  /** Funnel for candidates who applied in range: how many reached each stage. */
  funnel: { stage: CandidateStage; count: number }[];
  bySource: { source: CandidateSource; applied: number; hired: number; conversion: number }[];
  weekly: { weekStart: string; applied: number; interviews: number; hired: number }[];
  hired: number;
  applied: number;
  /** average days from applied → hired */
  avgTimeToHireDays: number;
  /** candidates whose nextActionAt is in the past and stage is open */
  overdueActions: number;
}

// ─────────────────────────── Misc ───────────────────────────

export interface Announcement {
  id: number;
  title: string;
  body: string;
  authorId: number;
  authorName?: string;
  createdAt: string;
  pinned: boolean;
}

export interface LeaderboardRow {
  rank: number;
  userId: number;
  userName: string;
  position: Position;
  avatarColor: string;
  teamId: number | null;
  teamName: string | null;
  teamColor: string | null;
  sales: number;
  stops: number;
  days: number;
  conversion: number;
  /** change in rank vs previous period (positive = moved up), null if new */
  movement: number | null;
}

export type DashboardRange = 'week' | 'month' | 'quarter';

export interface TrendPoint {
  date: string;
  sales: number;
  stops: number;
  presentations: number;
}

export interface Dashboard {
  range: DashboardRange;
  from: string;
  to: string;
  /** Comparison window behind `personal.deltas` and leaderboard `movement`: the same to-date span of the previous week / month / quarter. */
  previous?: { from: string; to: string };
  user: UserWithTeam;
  personal: {
    totals: GaugeTotals;
    ratios: FunnelRatios;
    days: number;
    salesPerDay: number;
    /** vs the previous period of the same length, as fractions (e.g. 0.12 = +12%) */
    deltas: { sales: number | null; conversion: number | null; stops: number | null };
    rank: number | null;
    rankOutOf: number;
    earningsToDate: number;
    nextPayday: string | null;
    nextPayAmount: number | null;
    punctualityRate: number | null;
    trend: TrendPoint[];
  };
  team: {
    teamId: number;
    teamName: string;
    totals: GaugeTotals;
    ratios: FunnelRatios;
    members: number;
    trend: TrendPoint[];
    leaderboard: LeaderboardRow[];
  } | null;
  /** Only present for admin and leader roles. */
  company: {
    totals: GaugeTotals;
    ratios: FunnelRatios;
    activeReps: number;
    revenue: number;
    payrollOnTimeRate: number;
    /** Which window `payrollOnTimeRate` describes: the requested range, or the last 12 weeks when nothing was due in range. */
    payrollOnTimeWindow?: 'range' | 'last12Weeks';
    openCandidates: number;
    hiresThisPeriod: number;
    trend: TrendPoint[];
    byCampaign: { campaignId: number; name: string; color: string; sales: number }[];
  } | null;
  upcomingEvents: SalesEventWithMeta[];
  announcements: Announcement[];
}

// ─────────────────────────── Auth ───────────────────────────

export interface LoginInput {
  email: string;
  employeeId: string;
}

export interface AuthResponse {
  user: UserWithTeam;
}

export interface ApiError {
  error: string;
  details?: unknown;
}
