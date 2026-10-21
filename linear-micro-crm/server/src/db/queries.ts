/**
 * Shared SELECT fragments and row mappers. Columns are snake_case in SQLite and aliased to the
 * camelCase names used by `@lm/shared` types here, so route code never touches raw column names.
 */
import {
  isPaidOnTime,
  type Announcement,
  type Campaign,
  type CandidateWithMeta,
  type Expense,
  type GaugeEntryWithMeta,
  type GaugeTotals,
  type Interview,
  type PayPlan,
  type PayrollRunWithUser,
  type SalesEventWithMeta,
  type StageChange,
  type Team,
  type UserWithTeam,
} from '@lm/shared';
import { all, get, type Db, type Param } from './connection.ts';
import { nowISO } from '../lib/dates.ts';
import { CHECK_IN_ON_BEHALF_SQL } from '../lib/shiftCheckIns.ts';

// ── Users ───────────────────────────────────────────────────────────────────

export const USER_SELECT = `
  SELECT u.id, u.employee_id AS employeeId, u.email, u.first_name AS firstName, u.last_name AS lastName,
         u.role, u.position, u.team_id AS teamId, u.pay_plan_id AS payPlanId, u.start_date AS startDate,
         u.status, u.phone, u.avatar_color AS avatarColor, u.city,
         t.name AS teamName, pp.name AS payPlanName
  FROM users u
  LEFT JOIN teams t ON t.id = u.team_id
  JOIN pay_plans pp ON pp.id = u.pay_plan_id`;

export function getUser(db: Db, id: number): UserWithTeam | undefined {
  return get<UserWithTeam>(db, `${USER_SELECT} WHERE u.id = ?`, [id]);
}

export function listTeams(db: Db): Team[] {
  return all<Team>(
    db,
    `SELECT t.id, t.name, t.leader_id AS leaderId, t.color,
            (SELECT COUNT(*) FROM users m WHERE m.team_id = t.id AND m.status = 'active') AS memberCount,
            (SELECT l.first_name || ' ' || l.last_name FROM users l WHERE l.id = t.leader_id) AS leaderName
     FROM teams t ORDER BY t.id`,
  );
}

// ── Campaigns ───────────────────────────────────────────────────────────────

export const CAMPAIGN_SELECT = `
  SELECT c.id, c.name, c.code, c.sector, c.type, c.payout_per_sale AS payoutPerSale,
         c.rep_commission_per_sale AS repCommissionPerSale, c.color, c.active, c.start_date AS startDate, c.description
  FROM campaigns c`;

export function mapCampaign(row: Campaign): Campaign {
  return { ...row, active: Boolean(row.active) };
}

export function getCampaign(db: Db, id: number): Campaign | undefined {
  const row = get<Campaign>(db, `${CAMPAIGN_SELECT} WHERE c.id = ?`, [id]);
  return row ? mapCampaign(row) : undefined;
}

// ── Events ──────────────────────────────────────────────────────────────────

type EventRow = Omit<SalesEventWithMeta, 'totals'> & GaugeTotals;

/**
 * Events with their gauge totals. The totals come from an aggregate subquery over `gauge_entries`; when the caller
 * lists a date window the same window is pushed into that subquery (an entry's date always equals its event's date,
 * see the gauge integrity rules), so a list never scans the whole gauge table. Output is identical either way.
 */
