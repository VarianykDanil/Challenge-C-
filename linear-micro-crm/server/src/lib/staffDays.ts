/**
 * Office staff's paid days (MON-8). An office recruiter is paid the day rate for each weekday (Mon–Fri) from their
 * start date, never after their leaving date (users.leaving_date, their last working day), never in the future, and
 * never on a day they were away (staff_absences: holiday, sick, unpaid or other). Field people's days come from their
 * gauges (lib/payDays.ts); a leaving date stops theirs too.
 *
 * Changes are refused for a week already paid or in a payment on its way (the money is settled: add an adjustment
 * instead); every other affected week's unpaid run is brought up to date at once. The table: db/extensions/pay.ts;
 * the count: shared officeDaysWorked.
 */
import type { StaffAbsence, StaffAbsenceKind, StaffDays, UserWithTeam } from '@lm/shared';
import { all, get, run, type Db } from '../db/connection.ts';
import { paymentOnItsWay } from '../db/maintenance.ts';
import { addDays, dayOfWeek, diffDays, isISODate, mondayOf, nowISO } from './dates.ts';
import { badRequest, conflict, notFound } from './errors.ts';

export const STAFF_ABSENCE_KINDS: readonly StaffAbsenceKind[] = ['holiday', 'sick', 'unpaid', 'other'];
/** The most days one request may add (a long holiday). */
export const ABSENCE_RANGE_MAX = 31;

const isWeekday = (date: string) => {
  const d = dayOfWeek(date);
  return d >= 1 && d <= 5;
};

const ABSENCE_SELECT = `
  SELECT a.id, a.user_id AS userId, a.date, a.kind, a.note, a.created_by AS createdBy, a.created_at AS createdAt,
         CASE WHEN u.id IS NULL THEN NULL ELSE TRIM(u.first_name || ' ' || u.last_name) END AS createdByName
  FROM staff_absences a LEFT JOIN users u ON u.id = a.created_by`;

/** The person's leaving date and days off (newest first). 404 for an unknown person or a client account. */
export function staffDays(db: Db, userId: number): StaffDays {
  const u = get<{ id: number; leavingDate: string | null }>(db, `SELECT id, leaving_date AS leavingDate FROM users WHERE id = ? AND role <> 'client'`, [userId]);
  if (!u) throw notFound('User');
  const absences = all<StaffAbsence>(db, `${ABSENCE_SELECT} WHERE a.user_id = ? ORDER BY a.date DESC`, [userId]).map((a) => ({ ...a, id: Number(a.id), userId: Number(a.userId) }));
  return { userId, leavingDate: u.leavingDate ?? null, absences };
}

/** 409 when the week starting `monday` is paid or in a payment on its way (settled: an adjustment fixes it instead). */
function assertWeekOpen(db: Db, userId: number, monday: string, what: string): void {
  const paid = get(db, `SELECT 1 FROM payroll_runs WHERE user_id = ? AND week_start = ? AND status IN ('paid', 'late')`, [userId, monday]);
  if (paid) throw conflict(`The week of ${monday} is already paid, so ${what} cannot change it. Add an adjustment to a later week instead.`);
  const batch = paymentOnItsWay(db, userId, monday);
  if (batch !== null) throw conflict(`The pay for the week of ${monday} is in payment #${batch}, which is on its way. Wait for it, then add an adjustment to a later week.`);
}

/** The Mondays from `from`'s week to `to`'s week. */
function mondaysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let m = mondayOf(from); m <= mondayOf(to); m = addDays(m, 7)) out.push(m);
  return out;
}

/**
 * Sets (or clears, with null) the person's leaving date. Every week from the earlier of the old and new date onwards
 * that has a run must be open; returns the Mondays whose pay may change (the caller brings them up to date).
 */
