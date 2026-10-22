/**
 * Release 1.2 — OWNED BY U4 check-ins. The one-tap shift check-in on the server side: the SQL every punctuality
 * query joins, and the row → ShiftCheckIn mapping routes/checkins.ts answers with. Table: db/extensions/checkins.ts.
 *
 * Punctuality rule (1.2): the check-in time of a logged day is the one-tap check-in for that person, event and date
 * when there is one, else the gauge entry's own `checked_in_at` (the 1.1 behaviour) — except that a time a leader or
 * admin recorded on the gauge entry on the person's behalf (gauge_entries.checked_in_by, review 1.2 S3) wins over the
 * person's own check-in. Days are still the gauge rows: a check-in alone is never a day worked, never paid, never a
 * punctuality sample of its own.
 */
import { canUndoShiftCheckIn, shiftCheckInStatus, shiftCheckInUndoMsLeft, type ShiftCheckIn, type ShiftCheckInSource, type UserWithTeam } from '@lm/shared';
import { all, get, run, type Db } from '../db/connection.ts';
import { businessNow } from './dates.ts';
import { forbidden } from './errors.ts';
import { isAdmin, isLeader } from './scope.ts';

/** LEFT JOIN of the shift check-in (alias `ci`) of a gauge row `g`: the same person, event and day (unique key). */
export const SHIFT_CHECK_IN_JOIN = 'LEFT JOIN check_ins ci ON ci.user_id = g.user_id AND ci.event_id = g.event_id AND ci.date = g.date';

/**
 * 1 when gauge row `g`'s check-in time was recorded by someone other than the entry's person: a leader or admin
 * logging on their behalf (`checked_in_by` is someone else; only they may write another person's gauges), else 0.
 * GAUGE_SELECT answers it as GaugeEntry.checkInOnBehalf.
 */
export const CHECK_IN_ON_BEHALF_SQL = '(g.checked_in_at IS NOT NULL AND g.checked_in_by IS NOT NULL AND g.checked_in_by <> g.user_id)';

/**
 * The check-in time punctuality reads for a gauge row `g` (needs SHIFT_CHECK_IN_JOIN): the gauge entry's own time when
 * a leader or admin recorded it on the person's behalf (CHECK_IN_ON_BEHALF_SQL), else the person's one-tap check-in
 * when there is one, else the gauge entry's own time.
 */
export const CHECKED_IN_AT_SQL = `(CASE WHEN ${CHECK_IN_ON_BEHALF_SQL}
  THEN g.checked_in_at ELSE COALESCE(ci.checked_in_at, g.checked_in_at) END)`;

/**
 * Records who set gauge entry `gaugeId`'s check-in time (`gauge_entries.checked_in_by`) after a gauge write by
 * `actorId`, inside that write's transaction. `before` is the time the entry held before the write, or undefined for
 * a new entry or one re-pointed at another person. In order:
 *  - no time, no author;
 *  - a time the write kept as it was (left out, sent back unchanged by the form, or an entry moved to another event or
 *    day without touching its time) keeps its author;
 *  - a new or changed time that is the person's own one-tap check-in for that event and day, to the minute (Log
 *    gauges fills the field from it, without the seconds) stays the person's, so the precise check-in still counts;
 *  - any other new or changed time is the actor's.
 * One statement, never a new row: called by POST /gauges, PATCH /gauges/:id and POST /gauges/bulk.
 */
export function stampCheckInAuthor(db: Db, gaugeId: number, before: string | null | undefined, actorId: number): void {
  run(
    db,
    `UPDATE gauge_entries SET checked_in_by = CASE
       WHEN checked_in_at IS NULL THEN NULL
       WHEN ? = 0 AND checked_in_at IS ? THEN checked_in_by
       WHEN EXISTS (SELECT 1 FROM check_ins ci WHERE ci.user_id = gauge_entries.user_id AND ci.event_id = gauge_entries.event_id
                      AND ci.date = gauge_entries.date AND substr(ci.checked_in_at, 1, 16) = substr(gauge_entries.checked_in_at, 1, 16))
         THEN user_id
       ELSE ? END
     WHERE id = ?`,
    [before === undefined ? 1 : 0, before ?? null, actorId, gaugeId],
  );
}

/** What the on-behalf lock needs to know about a stored gauge entry. */
export interface CheckInAuthorship {
  userId: number;
  checkedInAt: string | null;
  /** gauge_entries.checked_in_by */
  checkedInBy: number | null;
}

/** What a write by the entry's person would do to it. */
export type CheckInChange = { kind: 'time'; checkedInAt: string | null } | { kind: 'move' } | { kind: 'delete' };

/**
 * Review 1.2 S3: a check-in time a leader or admin recorded on someone's gauge entry (CHECK_IN_ON_BEHALF_SQL) counts
 * over that person's own one-tap check-in, so the person themself cannot undo it: they may still edit the entry's
 * counts and notes (the time is kept, and so is its author), but changing or clearing that time, moving the entry to
 * another event, day or person, or deleting it is refused (403) with who to ask. Leaders and admins writing someone
 * else's entry, and admins writing their own, are never refused here. One indexed read, only when refusing.
 */