export function eventSelect(windowed = false): string {
  return `
  SELECT e.id, e.campaign_id AS campaignId, e.team_id AS teamId, e.name, e.venue, e.city, e.type, e.date,
         e.start_time AS startTime, e.end_time AS endTime, e.status, e.target_sales AS targetSales, e.notes,
         c.name AS campaignName, c.code AS campaignCode, c.color AS campaignColor,
         t.name AS teamName, t.color AS teamColor,
         COALESCE(g.stops, 0) AS stops, COALESCE(g.table_count, 0) AS "table", COALESCE(g.presentations, 0) AS presentations,
         COALESCE(g.closes, 0) AS closes, COALESCE(g.taps, 0) AS taps, COALESCE(g.sales, 0) AS sales,
         COALESCE(g.repCount, 0) AS repCount
  FROM events e
  JOIN campaigns c ON c.id = e.campaign_id
  JOIN teams t ON t.id = e.team_id
  LEFT JOIN (
    SELECT event_id, SUM(stops) AS stops, SUM(table_count) AS table_count, SUM(presentations) AS presentations,
           SUM(closes) AS closes, SUM(taps) AS taps, SUM(sales) AS sales, COUNT(DISTINCT user_id) AS repCount
    FROM gauge_entries${windowed ? ' WHERE date BETWEEN ? AND ?' : ''} GROUP BY event_id
  ) g ON g.event_id = e.id`;
}

export const EVENT_SELECT = eventSelect(false);

export function mapEvent(row: EventRow): SalesEventWithMeta {
  const { stops, table, presentations, closes, taps, sales, ...rest } = row;
  return { ...rest, totals: { stops, table, presentations, closes, taps, sales } };
}

export function listEvents(
  db: Db,
  where: string,
  params: Param[],
  orderBy = 'e.date ASC, e.start_time ASC',
  window?: { from: string; to: string },
): SalesEventWithMeta[] {
  const sql = `${eventSelect(Boolean(window))} ${where} ORDER BY ${orderBy}`;
  return all<EventRow>(db, sql, window ? [window.from, window.to, ...params] : params).map(mapEvent);
}

export function getEvent(db: Db, id: number): SalesEventWithMeta | undefined {
  const row = get<EventRow>(db, `${EVENT_SELECT} WHERE e.id = ?`, [id]);
  return row ? mapEvent(row) : undefined;
}

// ── Gauges ──────────────────────────────────────────────────────────────────

export const GAUGE_SELECT = `
  SELECT g.id, g.event_id AS eventId, g.user_id AS userId, g.date, g.stops, g.table_count AS "table", g.presentations,
         g.closes, g.taps, g.sales, g.checked_in_at AS checkedInAt, ${CHECK_IN_ON_BEHALF_SQL} AS checkInOnBehalf,
         g.notes, g.submitted_at AS submittedAt,
         u.first_name || ' ' || u.last_name AS userName, u.position AS userPosition, u.avatar_color AS userAvatarColor,
         u.team_id AS teamId, t.name AS teamName,
         e.name AS eventName, e.start_time AS eventStartTime, e.date AS eventDate, e.campaign_id AS campaignId,
         c.name AS campaignName, c.color AS campaignColor
  FROM gauge_entries g
  JOIN users u ON u.id = g.user_id
  LEFT JOIN teams t ON t.id = u.team_id
  JOIN events e ON e.id = g.event_id
  JOIN campaigns c ON c.id = e.campaign_id`;

/** A GAUGE_SELECT row as the API answers it: SQLite's 0/1 for checkInOnBehalf as a boolean (review 1.2 S3). */
export type GaugeRow = Omit<GaugeEntryWithMeta, 'checkInOnBehalf'> & { checkInOnBehalf: number | boolean | null };

export function mapGauge(row: GaugeRow): GaugeEntryWithMeta {
  return { ...row, checkInOnBehalf: row.checkInOnBehalf === 1 || row.checkInOnBehalf === true };
}

export function listGauges(db: Db, where: string, params: Param[], orderBy = 'g.date DESC, g.submitted_at DESC', limit?: number, offset = 0): GaugeEntryWithMeta[] {
  const lim = limit ? ` LIMIT ${Math.max(1, Math.floor(limit))}` : '';
  const off = offset > 0 ? `${lim || ' LIMIT -1'} OFFSET ${Math.floor(offset)}` : lim;
  return all<GaugeRow>(db, `${GAUGE_SELECT} ${where} ORDER BY ${orderBy}${off}`, params).map(mapGauge);
}

export function getGauge(db: Db, id: number): GaugeEntryWithMeta | undefined {
  const row = get<GaugeRow>(db, `${GAUGE_SELECT} WHERE g.id = ?`, [id]);
  return row ? mapGauge(row) : undefined;
}

