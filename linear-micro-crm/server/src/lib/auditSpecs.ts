/**
 * Release 1.2 — OWNED BY U3 audit-trail: the audit trail's route registry.
 *
 * One entry per write route whose changes the trail explains: the entity it changes, a small snapshot loader (one
 * query, readable names next to the ids) and the wording of its summary. lib/audit.ts runs `before` ahead of the
 * handler and `after` once it has answered 2xx. Gauge writes also record every pay run they move (recalculated,
 * created, removed, or flagged "adjusted after payment"), so a payslip's history explains its figures.
 *
 * Tables owned by other 1.2 packages (campaign_pitches L2, learning_progress L1, check_ins U4, users.pin_hash U1) are
 * read defensively: when a table or column is not there yet the snapshot is simply empty. Snapshots never include
 * PINs, secrets, codes or tokens (and lib/audit.ts redacts again before storing).
 *
 * A write that changed nothing writes no row (`after` answers []): a check-in replay answered "already recorded", a
 * teach-back saved with the same text, a pitch saved unchanged, sign-in settings saved with the same values, a
 * self-check retake that changes no stored field, and a repeated sign-off that keeps the first signer. So nobody can
 * fill the trail with rows that say nothing.
 */
import {
  AUDIT_DIFF_SKIPPED,
  EXPENSE_CATEGORY_LABELS,
  POSITION_LABELS,
  ROLE_LABELS,
  SESSION_IDLE_HOURS_DEFAULT,
  STAGE_LABELS,
  auditChangeText,
  auditDayLabel,
  auditDiff,
  auditHumanise,
  auditMoney,
  auditValueText,
  auditWeekLabel,
  type AuditEntity,
  type AuditFieldChange,
  type CandidateStage,
  type ExpenseCategory,
  type Position,
  type Role,
  type UserWithTeam,
} from '@lm/shared';
import { all, get, placeholders, type Db } from '../db/connection.ts';
import { mondayOf } from './dates.ts';
import { readSecuritySettings } from './pin.ts';

type Snap = Record<string, unknown>;

/** The request as the registry sees it (paths relative to /api). */
export interface AuditCall {
  method: string;
  path: string;
  /** From the registry's own pattern match (`:id` → "12"). */
  params: Record<string, string>;
  body: unknown;
  me: UserWithTeam | null;
}

export interface AuditDone extends AuditCall {
  status: number;
  /** The JSON the handler answered with (undefined for 204). */
  response: unknown;
}

/** One row to write; lib/audit.ts adds when, the action, the IP and (unless `userId` is set) the signed-in user. */
export interface AuditDraft {
  entity: AuditEntity | null;
  entityId: number | null;
  summary: string;
  before?: unknown;
  after?: unknown;
  /** Overrides the actor (a sign-in: the person who has just signed in). */
  userId?: number | null;
}

export interface AuditRouteSpec<S = unknown> {
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Express-style, relative to /api: "/finance/payroll/:id/pay". */
  pattern: string;
  /** Not recorded at all. */
  skip?: boolean;
  /** Before the handler: load what is about to change. */
  before?(db: Db, call: AuditCall): S;
  /** After a 2xx answer: the rows to write ([] writes nothing). */
  after(db: Db, done: AuditDone, state: S | undefined): AuditDraft[];
}

// ───────────────────────────── small helpers ─────────────────────────────

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const toId = (v: unknown): number | null => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : null;
};
const bodyOf = (call: AuditCall): Record<string, unknown> => (isRecord(call.body) ? call.body : {});
const responseOf = (done: AuditDone): Record<string, unknown> => (isRecord(done.response) ? done.response : {});
const paramId = (call: AuditCall, name = 'id') => toId(call.params[name]);
const str = (v: unknown, fallback = ''): string => (typeof v === 'string' && v ? v : fallback);
const numOr0 = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const isoDay = (v: unknown): string | null => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
const plural = (n: number, noun: string) => `${n} ${n === 1 ? noun : `${noun}s`}`;
const bool = (v: unknown) => v === 1 || v === true;

/** Runs a read that depends on another package's table; any SQL error (table or column not there yet) → fallback. */
function soft<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function hasColumn(db: Db, table: string, column: string): boolean {
  return soft(() => (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === column), false);
}

function withBooleans<T extends Snap>(row: T | undefined, keys: readonly string[]): T | null {
  if (!row) return null;
  const out: Snap = { ...row };
  for (const k of keys) if (k in out) out[k] = bool(out[k]);
  return out as T;
}

/** "sales 3 → 4, stops 60 → 65" without the fields the sentence already names. */
function changes(diff: AuditFieldChange[], skip: readonly string[] = [], max = 3): string {
  return auditChangeText(diff, { skip: [...skip, ...AUDIT_DIFF_SKIPPED], max });
}

const withChanges = (head: string, diff: AuditFieldChange[], skip: readonly string[] = []) => {
  const text = changes(diff, skip);
  return text ? `${head}: ${text}` : `${head} (no changes)`;
};

// ───────────────────────────── snapshot loaders ─────────────────────────────

const GAUGE_SNAP = `
  SELECT g.id, g.user_id AS userId, u.first_name || ' ' || u.last_name AS userName, g.event_id AS eventId, e.name AS eventName,
         g.date, g.stops, g.table_count AS "table", g.presentations, g.closes, g.taps, g.sales, g.checked_in_at AS checkedInAt, g.notes
  FROM gauge_entries g JOIN users u ON u.id = g.user_id JOIN events e ON e.id = g.event_id`;

