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

// Release 1.3 (r3-foundation): optional fields on core types reference the package contract files (type-only imports).
import type { AnnouncementSource } from './types/client.ts';
import type { InvoiceSummary } from './types/invoices.ts';
import type { PaidAs } from './types/pay.ts';
import type { EventBookingSummary } from './types/venues.ts';

// ───────────────────────────── People ─────────────────────────────

/**
 * Permission role used by the API and the UI navigation. Release 1.3 (r3-foundation): `client` is a campaign's client
 * (the charity or company) signed in to the client portal. A client session may call ONLY /auth/* (me, logout, PIN),
 * /health and /client/* — the server's client guard (middleware/clientGuard.ts) answers 403 to everything else, and a
 * client never appears in a staff list (Team, search, payroll, leaderboards, read receipts).
 */
export type Role = 'admin' | 'leader' | 'recruiter' | 'rep' | 'client';

/** The four staff roles (everyone who works for Linear MCR), in the order the Team form lists them. */
export const STAFF_ROLES = ['admin', 'leader', 'recruiter', 'rep'] as const satisfies readonly Role[];
export type StaffRole = (typeof STAFF_ROLES)[number];
/** Every role, staff first (release 1.3 adds `client`). */
export const ROLES: readonly Role[] = [...STAFF_ROLES, 'client'];
/** True for the four staff roles; false for `client` (and anything else). */
export function isStaffRole(role: string | null | undefined): role is StaffRole {
  return (STAFF_ROLES as readonly string[]).includes(role ?? '');
}

/** Career ladder used by face-to-face sales organisations. */
export type Position =
  | 'trainee'
  | 'field_rep'
  | 'team_leader'
  | 'crew_leader'
  | 'assistant_owner'
  | 'owner'
  /** Office-based recruiter (no field sales; paid Mon–Fri, bonus on hires). */
  | 'recruiter'
  /** Release 1.3: a client portal account (role `client`); never in POSITIONS, never paid, never in a staff list. */
  | 'client';

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
  /** Present on /auth/me and login responses: whether two-step verification is switched on. */
  twoFactorEnabled?: boolean;
  /** Release 1.2 (U1): present on /auth/me and login responses only — whether the caller has set a sign-in PIN. */
  hasPin?: boolean;
  /** Release 1.2 (U1): true while the admin requires a PIN and the caller has none (the client shows "Create your PIN"). */
  pinSetupRequired?: boolean;
  /** Release 1.2 (U1): true while admins must use two-step verification and this admin has not set it up. */
  twoFactorSetupRequired?: boolean;
  /**
   * Release 1.3 (r3-foundation, used by P6): the campaign a `client` account belongs to (users.client_campaign_id).
   * Present on /auth/me and the sign-in responses for client accounts only; absent for staff. A client account's own
   * payload also leaves out teamId, teamName, payPlanId and payPlanName (server lib/client.ts clientSafeUser): code that
   * runs for a client session never reads them.
   */
  clientCampaignId?: number | null;
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
  /**
   * Smart release 1.1 (p6): expected-sales estimate, attached by GET /events and GET /events/:id to scheduled and
   * live events that have enough history. The key is absent otherwise (and always absent with LM_SMART=0).
   */
  forecast?: EventForecast | null;
  /**
   * Smart release 1.1 (p6): how many of the event's own team have logged it, attached by GET /events and
   * GET /events/:id to completed and live events dated today − 2 … today. Absent otherwise (and with LM_SMART=0).
   */
  roster?: EventRosterCount;
  /**
   * Release 1.3 (P8 venue-insights): who is booked on the event (event_roster), attached by P8's routes when the
   * caller may see it. Absent until P8 lands. Not the p6 `roster` above (that counts who has LOGGED it).
   */
  bookings?: EventBookingSummary;
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
  /**
   * Release 1.2 (review S3): true when a leader or admin recorded `checkedInAt` on the person's behalf. That time then
   * counts for punctuality over the person's own one-tap check-in, and the person cannot change it themself. False
   * or absent otherwise, and whenever `checkedInAt` is withheld from the viewer.
   */
  checkInOnBehalf?: boolean;
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
  /** stops needed per sale; `null` when there are no sales yet (JSON cannot carry Infinity) */
  stopsPerSale: number | null;
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
  /** Set when an admin changed the week's gauges after the run was paid: the payslip shows "adjusted after payment". */
  adjustedAt?: string | null;
  /**
   * Release 1.3 (P1 pay-rule; columns laid down by r3-foundation in db/extensions/pay.ts). Present only once P1 has
   * written them for the run (absent, never null, on runs calculated by the 1.2 plan rules):
   *  - paidAs: which of base or commission the week paid (decision 2: the higher one, a tie pays commission);
   *  - salesLogged / salesConfirmed / salesCancelled: subs logged in gauges, confirmed by the clients' statements (or
   *    equal to logged until a statement confirms the period) and cancelled (logged − confirmed, never negative);
   *  - adjustmentsTotal: the sum of the adjustment lines (corrections from earlier weeks) included in `gross`.
   */
  paidAs?: PaidAs;
  salesLogged?: number;
  salesConfirmed?: number;
  salesCancelled?: number;
  adjustmentsTotal?: number;
}

