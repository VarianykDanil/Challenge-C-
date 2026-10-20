/**
 * Release 1.2 — OWNED BY U4 check-ins. The one-tap shift check-in on the server side: the SQL every punctuality
 * query joins, and the row → ShiftCheckIn mapping routes/checkins.ts answers with. Table: db/extensions/checkins.ts.
 *
 * Punctuality rule (1.2): the check-in time of a logged day is the one-tap check-in for that person, event and date
 * when there is one, else the gauge entry's own `checked_in_at` (the 1.1 behaviour). Days are still the gauge rows:
 * a check-in alone is never a day worked, never paid, never a punctuality sample of its own.
 */
import { canUndoShiftCheckIn, shiftCheckInStatus, shiftCheckInUndoMsLeft, type ShiftCheckIn, type ShiftCheckInSource, type UserWithTeam } from '@lm/shared';
import { all, get, type Db } from '../db/connection.ts';
import { businessNow } from './dates.ts';
import { isAdmin, isLeader } from './scope.ts';

/** LEFT JOIN of the shift check-in (alias `ci`) of a gauge row `g`: the same person, event and day (unique key). */
export const SHIFT_CHECK_IN_JOIN = 'LEFT JOIN check_ins ci ON ci.user_id = g.user_id AND ci.event_id = g.event_id AND ci.date = g.date';

/** The check-in time punctuality reads for a gauge row `g` (needs SHIFT_CHECK_IN_JOIN). */
export const CHECKED_IN_AT_SQL = 'COALESCE(ci.checked_in_at, g.checked_in_at)';

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
  SELECT ci.id, ci.user_id AS userId, u.first_name || ' ' || u.last_name AS userName, u.team_id AS teamId,
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