export function gaugeSnapshot(db: Db, id: number): Snap | null {
  return get<Snap>(db, `${GAUGE_SNAP} WHERE g.id = ?`, [id]) ?? null;
}

const PAYROLL_SNAP = `
  SELECT p.id, p.user_id AS userId, u.first_name || ' ' || u.last_name AS userName, p.week_start AS weekStart,
         p.week_end AS weekEnd, p.status, p.due_date AS dueDate, p.paid_date AS paidDate, p.days_worked AS daysWorked,
         p.sales, p.team_sales AS teamSales, p.base_pay AS basePay, p.commission, p.bonus, p.overrides, p.deductions,
         p.gross, p.reference, p.adjusted_at AS adjustedAt
  FROM payroll_runs p JOIN users u ON u.id = p.user_id`;

export function payrollSnapshot(db: Db, id: number): Snap | null {
  return get<Snap>(db, `${PAYROLL_SNAP} WHERE p.id = ?`, [id]) ?? null;
}

export function userSnapshot(db: Db, id: number): Snap | null {
  // users.pin_hash belongs to U1's extension: read it only when the column exists.
  const pin = hasColumn(db, 'users', 'pin_hash') ? ', (u.pin_hash IS NOT NULL) AS pinSet' : '';
  const row = get<Snap>(
    db,
    `SELECT u.id, u.first_name || ' ' || u.last_name AS name, u.email, u.employee_id AS employeeId, u.role, u.position,
            u.team_id AS teamId, t.name AS teamName, u.pay_plan_id AS payPlanId, pp.name AS payPlanName, u.start_date AS startDate,
            u.status, u.phone, u.city, (u.totp_enabled_at IS NOT NULL) AS twoFactor${pin}
     FROM users u LEFT JOIN teams t ON t.id = u.team_id LEFT JOIN pay_plans pp ON pp.id = u.pay_plan_id WHERE u.id = ?`,
    [id],
  );
  return withBooleans(row, ['twoFactor', 'pinSet']);
}

function candidateSnapshot(db: Db, id: number): Snap | null {
  return (
    get<Snap>(
      db,
      `SELECT c.id, c.first_name || ' ' || c.last_name AS name, c.email, c.phone, c.city, c.source, c.stage,
              c.position_applied AS positionApplied, c.owner_id AS ownerId, o.first_name || ' ' || o.last_name AS ownerName,
              c.referred_by_id AS referredById, r.first_name || ' ' || r.last_name AS referredByName, c.rating, c.notes,
              c.next_action AS nextAction, c.next_action_at AS nextActionAt, c.hired_user_id AS hiredUserId,
              h.first_name || ' ' || h.last_name AS hiredUserName
       FROM candidates c LEFT JOIN users o ON o.id = c.owner_id LEFT JOIN users r ON r.id = c.referred_by_id
       LEFT JOIN users h ON h.id = c.hired_user_id WHERE c.id = ?`,
      [id],
    ) ?? null
  );
}

function interviewSnapshot(db: Db, id: number): Snap | null {
  return (
    get<Snap>(
      db,
      `SELECT i.id, i.candidate_id AS candidateId, c.first_name || ' ' || c.last_name AS candidateName, i.type,
              i.scheduled_at AS scheduledAt, i.interviewer_id AS interviewerId, u.first_name || ' ' || u.last_name AS interviewerName,
              i.outcome, i.notes
       FROM interviews i JOIN candidates c ON c.id = i.candidate_id LEFT JOIN users u ON u.id = i.interviewer_id WHERE i.id = ?`,
      [id],
    ) ?? null
  );
}

function eventSnapshot(db: Db, id: number): Snap | null {
  return (
    get<Snap>(
      db,
      `SELECT e.id, e.name, e.venue, e.city, e.type, e.date, e.start_time AS startTime, e.end_time AS endTime, e.status,
              e.target_sales AS targetSales, e.notes, e.team_id AS teamId, t.name AS teamName, e.campaign_id AS campaignId,
              c.name AS campaignName
       FROM events e LEFT JOIN teams t ON t.id = e.team_id LEFT JOIN campaigns c ON c.id = e.campaign_id WHERE e.id = ?`,
      [id],
    ) ?? null
  );
}

function campaignSnapshot(db: Db, id: number): Snap | null {
  // the campaign code is stored as `campaignCode` (a bare `code` key is redacted: it is the two-step code elsewhere)
  const row = get<Snap>(
    db,
    `SELECT id, name, code AS campaignCode, sector, type, payout_per_sale AS payoutPerSale,
            rep_commission_per_sale AS repCommissionPerSale, color, active, start_date AS startDate, description
     FROM campaigns WHERE id = ?`,
    [id],
  );
  return withBooleans(row, ['active']);
}

function expenseSnapshot(db: Db, id: number): Snap | null {
  return (
    get<Snap>(
      db,
      `SELECT x.id, x.date, x.category, x.amount, x.description, x.campaign_id AS campaignId, c.name AS campaignName,
              x.event_id AS eventId, e.name AS eventName
       FROM expenses x LEFT JOIN campaigns c ON c.id = x.campaign_id LEFT JOIN events e ON e.id = x.event_id WHERE x.id = ?`,
      [id],
    ) ?? null
  );
}

function announcementSnapshot(db: Db, id: number): Snap | null {
  const row = get<Snap>(
    db,
    `SELECT a.id, a.title, a.body, a.pinned, a.author_id AS authorId, u.first_name || ' ' || u.last_name AS authorName
     FROM announcements a LEFT JOIN users u ON u.id = a.author_id WHERE a.id = ?`,
    [id],
  );
  return withBooleans(row, ['pinned']);
}