export interface PayrollRunWithUser extends PayrollRun {
  userName: string;
  employeeId: string;
  position: Position;
  teamName: string | null;
  /** true when paidDate is set and <= dueDate */
  onTime: boolean | null;
  /**
   * Smart release 1.1 (p3): advisory checks before paying, attached by GET /finance/payroll and
   * GET /finance/payroll/:id for admins only and only on pending / failed runs. Absent for every other role.
   */
  flags?: PayrollFlag[];
  /**
   * Release 1.3 (P2 invoices): the self-billing invoice for this run, attached by the finance routes through
   * lib/invoices.ts `withInvoiceSummaries` once P2 lands (absent until an invoice is issued).
   */
  invoice?: InvoiceSummary;
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
  /**
   * Release 1.3 (P7 recruitment-plus; column candidates.date_of_birth laid down by r3-foundation): YYYY-MM-DD.
   * Present only when recorded (absent otherwise). Recruitment roles only, like every candidate field.
   */
  dateOfBirth?: string;
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
  /**
   * Release 1.3 (P6 client-portal): set when a campaign's client posted it from the client portal (the author is a
   * `client` account), for the "From Breast Cancer Now" badge. Absent for the office's own announcements.
   */
  fromClient?: AnnouncementSource;
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
  /**
   * Smart release 1.1 (p2): the person's current sales streak in worked days (see `Streaks.current`), attached by
   * GET /leaderboard. Absent when not computed (stub, or LM_SMART=0).
   */
  streak?: number;
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
  /** Release 1.2: how many announcements there are beyond these five (GET /announcements?offset=5 lists them). */
  olderAnnouncements?: number;
}

// ─────────────────────────── Auth ───────────────────────────

export interface LoginInput {
  email: string;
  employeeId: string;
  /** Release 1.2 (U1): the 4–6 digit PIN, required once the person has set one (see types/pin.ts). */
  pin?: string;
}

export interface AuthResponse {
  user: UserWithTeam;
}

/** Returned by POST /auth/login instead of AuthResponse when the account has two-step verification on. */
export interface TwoFactorChallenge {
  requiresTwoFactor: true;
  challengeToken: string;
  method: 'totp';
}

export interface TwoFactorStatus {
  enabled: boolean;
  enabledAt: string | null;
  recoveryCodesLeft: number;
  pendingSetup: boolean;
}

export interface TwoFactorSetup {
  /** Base32 secret for manual entry. */
  secret: string;
  otpauthUrl: string;
  /** Inline SVG markup of the QR code. */
  qrSvg: string;
}

export interface TwoFactorEnabled {
  recoveryCodes: string[];
}

export interface ApiError {
  error: string;
  details?: unknown;
}

// ───────────────────── Smart release 1.1 (additive) ─────────────────────
//
// Contracts for the rule-based "smart" features. Every payload below is built from data the caller may already see
// (role scoping is unchanged) and every field is null / empty when the kill switch is off (LM_SMART=0).
// Owners: p2 pace & streaks, p3 pay forecast & payroll checks, p4 check-ins, p5 attention feed, p6 event forecasts,
// p9 weekly digest, p10 backups. `WeekStat` (the weekly history row) lives in logic/stats.ts.

/** p2 — this week's pace against the person's OWN last 8 completed weeks. Never returned for anyone but the caller. */
export interface PersonalBaseline {
  /** Completed weeks with at least one worked day inside the 8-week window (≥ 4, or the baseline is null). */
  weeks: number;
  /** Mean of the per-week stops per worked day over those weeks (μ). */
  stopsPerDayMean: number;
  /** Sample standard deviation of the per-week stops per worked day (σ, n − 1; 0 with fewer than 2 weeks). */
  stopsPerDaySd: number;
  /** Pooled conversion (Σ sales ÷ Σ stops, 0..1) over those weeks — the p0 of the conversion test. */
  conversion: number;
  /** This week so far: Monday up to yesterday (today and live events excluded). */
  current: { days: number; stops: number; sales: number; stopsPerDay: number; conversion: number };
  /** At most 2, deterministic copy (British English). Empty when this week is in the usual range. */
  alerts: BaselineAlert[];
}