export function setLeavingDate(db: Db, userId: number, raw: unknown, today: string): string[] {
  const current = staffDays(db, userId);
  if (raw !== null && (typeof raw !== 'string' || !isISODate(raw))) throw badRequest('The leaving date must be a date formatted YYYY-MM-DD, or empty');
  const next = raw as string | null;
  const start = get<{ startDate: string }>(db, `SELECT start_date AS startDate FROM users WHERE id = ?`, [userId])!.startDate;
  if (next && next < start) throw badRequest('The leaving date cannot be before their start date');
  if (next === current.leavingDate) return [];
  const from = [current.leavingDate, next].filter((d): d is string => !!d).sort()[0]!;
  const weeks = all<{ w: string }>(db, `SELECT week_start AS w FROM payroll_runs WHERE user_id = ? AND week_start >= ? ORDER BY week_start`, [userId, mondayOf(from)]).map((r) => r.w);
  for (const w of weeks) assertWeekOpen(db, userId, w, 'the leaving date');
  run(db, `UPDATE users SET leaving_date = ? WHERE id = ?`, [next, userId]);
  const lastWeek = mondayOf(today);
  return [...new Set([...weeks, ...mondaysBetween(from, lastWeek < mondayOf(from) ? from : lastWeek)])].sort();
}

/** Adds one day off, or each weekday from `date` to `to` (inclusive). Returns the Mondays whose pay may change. */
export function addAbsences(db: Db, me: UserWithTeam, userId: number, input: { date?: unknown; to?: unknown; kind?: unknown; note?: unknown }): string[] {
  staffDays(db, userId);
  const date = typeof input.date === 'string' && isISODate(input.date) ? input.date : null;
  if (!date) throw badRequest('Choose the day they were away (YYYY-MM-DD)', [{ path: 'date', message: 'Choose the day they were away' }]);
  const to = input.to === undefined || input.to === null || input.to === '' ? date : typeof input.to === 'string' && isISODate(input.to) ? input.to : null;
  if (!to || to < date) throw badRequest('The last day must be on or after the first', [{ path: 'to', message: 'The last day must be on or after the first' }]);
  if (diffDays(date, to) + 1 > ABSENCE_RANGE_MAX) throw badRequest(`Add at most ${ABSENCE_RANGE_MAX} days at a time`);
  const kind = (STAFF_ABSENCE_KINDS as readonly unknown[]).includes(input.kind) ? (input.kind as StaffAbsenceKind) : null;
  if (!kind) throw badRequest('Say what kind of day off it was', [{ path: 'kind', message: 'Choose holiday, sick, unpaid or other' }]);
  const note = typeof input.note === 'string' ? input.note.trim() : '';
  if (note.length > 200) throw badRequest('Keep the note under 200 characters');
  const days: string[] = [];
  for (let d = date; d <= to; d = addDays(d, 1)) if (isWeekday(d)) days.push(d);
  if (!days.length) throw badRequest('Those days are a weekend: office staff are not paid for weekends anyway');
  const weeks = [...new Set(days.map(mondayOf))];
  for (const w of weeks) assertWeekOpen(db, userId, w, 'a day off');
  const at = nowISO();
  for (const d of days) {
    run(
      db,
      `INSERT INTO staff_absences (user_id, date, kind, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, date) DO UPDATE SET kind = excluded.kind, note = excluded.note, created_by = excluded.created_by, created_at = excluded.created_at`,
      [userId, d, kind, note || null, me.id, at],
    );
  }
  return weeks;
}

/** Removes one day off (404 when it is not theirs). Returns the Monday whose pay may change. */
export function removeAbsence(db: Db, userId: number, id: number): string[] {
  const a = get<{ date: string }>(db, `SELECT date FROM staff_absences WHERE id = ? AND user_id = ?`, [id, userId]);
  if (!a) throw notFound('Day off');
  assertWeekOpen(db, userId, mondayOf(a.date), 'removing a day off');
  run(db, `DELETE FROM staff_absences WHERE id = ?`, [id]);
  return [mondayOf(a.date)];
}