/** L2's campaign_pitches (one pitch per campaign); null when there is none or the table is not there yet. */
function pitchSnapshot(db: Db, campaignId: number): Snap | null {
  return soft(
    () =>
      get<Snap>(
        db,
        `SELECT p.campaign_id AS campaignId, c.code AS campaignCode, p.title, p.body, p.facts
         FROM campaign_pitches p JOIN campaigns c ON c.id = p.campaign_id WHERE p.campaign_id = ?`,
        [campaignId],
      ) ?? null,
    null,
  );
}

/** L1's learning_progress for one person and lesson; null when there is no row or the table is not there yet. */
function learningSnapshot(db: Db, userId: number, lessonKey: string): Snap | null {
  return soft(
    () =>
      get<Snap>(
        db,
        `SELECT lp.lesson_key AS lessonKey, lp.learned_at AS learnedAt, lp.quiz_score AS quizScore, lp.teachback_at AS teachbackAt,
                s.first_name || ' ' || s.last_name AS signedOffByName, lp.taught_signed_off_at AS signedOffAt
         FROM learning_progress lp LEFT JOIN users s ON s.id = lp.taught_signed_off_by WHERE lp.user_id = ? AND lp.lesson_key = ?`,
        [userId, lessonKey],
      ) ?? null,
    null,
  );
}

/** The stored teach-back text (compared to tell a save of the same words; never put in a snapshot). */
function teachbackText(db: Db, userId: number, lessonKey: string): string | null {
  return soft(
    () => get<{ t: string | null }>(db, `SELECT teachback_text AS t FROM learning_progress WHERE user_id = ? AND lesson_key = ?`, [userId, lessonKey])?.t ?? null,
    null,
  );
}

interface TeachbackState {
  snap: Snap | null;
  text: string | null;
}

const CHECK_IN_SNAP = `
  SELECT ci.id, ci.user_id AS userId, u.first_name || ' ' || u.last_name AS userName, ci.event_id AS eventId, e.name AS eventName,
         ci.date, ci.checked_in_at AS checkedInAt, ci.source
  FROM check_ins ci JOIN users u ON u.id = ci.user_id JOIN events e ON e.id = ci.event_id`;

/** U4's check_ins; null when there is no row or the table is not there yet. */
function checkInSnapshot(db: Db, id: number): Snap | null {
  return soft(() => get<Snap>(db, `${CHECK_IN_SNAP} WHERE ci.id = ?`, [id]) ?? null, null);
}

function userName(db: Db, id: number | null): string | null {
  if (!id) return null;
  return get<{ n: string }>(db, `SELECT first_name || ' ' || last_name AS n FROM users WHERE id = ?`, [id])?.n ?? null;
}

// ───────────────────────────── a generic entity route ─────────────────────────────

interface Change<T extends Snap = Snap> {
  id: number | null;
  before: T | null;
  after: T | null;
  diff: AuditFieldChange[];
  done: AuditDone;
}

interface EntityRouteOptions {
  entity: AuditEntity;
  load(db: Db, id: number): Snap | null;
  /** The id before the handler (default: the `:id` param). */
  idBefore?(db: Db, call: AuditCall): number | null;
  /** The id afterwards (default: the id before, else the `id` of the JSON answer). */
  idAfter?(db: Db, done: AuditDone, idBefore: number | null): number | null;
  /** The entity id to store when it is not the loaded record's id (an interview is filed under its candidate). */
  entityIdOf?(c: Change): number | null;
  summary(c: Change, db: Db): string;
  /** More rows (e.g. a hire also adds a person). */
  extra?(db: Db, c: Change): AuditDraft[];
  /** Write nothing when the record existed before and no snapshot field changed (a save of the same values). */
  skipUnchanged?: boolean;
}

function entityRoute(method: AuditRouteSpec['method'], pattern: string, o: EntityRouteOptions): AuditRouteSpec<{ id: number | null; before: Snap | null }> {
  return {
    method,
    pattern,
    before(db, call) {
      const id = o.idBefore ? o.idBefore(db, call) : paramId(call);
      return { id, before: id ? o.load(db, id) : null };
    },
    after(db, done, state) {
      const idBefore = state?.id ?? null;
      const id = o.idAfter ? o.idAfter(db, done, idBefore) : (idBefore ?? toId(responseOf(done).id));
      const before = state?.before ?? null;
      const after = method === 'DELETE' || !id ? null : o.load(db, id);
      const c: Change = { id, before, after, diff: auditDiff(before, after), done };
      if (o.skipUnchanged && before && after && !c.diff.length) return [];
      const entityId = o.entityIdOf ? o.entityIdOf(c) : id;
      return [{ entity: o.entity, entityId, summary: o.summary(c, db), before, after }, ...(o.extra?.(db, c) ?? [])];
    },
  };
}

/** A route that is about the caller themself (two-step, sign-out): one row, entity user. */
function selfRoute(method: AuditRouteSpec['method'], pattern: string, summary: string, withSnapshot = false): AuditRouteSpec<Snap | null> {
  return {
    method,
    pattern,
    before: (db, call) => (withSnapshot && call.me ? userSnapshot(db, call.me.id) : null),
    after(db, done, before) {
      if (!done.me) return [];
      const after = withSnapshot ? userSnapshot(db, done.me.id) : null;
      return [{ entity: 'user', entityId: done.me.id, summary, before: before ?? null, after }];
    },
  };
}

// ───────────────────────────── gauges and the pay runs they move ─────────────────────────────

interface GaugeKey {
  userId: number;
  eventId: number;
  date: string;
}

interface PayWatch {
  userIds: number[];
  weeks: string[];
  runs: Map<string, Snap>;
}