export interface BaselineAlert {
  metric: 'stopsPerDay' | 'conversion';
  tone: 'positive' | 'warning';
  /** The z-score that fired the alert. */
  z: number;
  /** This week's value: stops per day, or conversion as a 0..1 fraction. */
  current: number;
  /** The usual value in the same unit (μ, or the pooled conversion p0). */
  usual: number;
  title: string;
  body: string;
}

/** p2 — conversion direction: the oldest 8 of 16 completed weeks against the newest 8 (two-proportion z-test). */
export interface TrendDirection {
  label: 'improving' | 'declining' | 'steady';
  z: number;
  /** Pooled conversion of the newest half (0..1). */
  recentConversion: number;
  /** Pooled conversion of the oldest half (0..1). */
  earlierConversion: number;
  recentStops: number;
  earlierStops: number;
}

/** p2 — sales streaks counted in worked days (calendar days without gauges never break a run). */
export interface Streaks {
  /** The run of worked days with ≥ 1 sale ending at the last worked day before today. */
  current: number;
  /** The longest such run ever. */
  best: number;
  /** True when this week's sales beat every previous week with ≥ 3 worked days (and ≥ 4 such weeks exist). */
  personalBestWeek: boolean;
  /** Sales this week so far (Monday up to yesterday). */
  weekSales: number;
  /** The best previous week's sales (weeks with ≥ 3 worked days); 0 when there is none. */
  bestPreviousWeekSales: number;
}

/** p2 — one row of `SmartInsights.boardStreaks`: a visible colleague's current streak (only streaks ≥ 5 are listed). */
export interface BoardStreak {
  userId: number;
  streak: number;
}

export type BonusLikelihood = 'reached' | 'likely' | 'possible' | 'unlikely' | 'none';

/**
 * p3 — this pay week's estimated gross, as a low / likely / high range. An estimate only: never written to
 * payroll_runs; Friday's payslip (`nextPayAmount`) stays the official figure. Money is GBP gross.
 */
export interface PayForecast {
  /** Monday of the pay week. */
  weekStart: string;
  /** The Friday after the week ends (shared `paydayForWeek`). */
  payday: string;
  estimate: true;
  /** Logged so far this week (Monday up to and including today's logged rows); `gross` = estimateWeekPay of these. */
  soFar: { days: number; sales: number; gross: number };
  /** Team event days still to come this week (today counts while unlogged and scheduled / live). */
  remainingDays: number;
  /** Estimated gross for the whole week, clamped so low ≤ likely ≤ high. */
  low: number;
  likely: number;
  high: number;
  bonusThreshold: number;
  bonusAmount: number;
  /** max(0, threshold − soFar.sales); 0 when the plan has no bonus. */
  bonusGap: number;
  /** P(reaching the threshold this week), 0..1; 1 when the gap is 0. */
  bonusProbability: number;
  bonusLikelihood: BonusLikelihood;
  /** Stops needed for the missing sales at the person's own ratios; null with too little history or a dead funnel. */
  stopsForBonus: number | null;
  /** What the estimate is based on: completed weeks used, worked days in them, and λ (sales per worked day). */
  basis: { weeks: number; workedDays: number; salesPerDay: number };
  /** Optional extra: the projected week's sales behind low / likely / high. */
  sales?: { low: number; likely: number; high: number };
}

export type PayrollFlagCode =
  | 'first_payslip'
  | 'high_gross'
  | 'bonus_single_day'
  | 'sales_without_days'
  | 'high_deductions'
  | 'stale_amount'
  | 'override_no_days';

/** p3 — one advisory check on an unpaid payroll run (admin only). Advisory: it never blocks paying. */
export interface PayrollFlag {
  code: PayrollFlagCode;
  severity: 'info' | 'warning';
  text: string;
}

export type CheckInReasonCode =
  | 'sustained_decline'
  | 'conversion_drop'
  | 'stops_drop'
  | 'attendance_drop'
  | 'zero_week'
  | 'earnings_drop'
  | 'trainee_slow'
  | 'late_often';

/** p4 — one reason to check in with someone, written out as a conversation starter (never a verdict). */
export interface CheckInReason {
  code: CheckInReasonCode;
  weight: number;
  text: string;
}

/** p4 — a person on the private "Check in with…" list (leader: own team; admin: company). */
export interface CheckInPerson {
  userId: number;
  userName: string;
  position: Position;
  avatarColor: string;
  teamId: number | null;
  teamName: string | null;
  /** Sum of the reason weights; the list keeps scores ≥ 2, highest first, at most 5 people. */
  score: number;
  reasons: CheckInReason[];
}

/**
 * Release 1.3 (r3-foundation) adds three kinds, each filled by one package through the server's attention provider
 * registry (server/src/lib/attention/index.ts): `invoices` (P2: issued, deemed accepted soon, disputed, resolved),
 * `statements` (P3: a commission statement needs review) and `client` (P6: a new client post).
 */