// ── Finance ─────────────────────────────────────────────────────────────────

export const PAY_PLAN_SELECT = `
  SELECT id, name, position, base_per_day AS basePerDay, commission_per_sale AS commissionPerSale,
         bonus_threshold AS bonusThreshold, bonus_amount AS bonusAmount, override_per_team_sale AS overridePerTeamSale
  FROM pay_plans`;

export function getPayPlan(db: Db, id: number): PayPlan | undefined {
  return get<PayPlan>(db, `${PAY_PLAN_SELECT} WHERE id = ?`, [id]);
}

export const PAYROLL_SELECT = `
  SELECT p.id, p.user_id AS userId, p.week_start AS weekStart, p.week_end AS weekEnd, p.days_worked AS daysWorked,
         p.sales, p.team_sales AS teamSales, p.base_pay AS basePay, p.commission, p.bonus, p.overrides, p.deductions,
         p.gross, p.due_date AS dueDate, p.paid_date AS paidDate, p.status, p.reference, p.adjusted_at AS adjustedAt,
         u.first_name || ' ' || u.last_name AS userName, u.employee_id AS employeeId, u.position, t.name AS teamName
  FROM payroll_runs p
  JOIN users u ON u.id = p.user_id
  LEFT JOIN teams t ON t.id = u.team_id`;

export function mapPayroll(row: Omit<PayrollRunWithUser, 'onTime'>): PayrollRunWithUser {
  return { ...row, onTime: isPaidOnTime(row.dueDate, row.paidDate) };
}

export function listPayroll(db: Db, where: string, params: Param[], orderBy = 'p.week_start DESC, u.last_name ASC'): PayrollRunWithUser[] {
  return all<Omit<PayrollRunWithUser, 'onTime'>>(db, `${PAYROLL_SELECT} ${where} ORDER BY ${orderBy}`, params).map(mapPayroll);
}

export function getPayroll(db: Db, id: number): PayrollRunWithUser | undefined {
  const row = get<Omit<PayrollRunWithUser, 'onTime'>>(db, `${PAYROLL_SELECT} WHERE p.id = ?`, [id]);
  return row ? mapPayroll(row) : undefined;
}

export const EXPENSE_SELECT = `
  SELECT id, date, category, amount, description, campaign_id AS campaignId, event_id AS eventId FROM expenses`;

export function getExpense(db: Db, id: number): Expense | undefined {
  return get<Expense>(db, `${EXPENSE_SELECT} WHERE id = ?`, [id]);
}

// ── Recruitment ─────────────────────────────────────────────────────────────

type CandidateRow = Omit<CandidateWithMeta, 'daysInPipeline'>;

export const CANDIDATE_SELECT = `
  SELECT c.id, c.first_name AS firstName, c.last_name AS lastName, c.email, c.phone, c.city, c.source, c.stage,
         c.position_applied AS positionApplied, c.applied_at AS appliedAt, c.stage_updated_at AS stageUpdatedAt,
         c.owner_id AS ownerId, c.referred_by_id AS referredById, c.rating, c.notes, c.next_action AS nextAction,
         c.next_action_at AS nextActionAt, c.hired_user_id AS hiredUserId,
         o.first_name || ' ' || o.last_name AS ownerName, r.first_name || ' ' || r.last_name AS referredByName
  FROM candidates c
  LEFT JOIN users o ON o.id = c.owner_id
  LEFT JOIN users r ON r.id = c.referred_by_id`;

const TERMINAL = new Set(['hired', 'rejected', 'withdrawn']);

export function mapCandidate(row: CandidateRow): CandidateWithMeta {
  const until = TERMINAL.has(row.stage) ? row.stageUpdatedAt : nowISO();
  const days = Math.max(0, Math.round((new Date(until).getTime() - new Date(row.appliedAt).getTime()) / 86_400_000));
  return { ...row, daysInPipeline: days };
}