const runKey = (userId: unknown, weekStart: unknown) => `${String(userId)}|${String(weekStart)}`;

function loadRuns(db: Db, userIds: number[], weeks: string[]): Map<string, Snap> {
  const out = new Map<string, Snap>();
  if (!userIds.length || !weeks.length) return out;
  const rows = all<Snap>(db, `${PAYROLL_SNAP} WHERE p.user_id IN (${placeholders(userIds.length)}) AND p.week_start IN (${placeholders(weeks.length)})`, [
    ...userIds,
    ...weeks,
  ]);
  for (const r of rows) out.set(runKey(r.userId, r.weekStart), r);
  return out;
}

/**
 * Everyone whose pay run a change to these entries can move (the same rule as db/maintenance.ts affectedPayUsers, for
 * several entries in one query): the people themselves, override earners on their teams, and no-team seniors who
 * logged at the same events. Then their runs for the weeks concerned.
 */
function watchPay(db: Db, keys: GaugeKey[]): PayWatch {
  const userIds = [...new Set(keys.map((k) => k.userId))];
  const eventIds = [...new Set(keys.map((k) => k.eventId))];
  const weeks = [...new Set(keys.map((k) => mondayOf(k.date)))];
  if (!userIds.length) return { userIds: [], weeks: [], runs: new Map() };
  const affected = all<{ id: number }>(
    db,
    `SELECT u.id FROM users u JOIN pay_plans pp ON pp.id = u.pay_plan_id
     WHERE u.id IN (${placeholders(userIds.length)})
        OR (pp.override_per_team_sale > 0 AND u.team_id IS NOT NULL AND u.team_id IN (SELECT team_id FROM users WHERE id IN (${placeholders(userIds.length)})))
        OR (pp.override_per_team_sale > 0 AND u.team_id IS NULL AND EXISTS (SELECT 1 FROM gauge_entries g WHERE g.user_id = u.id AND g.event_id IN (${placeholders(eventIds.length)})))
     ORDER BY u.id`,
    [...userIds, ...userIds, ...eventIds],
  ).map((r) => r.id);
  return { userIds: affected, weeks, runs: loadRuns(db, affected, weeks) };
}

/** One row per pay run the change moved: recalculated, created, removed or flagged "adjusted after payment". */
function payRunDrafts(db: Db, watch: PayWatch | undefined): AuditDraft[] {
  if (!watch || !watch.userIds.length) return [];
  const now = loadRuns(db, watch.userIds, watch.weeks);
  const drafts: AuditDraft[] = [];
  for (const userId of watch.userIds) {
    for (const week of watch.weeks) {
      const key = runKey(userId, week);
      const before = watch.runs.get(key) ?? null;
      const after = now.get(key) ?? null;
      const diff = auditDiff(before, after);
      if (!diff.length) continue;
      const run = (after ?? before)!;
      const who = `${str(run.userName, 'Someone')} ${auditWeekLabel(String(run.weekStart))}`;
      let summary: string;
      if (!before) summary = `Pay run created after a gauge change: ${who}, ${auditMoney(numOr0(run.gross))}`;
      else if (!after) summary = `Pay run removed after a gauge change: ${who} (was ${auditMoney(numOr0(before.gross))})`;
      else if (diff.some((d) => d.field === 'adjustedAt') && (after.status === 'paid' || after.status === 'late')) {
        summary = `Adjusted after payment: ${who}, paid ${auditMoney(numOr0(after.gross))}; the gauges changed`;
      } else if (diff.some((d) => d.field === 'gross')) {
        summary = `Recalculated after a gauge change: ${who}, ${auditMoney(numOr0(before.gross))} → ${auditMoney(numOr0(after.gross))}`;
      } else summary = withChanges(`Recalculated after a gauge change: ${who}`, diff, ['userName', 'weekStart', 'weekEnd']);
      drafts.push({ entity: 'payroll_run', entityId: toId(run.id), summary, before, after });
    }
  }
  return drafts;
}

const gaugePlace = (s: Snap) => `${str(s.userName, 'Someone')}, ${auditDayLabel(String(s.date))} at ${str(s.eventName, 'an event')}`;

/** "Logged gauges: …" / "Edited gauges: …: sales 2 → 3" / "Deleted gauges: …"; routes/audit.ts rebuilds it for a leader's redacted view. */
export function gaugeSummary(before: Snap | null, after: Snap | null, diff: AuditFieldChange[], bulk = false): string {
  const how = bulk ? ' in bulk' : '';
  if (after && !before) return `Logged gauges${how}: ${gaugePlace(after)}, ${plural(numOr0(after.sales), 'sale')}`;
  if (before && !after) return `Deleted gauges: ${gaugePlace(before)} (${plural(numOr0(before.sales), 'sale')})`;
  if (before && after) return withChanges(`Edited gauges${how}: ${gaugePlace(before)}`, diff);
  return `Gauges saved${how}`;
}

function keyFrom(body: Record<string, unknown>, fallback?: Snap | null): GaugeKey | null {
  const userId = toId(body.userId) ?? toId(fallback?.userId);
  const eventId = toId(body.eventId) ?? toId(fallback?.eventId);
  const date = isoDay(body.date) ?? isoDay(fallback?.date);
  return userId && eventId && date ? { userId, eventId, date } : null;
}

const keyOf = (s: Snap | null): GaugeKey | null => (s ? keyFrom({}, s) : null);

function gaugeIdByKey(db: Db, k: GaugeKey | null): number | null {
  if (!k) return null;
  return get<{ id: number }>(db, `SELECT id FROM gauge_entries WHERE event_id = ? AND user_id = ? AND date = ?`, [k.eventId, k.userId, k.date])?.id ?? null;
}