export function assertCheckInNotLocked(db: Db, me: UserWithTeam, entry: CheckInAuthorship, change: CheckInChange): void {
  if (isAdmin(me) || me.id !== entry.userId || entry.checkedInAt === null || entry.checkedInBy === null || entry.checkedInBy === entry.userId) return;
  if (change.kind === 'time' && change.checkedInAt === entry.checkedInAt) return;
  const role = get<{ role: string }>(db, 'SELECT role FROM users WHERE id = ?', [entry.checkedInBy])?.role;
  const who = role === 'admin' ? 'An admin' : 'Your team leader';
  const ask = change.kind === 'time' ? 'Ask them to change it.' : change.kind === 'move' ? 'Ask them to move the entry.' : 'Ask them to delete the entry.';
  throw forbidden(`${who} recorded your arrival time on these gauges. ${ask}`);
}

/** One check_ins row with what the answer needs (the owner's name and team, the event's start). */
export interface ShiftCheckInRow {
  id: number;
  userId: number;
  userName: string;
  teamId: number | null;
  eventId: number;
  date: string;
  checkedInAt: string;
  source: ShiftCheckInSource;
  createdAt: string;
  startTime: string;
}

const ROW_SELECT = `
  SELECT ci.id, ci.user_id AS userId, TRIM(u.first_name || ' ' || u.last_name) AS userName, u.team_id AS teamId,
         ci.event_id AS eventId, ci.date, ci.checked_in_at AS checkedInAt, ci.source, ci.created_at AS createdAt,
         e.start_time AS startTime
  FROM check_ins ci
  JOIN users u ON u.id = ci.user_id
  JOIN events e ON e.id = ci.event_id`;

export function getShiftCheckIn(db: Db, id: number): ShiftCheckInRow | undefined {
  return get<ShiftCheckInRow>(db, `${ROW_SELECT} WHERE ci.id = ?`, [id]);
}

export function findShiftCheckIn(db: Db, key: { userId: number; eventId: number; date: string }): ShiftCheckInRow | undefined {
  return get<ShiftCheckInRow>(db, `${ROW_SELECT} WHERE ci.user_id = ? AND ci.event_id = ? AND ci.date = ?`, [key.userId, key.eventId, key.date]);
}

/**
 * The event's check-ins `me` may see, earliest first: admin everyone; a leader their own team's people and themself;
 * anyone else their own only (the same rule as check-in times on gauge entries, lib/scope.ts canSeeEntryDetails).
 */
export function listShiftCheckIns(db: Db, me: UserWithTeam, eventId: number): ShiftCheckInRow[] {
  if (isAdmin(me)) return all<ShiftCheckInRow>(db, `${ROW_SELECT} WHERE ci.event_id = ? ORDER BY ci.checked_in_at, ci.id`, [eventId]);
  if (isLeader(me) && me.teamId !== null) {
    return all<ShiftCheckInRow>(db, `${ROW_SELECT} WHERE ci.event_id = ? AND (u.team_id = ? OR ci.user_id = ?) ORDER BY ci.checked_in_at, ci.id`, [eventId, me.teamId, me.id]);
  }
  return all<ShiftCheckInRow>(db, `${ROW_SELECT} WHERE ci.event_id = ? AND ci.user_id = ? ORDER BY ci.checked_in_at, ci.id`, [eventId, me.id]);
}

/** May `me` remove this check-in at any time? Admins, and the leader of the person's team (themself included). */
export function managesShiftCheckIn(me: UserWithTeam, row: Pick<ShiftCheckInRow, 'teamId'>): boolean {
  return isAdmin(me) || (isLeader(me) && me.teamId !== null && row.teamId === me.teamId);
}

/** May `me` see this check-in at all (else the API answers 404, never revealing it exists)? */
export function canSeeShiftCheckIn(me: UserWithTeam, row: Pick<ShiftCheckInRow, 'userId' | 'teamId'>): boolean {
  return row.userId === me.id || managesShiftCheckIn(me, row);
}

/** The API shape, with on time / late (existing grace rule) and the caller's own undo window. */
export function toShiftCheckIn(row: ShiftCheckInRow, me: UserWithTeam, nowMs = businessNow().getTime()): ShiftCheckIn {
  const status = shiftCheckInStatus(row.date, row.startTime, row.checkedInAt);
  const own = row.userId === me.id && canUndoShiftCheckIn(row.createdAt, nowMs);
  const msLeft = own ? shiftCheckInUndoMsLeft(row.createdAt, nowMs) : 0;
  return {
    id: Number(row.id),
    userId: Number(row.userId),
    userName: row.userName,
    eventId: Number(row.eventId),
    date: row.date,
    checkedInAt: row.checkedInAt,
    source: row.source,
    createdAt: row.createdAt,
    minutesLate: status.minutesLate,
    onTime: status.onTime,
    undoUntil: msLeft > 0 ? new Date(nowMs + msLeft).toISOString() : null,
    undoMsLeft: msLeft,
  };
}