export function listCandidates(db: Db, where: string, params: Param[], orderBy = 'c.stage_updated_at DESC'): CandidateWithMeta[] {
  return all<CandidateRow>(db, `${CANDIDATE_SELECT} ${where} ORDER BY ${orderBy}`, params).map(mapCandidate);
}

export function getCandidate(db: Db, id: number): CandidateWithMeta | undefined {
  const row = get<CandidateRow>(db, `${CANDIDATE_SELECT} WHERE c.id = ?`, [id]);
  return row ? mapCandidate(row) : undefined;
}

export const STAGE_CHANGE_SELECT = `
  SELECT s.id, s.candidate_id AS candidateId, s.from_stage AS fromStage, s.to_stage AS toStage, s.changed_at AS changedAt,
         s.changed_by_id AS changedById, u.first_name || ' ' || u.last_name AS changedByName, s.note
  FROM stage_changes s LEFT JOIN users u ON u.id = s.changed_by_id`;

export function listStageChanges(db: Db, candidateId: number): StageChange[] {
  return all<StageChange>(db, `${STAGE_CHANGE_SELECT} WHERE s.candidate_id = ? ORDER BY s.changed_at ASC, s.id ASC`, [candidateId]);
}

export const INTERVIEW_SELECT = `
  SELECT i.id, i.candidate_id AS candidateId, i.type, i.scheduled_at AS scheduledAt, i.interviewer_id AS interviewerId,
         u.first_name || ' ' || u.last_name AS interviewerName, i.outcome, i.notes
  FROM interviews i LEFT JOIN users u ON u.id = i.interviewer_id`;

export function listInterviews(db: Db, where: string, params: Param[]): Interview[] {
  return all<Interview>(db, `${INTERVIEW_SELECT} ${where} ORDER BY i.scheduled_at ASC`, params);
}

export function getInterview(db: Db, id: number): Interview | undefined {
  return get<Interview>(db, `${INTERVIEW_SELECT} WHERE i.id = ?`, [id]);
}

// ── Announcements ───────────────────────────────────────────────────────────

export const ANNOUNCEMENT_SELECT = `
  SELECT a.id, a.title, a.body, a.author_id AS authorId, u.first_name || ' ' || u.last_name AS authorName,
         a.created_at AS createdAt, a.pinned
  FROM announcements a JOIN users u ON u.id = a.author_id`;

export function mapAnnouncement(row: Announcement): Announcement {
  return { ...row, pinned: Boolean(row.pinned) };
}

/**
 * Announcements pinned first, newest first (the id breaks a tie, so pages never overlap). `limit` omitted: all of
 * them; `offset` skips that many (the dashboard shows the first five, "Older announcements" pages on from there).
 */
export function listAnnouncements(db: Db, limit?: number, offset = 0): Announcement[] {
  const order = `${ANNOUNCEMENT_SELECT} ORDER BY a.pinned DESC, a.created_at DESC, a.id DESC`;
  const rows = limit ? all<Announcement>(db, `${order} LIMIT ? OFFSET ?`, [limit, offset]) : all<Announcement>(db, `${order} LIMIT -1 OFFSET ?`, [offset]);
  return rows.map(mapAnnouncement);
}

/** How many announcements `listAnnouncements` can list. */
export function countAnnouncements(db: Db): number {
  return Number(get<{ n: number }>(db, `SELECT COUNT(*) AS n FROM announcements a JOIN users u ON u.id = a.author_id`)!.n);
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Small builder for `WHERE a AND b …` clauses with positional params. */
export class Where {
  private clauses: string[] = [];
  readonly params: Param[] = [];

  add(clause: string, ...params: Param[]): this {
    this.clauses.push(clause);
    this.params.push(...params);
    return this;
  }

  /** Adds the clause only when `value` is defined. */
  opt(clause: string, value: Param | undefined): this {
    if (value !== undefined && value !== null && value !== '') this.add(clause, value);
    return this;
  }

  toString(): string {
    return this.clauses.length ? `WHERE ${this.clauses.join(' AND ')}` : '';
  }
}