interface GaugeState {
  id: number | null;
  before: Snap | null;
  pay: PayWatch;
}

const gaugeUpsert: AuditRouteSpec<GaugeState> = {
  method: 'POST',
  pattern: '/gauges',
  before(db, call) {
    const key = keyFrom(bodyOf(call));
    const id = gaugeIdByKey(db, key);
    return { id, before: id ? gaugeSnapshot(db, id) : null, pay: watchPay(db, key ? [key] : []) };
  },
  after(db, done, state) {
    const id = toId(responseOf(done).id) ?? state?.id ?? null;
    const before = state?.before ?? null;
    const after = id ? gaugeSnapshot(db, id) : null;
    const diff = auditDiff(before, after);
    return [{ entity: 'gauge_entry', entityId: id, summary: gaugeSummary(before, after, diff), before, after }, ...payRunDrafts(db, state?.pay)];
  },
};

const gaugePatch: AuditRouteSpec<GaugeState> = {
  method: 'PATCH',
  pattern: '/gauges/:id',
  before(db, call) {
    const id = paramId(call);
    const before = id ? gaugeSnapshot(db, id) : null;
    const keys = [keyOf(before), keyFrom(bodyOf(call), before)].filter((k): k is GaugeKey => k !== null);
    return { id, before, pay: watchPay(db, keys) };
  },
  after(db, done, state) {
    const id = state?.id ?? null;
    const before = state?.before ?? null;
    const after = id ? gaugeSnapshot(db, id) : null;
    const diff = auditDiff(before, after);
    return [{ entity: 'gauge_entry', entityId: id, summary: gaugeSummary(before, after, diff), before, after }, ...payRunDrafts(db, state?.pay)];
  },
};

const gaugeDelete: AuditRouteSpec<GaugeState> = {
  method: 'DELETE',
  pattern: '/gauges/:id',
  before(db, call) {
    const id = paramId(call);
    const before = id ? gaugeSnapshot(db, id) : null;
    const key = keyOf(before);
    return { id, before, pay: watchPay(db, key ? [key] : []) };
  },
  after(db, _done, state) {
    const before = state?.before ?? null;
    return [{ entity: 'gauge_entry', entityId: state?.id ?? null, summary: gaugeSummary(before, null, auditDiff(before, null)), before, after: null }, ...payRunDrafts(db, state?.pay)];
  },
};

/** POST /gauges/bulk (U2): one row per entry it created or changed, plus the pay runs it moved. */
interface BulkState {
  eventId: number | null;
  date: string | null;
  userIds: number[];
  before: Map<number, Snap>;
  pay: PayWatch;
}

function bulkEntries(db: Db, eventId: number | null, date: string | null, userIds: number[]): Map<number, Snap> {
  const out = new Map<number, Snap>();
  if (!eventId || !date || !userIds.length) return out;
  const rows = all<Snap>(db, `${GAUGE_SNAP} WHERE g.event_id = ? AND g.date = ? AND g.user_id IN (${placeholders(userIds.length)})`, [eventId, date, ...userIds]);
  for (const r of rows) out.set(Number(r.userId), r);
  return out;
}

const gaugeBulk: AuditRouteSpec<BulkState> = {
  method: 'POST',
  pattern: '/gauges/bulk',
  before(db, call) {
    const body = bodyOf(call);
    const eventId = toId(body.eventId);
    const date = isoDay(body.date);
    const rows = Array.isArray(body.rows) ? body.rows : [];
    const userIds = [...new Set(rows.map((r) => (isRecord(r) ? toId(r.userId) : null)).filter((n): n is number => n !== null))].slice(0, 200);
    const keys = eventId && date ? userIds.map((userId) => ({ userId, eventId, date })) : [];
    return { eventId, date, userIds, before: bulkEntries(db, eventId, date, userIds), pay: watchPay(db, keys) };
  },
  after(db, _done, state) {
    if (!state) return [];
    const now = bulkEntries(db, state.eventId, state.date, state.userIds);
    const drafts: AuditDraft[] = [];
    for (const userId of state.userIds) {
      const before = state.before.get(userId) ?? null;
      const after = now.get(userId) ?? null;
      const diff = auditDiff(before, after);
      if (!after || (before && !diff.length)) continue;
      drafts.push({ entity: 'gauge_entry', entityId: toId(after.id), summary: gaugeSummary(before, after, diff, true), before, after });
    }
    return [...drafts, ...payRunDrafts(db, state.pay)];
  },
};

// ───────────────────────────── people, recruitment, events, money ─────────────────────────────

const roleLabel = (v: unknown) => ROLE_LABELS[v as Role] ?? auditHumanise(String(v ?? ''));
const positionLabel = (v: unknown) => POSITION_LABELS[v as Position] ?? auditHumanise(String(v ?? ''));
const stageLabel = (v: unknown) => STAGE_LABELS[v as CandidateStage] ?? auditHumanise(String(v ?? ''));
const categoryLabel = (v: unknown) => (EXPENSE_CATEGORY_LABELS[v as ExpenseCategory] ?? auditHumanise(String(v ?? ''))).toLowerCase();

function personAdded(s: Snap | null, how = ''): string {
  if (!s) return `Added a person${how}`;
  const team = str(s.teamName);
  return `Added ${str(s.name, 'a person')}${how}: ${roleLabel(s.role)}, ${positionLabel(s.position)}${team ? `, ${team}` : ''}`;
}