export type AttentionKind = 'gauges' | 'pay' | 'payroll' | 'events' | 'recruitment' | 'security' | 'invoices' | 'statements' | 'client';
export type AttentionSeverity = 'info' | 'warning' | 'danger';

/** p5 — one item in the role-scoped "Needs attention" feed (no table: derived on every request). */
export interface AttentionItem {
  /** Deterministic, e.g. `gauges:event:42:user:10`, so a resolved item disappears by itself and seen-state sticks. */
  key: string;
  kind: AttentionKind;
  severity: AttentionSeverity;
  title: string;
  body: string;
  /** In-app link, e.g. `/gauges?log=1&eventId=42`. */
  href: string;
  actionLabel?: string;
  /** ISO timestamp (or date) the item is about; sorts newest first within a severity. */
  at?: string;
  /** p5: how many things a summary item covers (people missing, follow-ups, runs); a higher count is new again. */
  count?: number;
}

/** p5 — GET /me/attention. Sorted danger → warning → info, then newest first; at most 20 items. */
export interface AttentionFeed {
  items: AttentionItem[];
  /** ISO timestamp of when the feed was built. */
  generatedAt: string;
  /** p5: present (true) only when the smart features are switched off (LM_SMART=0), so the client hides the card. */
  disabled?: true;
}

/** p6 — expected sales for a scheduled or live event, from comparable completed days. */
export interface EventForecast {
  /** E = expectedReps × perRepRate. */
  expectedSales: number;
  /** max(0, E − 1.64√E), 1 decimal place. */
  low: number;
  /** E + 1.64√E, 1 decimal place. */
  high: number;
  /** Mean distinct reps over the team's recent completed events. */
  expectedReps: number;
  /** Sales per rep-day in the chosen bucket. */
  perRepRate: number;
  /** ceil(targetSales ÷ perRepRate); null when there is no rate to divide by. */
  repsNeeded: number | null;
  /** Rep-days (or event days) behind the rate. */
  basisDays: number;
  /** Which comparison bucket supplied the rate: same team + campaign + type, company-wide, or the campaign alone. */
  basis: 'team' | 'company' | 'campaign';
  /** 'stretch' (scheduled: target > 1.3E) or 'at_risk' (live: projected < 0.7 × target); events may be "behind target". */
  flag: 'stretch' | 'at_risk' | null;
  /** A data-driven target for a new event; a suggestion only, never applied automatically. */
  suggestedTarget: number | null;
}

/**
 * p6 — "4 / 7 logged". `members`: the team's active members who had started by the event date (the same people the
 * event page lists); `logged`: how many of them have an entry. Admins and other teams' people who logged there are not
 * counted, so logged ≤ members always.
 */
export interface EventRosterCount {
  members: number;
  logged: number;
}

/** p6 — GET /events/forecast. */
export interface EventForecastResponse {
  forecast: EventForecast | null;
}

/** p9 — one line of the weekly digest. Private lines (pay, check-in counts) are never part of `WeekDigest.text`. */
export interface DigestBullet {
  text: string;
  private: boolean;
}

/** p9 — GET /me/digest?week=YYYY-MM-DD: a deterministic "Your week in review" for one completed Mon–Sun week. */
export interface WeekDigest {
  weekStart: string;
  weekEnd: string;
  role: Role;
  title: string;
  bullets: DigestBullet[];
  /** Plain text of the title plus the shareable bullets only (WhatsApp-ready: no markdown, no HTML). */
  text: string;
}

/** GET /me/insights — everything smart about the caller's dashboard in one cached payload. */
export interface SmartInsights {
  /** The business date (YYYY-MM-DD, Europe/London) the insights were computed for. */
  generatedFor: string;
  /** Always the caller's own data. Each part is null when it does not apply (new starter, recruiter, LM_SMART=0). */
  personal: {
    baseline: PersonalBaseline | null;
    direction: TrendDirection | null;
    streaks: Streaks | null;
    payForecast: PayForecast | null;
  };
  /** Streaks ≥ 5 for the board the caller sees: rep / leader own team; admin all active reps and leaders; recruiter []. */
  boardStreaks: BoardStreak[];
  /** Leader with a team only (own team, never the leader themself); null for everyone else. */
  team: { checkIns: CheckInPerson[] } | null;
  /** Admin only (every team, never the admin themself); null for everyone else. */
  company: { checkIns: CheckInPerson[] } | null;
}

/** p10 — GET /api/health adds `backup` for admins only. */
export interface BackupStatus {
  /** ISO timestamp of the last successful backup, null when there has been none. */
  lastAt: string | null;
  /** File name of the last backup, null when there has been none. */
  file: string | null;
  /** Backup files currently kept in `dir`. */
  count: number;
  /** Absolute path of the backup folder. */
  dir: string;
}