function personUpdated({ before, after, diff }: Change): string {
  const name = str(after?.name ?? before?.name, 'a person');
  const status = diff.find((d) => d.field === 'status');
  if (status?.after === 'left') return `Deactivated ${name}`;
  if (status && status.before === 'left') return withChanges(`Reactivated ${name}`, diff, ['status']);
  return withChanges(`Updated ${name}`, diff);
}

const eventPlace = (s: Snap | null) => (s ? `${str(s.name, 'an event')}, ${auditDayLabel(String(s.date))}` : 'an event');
const campaignName = (s: Snap | null) => (s ? `${str(s.name, 'a campaign')} (${str(s.campaignCode)})` : 'a campaign');
const expenseText = (s: Snap | null) => (s ? `${auditMoney(numOr0(s.amount))} ${categoryLabel(s.category)}, ${auditDayLabel(String(s.date))}` : 'an expense');

/** The settings snapshot U1's PUT /auth/security-settings answers with (known keys only, in a fixed order). */
const SETTINGS_DEFAULTS: Snap = { requirePin: false, requireAdminTwoFactor: false, sessionIdleHours: SESSION_IDLE_HOURS_DEFAULT };

function settingsFrom(v: unknown): Snap | null {
  if (!isRecord(v)) return null;
  const out: Snap = {};
  for (const k of Object.keys(SETTINGS_DEFAULTS)) if (k in v) out[k] = v[k];
  for (const [k, x] of Object.entries(v)) if (!(k in out) && (typeof x === 'boolean' || typeof x === 'number' || typeof x === 'string')) out[k] = x;
  return Object.keys(out).length ? out : null;
}

/** What the last recorded settings change left, else the documented defaults (when the stored settings cannot be read). */
function lastSettings(db: Db): Snap {
  const row = get<{ a: string | null }>(db, `SELECT after_json AS a FROM audit_log WHERE entity = 'settings' AND after_json IS NOT NULL ORDER BY at DESC, id DESC LIMIT 1`);
  const parsed = soft(() => (row?.a ? (JSON.parse(row.a) as unknown) : null), null);
  return settingsFrom(parsed) ?? { ...SETTINGS_DEFAULTS };
}

function lessonLabel(key: unknown): string {
  return auditHumanise(String(key ?? 'a lesson'));
}

// ───────────────────────────── the registry ─────────────────────────────

const signIn = (pattern: string, summary: string): AuditRouteSpec<null> => ({
  method: 'POST',
  pattern,
  after(_db, done) {
    // step one of a two-step sign-in answers a challenge, not a session: nobody is signed in yet
    const user = responseOf(done).user;
    const id = isRecord(user) ? toId(user.id) : null;
    return id ? [{ entity: 'user', entityId: id, summary, userId: id }] : [];
  },
});

export const AUDIT_ROUTES: readonly AuditRouteSpec<any>[] = [ // eslint-disable-line @typescript-eslint/no-explicit-any
  // ── read receipts have their own table (announcement_reads) ──
  { method: 'POST', pattern: '/announcements/:id/read', skip: true, after: () => [] },

  // ── pay ──
  entityRoute('POST', '/finance/payroll/:id/pay', {
    entity: 'payroll_run',
    load: payrollSnapshot,
    summary: ({ after, before }) => {
      const s = after ?? before;
      if (!s) return 'Marked a pay run paid';
      return `${s.status === 'late' ? 'Marked paid (late)' : 'Marked paid'}: ${str(s.userName, 'Someone')} ${auditWeekLabel(String(s.weekStart))}, ${auditMoney(numOr0(s.gross))}`;
    },
  }),
  entityRoute('POST', '/finance/expenses', { entity: 'expense', load: expenseSnapshot, summary: ({ after }) => `Added expense: ${expenseText(after)}` }),
  entityRoute('DELETE', '/finance/expenses/:id', { entity: 'expense', load: expenseSnapshot, summary: ({ before }) => `Deleted expense: ${expenseText(before)}` }),

  // ── gauges ──
  gaugeBulk,
  gaugeUpsert,
  gaugePatch,
  gaugeDelete,

  // ── people ──
  entityRoute('POST', '/users', { entity: 'user', load: userSnapshot, summary: ({ after }) => personAdded(after) }),
  entityRoute('PATCH', '/users/:id', { entity: 'user', load: userSnapshot, summary: (c) => personUpdated(c) }),
  entityRoute('POST', '/users/:id/2fa/reset', {
    entity: 'user',
    load: userSnapshot,
    summary: ({ before, after }) => `Reset two-step verification: ${str(after?.name ?? before?.name, 'a person')}`,
  }),
  entityRoute('POST', '/auth/pin/reset/:userId', {
    entity: 'user',
    load: userSnapshot,
    idBefore: (_db, call) => paramId(call, 'userId'),
    summary: ({ before, after }) => `Reset PIN: ${str(after?.name ?? before?.name, 'a person')}`,
  }),

  // ── signing in and the caller's own security ──
  signIn('/auth/login', 'Signed in'),
  signIn('/auth/login/2fa', 'Signed in with two-step verification'),
  selfRoute('POST', '/auth/logout', 'Signed out'),
  selfRoute('POST', '/auth/2fa/setup', 'Started setting up two-step verification'),
  selfRoute('POST', '/auth/2fa/enable', 'Turned on two-step verification', true),
  selfRoute('POST', '/auth/2fa/disable', 'Turned off two-step verification', true),
  selfRoute('POST', '/auth/2fa/recovery-codes', 'Made new recovery codes'),
  {
    method: 'POST',
    pattern: '/auth/pin',
    before: (db, call) => (call.me ? userSnapshot(db, call.me.id) : null),
    after(db, done, before: Snap | null) {
      if (!done.me) return [];
      const after = userSnapshot(db, done.me.id);
      const summary = before && 'pinSet' in before ? (before.pinSet ? 'Changed their PIN' : 'Set a PIN') : 'Set or changed their PIN';
      return [{ entity: 'user', entityId: done.me.id, summary, before, after }];
    },
  } satisfies AuditRouteSpec<Snap | null>,
  {
    method: 'PUT',
    pattern: '/auth/security-settings',
    // the settings as stored now (U1's meta keys), so a change made outside the trail is still a true "before"
    before: (db) => soft(() => settingsFrom(readSecuritySettings(db)), null) ?? lastSettings(db),
    after(_db, done, before: Snap | undefined) {
      const after = settingsFrom(done.response);
      const diff = auditDiff(before ?? null, after);
      if (before && after && !diff.length) return []; // saved with the same values
      return [{ entity: 'settings', entityId: null, summary: withChanges('Changed sign-in settings', diff), before: before ?? null, after }];
    },
  } satisfies AuditRouteSpec<Snap>,

  // ── recruitment ──
  entityRoute('POST', '/recruitment/candidates', {
    entity: 'candidate',
    load: candidateSnapshot,
    summary: ({ after }) => `Added candidate: ${str(after?.name, 'someone')}${after?.positionApplied ? ` (applied for ${positionLabel(after.positionApplied).toLowerCase()})` : ''}`,
  }),
  entityRoute('PATCH', '/recruitment/candidates/:id', {
    entity: 'candidate',
    load: candidateSnapshot,
    summary: ({ before, after, diff }) => withChanges(`Updated candidate ${str(after?.name ?? before?.name, 'someone')}`, diff),
  }),
  entityRoute('POST', '/recruitment/candidates/:id/stage', {
    entity: 'candidate',
    load: candidateSnapshot,
    summary: ({ before, after }) => {
      const name = str(after?.name ?? before?.name, 'someone');
      if (before && after && before.stage === after.stage) return `Kept ${name} at ${stageLabel(after.stage)}`;
      return `Moved ${name}: ${stageLabel(before?.stage)} → ${stageLabel(after?.stage)}`;
    },
    extra(db, { before, after }) {
      const hired = toId(after?.hiredUserId);
      if (!hired || toId(before?.hiredUserId) === hired) return [];
      const person = userSnapshot(db, hired);
      return [{ entity: 'user', entityId: hired, summary: personAdded(person, ' from recruitment'), before: null, after: person }];
    },
  }),
  entityRoute('POST', '/recruitment/interviews', {
    entity: 'candidate',
    load: interviewSnapshot,
    idAfter: (_db, done) => toId(responseOf(done).id),
    entityIdOf: ({ after, before }) => toId((after ?? before)?.candidateId),
    summary: ({ after }) =>
      after
        ? `Booked ${auditHumanise(String(after.type)).toLowerCase()} interview: ${str(after.candidateName, 'a candidate')}, ${auditValueText('scheduledAt', after.scheduledAt)}`
        : 'Booked an interview',
  }),
  entityRoute('PATCH', '/recruitment/interviews/:id', {
    entity: 'candidate',
    load: interviewSnapshot,
    entityIdOf: ({ after, before }) => toId((after ?? before)?.candidateId),
    summary: ({ before, after, diff }) => withChanges(`Updated interview: ${str(after?.candidateName ?? before?.candidateName, 'a candidate')}`, diff),
  }),

  // ── events and campaigns ──
  entityRoute('POST', '/events', { entity: 'event', load: eventSnapshot, summary: ({ after }) => `Created event: ${eventPlace(after)}` }),
  entityRoute('PATCH', '/events/:id', {
    entity: 'event',
    load: eventSnapshot,
    summary: ({ before, after, diff }) => {
      const status = diff.find((d) => d.field === 'status');
      if (status?.after === 'cancelled') return `Cancelled event: ${eventPlace(after ?? before)}`;
      if (status?.before === 'cancelled') return withChanges(`Restored event: ${eventPlace(after ?? before)}`, diff, ['status']);
      return withChanges(`Updated event: ${eventPlace(before ?? after)}`, diff);
    },
  }),
  entityRoute('DELETE', '/events/:id', { entity: 'event', load: eventSnapshot, summary: ({ before }) => `Deleted event: ${eventPlace(before)}` }),
  entityRoute('POST', '/campaigns', { entity: 'campaign', load: campaignSnapshot, summary: ({ after }) => `Added campaign: ${campaignName(after)}` }),
  entityRoute('PATCH', '/campaigns/:id', {
    entity: 'campaign',
    load: campaignSnapshot,
    summary: ({ before, after, diff }) => withChanges(`Updated campaign ${campaignName(before ?? after)}`, diff),
  }),

  // ── announcements and pitches ──
  entityRoute('POST', '/announcements', {
    entity: 'announcement',
    load: announcementSnapshot,
    summary: ({ after }) => `Posted announcement: “${str(after?.title, 'Untitled')}”`,
  }),
  entityRoute('PUT', '/pitches/:campaignCode', {
    entity: 'pitch',
    load: pitchSnapshot,
    skipUnchanged: true, // a pitch saved with the same title, script and fact-check notes
    // a pitch is keyed by its campaign: the entity id is the campaign's id
    idBefore: (db, call) =>
      get<{ id: number }>(db, `SELECT id FROM campaigns WHERE lower(code) = lower(?)`, [String(call.params.campaignCode ?? '')])?.id ?? null,
    summary: ({ before, after, diff, done }) => {
      const code = str(after?.campaignCode ?? before?.campaignCode, String(done.params.campaignCode ?? '').toUpperCase());
      // a pitch's text is its script, as the audit views label it (the stored snapshots keep the column name, body)
      const named = diff.map((d) => (d.field === 'body' ? { ...d, field: 'script' } : d));
      return before ? withChanges(`Edited the ${code} pitch`, named, ['campaignCode']) : `Wrote the ${code} pitch`;
    },
  }),

  // ── learning (L1) ──
  {
    method: 'POST',
    pattern: '/learning/progress/:lessonKey/quiz',
    before: (db, call) => (call.me ? learningSnapshot(db, call.me.id, String(call.params.lessonKey)) : null),
    after(db, done, before: Snap | null) {
      if (!done.me) return [];
      const after = learningSnapshot(db, done.me.id, String(done.params.lessonKey));
      if (!auditDiff(before, after).length) return []; // a retake with the same score: nothing stored changed
      const lesson = lessonLabel(done.params.lessonKey);
      const summary = after?.learnedAt && !before?.learnedAt ? `Learned ${lesson}: self-check passed` : `Took the self-check: ${lesson}`;
      return [{ entity: 'learning', entityId: done.me.id, summary, before, after }];
    },
  } satisfies AuditRouteSpec<Snap | null>,
  {
    method: 'POST',
    pattern: '/learning/progress/:lessonKey/teachback',
    // the text itself is compared, never stored: a teach-back reaches only the person, their leader and admins
    before: (db, call) =>
      call.me ? { snap: learningSnapshot(db, call.me.id, String(call.params.lessonKey)), text: teachbackText(db, call.me.id, String(call.params.lessonKey)) } : null,
    after(db, done, state: TeachbackState | null) {
      if (!done.me) return [];
      const key = String(done.params.lessonKey);
      if (state?.text != null && teachbackText(db, done.me.id, key) === state.text) return []; // saved with the same text
      const before = state?.snap ?? null;
      const after = learningSnapshot(db, done.me.id, key);
      return [{ entity: 'learning', entityId: done.me.id, summary: `Wrote a teach-back: ${lessonLabel(key)}`, before, after }];
    },
  } satisfies AuditRouteSpec<TeachbackState | null>,
  {
    method: 'POST',
    pattern: '/learning/progress/:userId/:lessonKey/signoff',
    before: (db, call) => {
      const userId = paramId(call, 'userId');
      return userId ? learningSnapshot(db, userId, String(call.params.lessonKey)) : null;
    },
    after(db, done, before: Snap | null) {
      const userId = paramId(done, 'userId');
      const after = userId ? learningSnapshot(db, userId, String(done.params.lessonKey)) : null;
      // signed off already (the first signer stands), or a sign-off taken back where there was none: nothing changed
      if (!auditDiff(before, after).length) return [];
      const what = after?.signedOffAt ? 'Signed off a teach-back' : 'Took back a teach-back sign-off';
      const summary = `${what}: ${userName(db, userId) ?? 'someone'}, ${lessonLabel(done.params.lessonKey)}`;
      return [{ entity: 'learning', entityId: userId, summary, before, after }];
    },
  } satisfies AuditRouteSpec<Snap | null>,

  // ── shift check-ins (U4) ──
  {
    method: 'POST',
    pattern: '/checkins',
    // The route answers 201 with a new check-in and 200 with the one already recorded (the first one stands, whatever
    // the request carries). The status is the test, not a lookup of our own: the route finds the earlier check-in by
    // the signed-in person and a day it works out itself, so any copy of that here could disagree and record a replay.
    after(db, done) {
      if (done.status !== 201) return []; // a replay answered "already recorded": nothing changed
      const id = toId(responseOf(done).id);
      const after = id ? checkInSnapshot(db, id) : null;
      const where = after ? `${str(after.userName, 'Someone')} at ${str(after.eventName, 'an event')}, ${auditValueText('checkedInAt', after.checkedInAt)}` : 'an event';
      return [{ entity: 'check_in', entityId: id, summary: `Checked in: ${where}`, before: null, after }];
    },
  } satisfies AuditRouteSpec,
  entityRoute('DELETE', '/checkins/:id', {
    entity: 'check_in',
    load: checkInSnapshot,
    summary: ({ before }) => (before ? `Removed check-in: ${str(before.userName, 'Someone')} at ${str(before.eventName, 'an event')}` : 'Removed a check-in'),
  }),
];

interface CompiledRoute {
  spec: AuditRouteSpec;
  re: RegExp;
  names: string[];
}

function compile(spec: AuditRouteSpec): CompiledRoute {
  const names: string[] = [];
  const source = spec.pattern
    .split('/')
    .map((seg) => {
      if (seg.startsWith(':')) {
        names.push(seg.slice(1));
        return '([^/]+)';
      }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { spec, re: new RegExp(`^${source}/?$`, 'i'), names };
}

const COMPILED: readonly CompiledRoute[] = AUDIT_ROUTES.map(compile);

/** The registry entry for a write (first match wins; literal paths are listed before `:param` ones). */
export function matchAuditRoute(method: string, path: string): { spec: AuditRouteSpec; params: Record<string, string> } | null {
  for (const c of COMPILED) {
    if (c.spec.method !== method) continue;
    const m = c.re.exec(path);
    if (!m) continue;
    const params: Record<string, string> = {};
    c.names.forEach((name, i) => {
      const raw = m[i + 1] ?? '';
      params[name] = soft(() => decodeURIComponent(raw), raw);
    });
    return { spec: c.spec, params };
  }
  return null;
}
