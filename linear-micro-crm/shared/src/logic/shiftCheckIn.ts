/**
 * Release 1.2 — OWNED BY U4 check-ins (laid down by r2-foundation). Pure rules for the one-tap shift check-in: on time
 * or late with the existing grace rule (logic/punctuality.ts), the undo window, when the button applies, which time a
 * check-in may carry, and the offline replay decision. No I/O: the server's routes/checkins.ts and the client's
 * features/checkins/* call these.
 *
 * Times are naive wall-clock strings ("YYYY-MM-DDTHH:MM:SS", Europe/London), the format of GaugeEntry.checkedInAt, so
 * they compare as strings; differences between two of them are taken as if both were UTC (never shifted by DST).
 */
import {
  SHIFT_CHECK_IN_CLOCK_SKEW_MS,
  SHIFT_CHECK_IN_EARLY_MINUTES,
  SHIFT_CHECK_IN_QUEUE_LIMIT,
  SHIFT_CHECK_IN_REPLAY_HOURS,
  SHIFT_CHECK_IN_UNDO_MS,
} from '../types/checkins.ts';
import { isCheckInOnTime, minutesLate } from './punctuality.ts';

/** "Checked in 09:24 · on time" / "· 6 min late": the numbers behind the label (existing grace rule). */
export function shiftCheckInStatus(eventDate: string, startTime: string, checkedInAt: string): { minutesLate: number | null; onTime: boolean } {
  return { minutesLate: minutesLate(eventDate, startTime, checkedInAt), onTime: isCheckInOnTime(eventDate, startTime, checkedInAt) !== false };
}

/**
 * Whether the person may still undo their own check-in written at `createdAt` (ISO) at `nowMs`. The server passes
 * SHIFT_CHECK_IN_UNDO_GRACE_MS as `graceMs`, so an Undo tapped in the last seconds survives a slow request.
 */
export function canUndoShiftCheckIn(createdAt: string, nowMs: number, graceMs = 0): boolean {
  const t = new Date(createdAt).getTime();
  return Number.isFinite(t) && nowMs - t <= SHIFT_CHECK_IN_UNDO_MS + graceMs;
}

/** Milliseconds of the undo window left at `nowMs` (0 once it has passed, or when `createdAt` does not parse). */
export function shiftCheckInUndoMsLeft(createdAt: string, nowMs: number): number {
  const t = new Date(createdAt).getTime();
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, Math.min(SHIFT_CHECK_IN_UNDO_MS, t + SHIFT_CHECK_IN_UNDO_MS - nowMs));
}

/**
 * How late, in words: "6 min late" up to an hour ("60 min late"), then hours and minutes, "1 h 5 min late",
 * "5 h 48 min late", or "2 h late" on a whole hour (UI QA 1.2 #5: "348 min late" was hard to read).
 */
export function shiftCheckInLateText(minutesLate: number): string {
  if (minutesLate <= 60) return `${minutesLate} min late`;
  const hours = Math.floor(minutesLate / 60);
  const minutes = minutesLate % 60;
  return minutes ? `${hours} h ${minutes} min late` : `${hours} h late`;
}

/** "on time" / "6 min late" / "5 h 48 min late" (empty when the event start is unknown). */
export function shiftCheckInStatusText(status: { minutesLate: number | null; onTime: boolean }): string {
  if (status.minutesLate === null) return '';
  return status.onTime ? 'on time' : shiftCheckInLateText(status.minutesLate);
}

/** "HH:MM" of a naive or ISO timestamp as written (no zone conversion); '' when it has no time part. */
export function shiftCheckInClock(checkedInAt: string): string {
  const m = /T(\d{2}):(\d{2})/.exec(checkedInAt);
  return m ? `${m[1]}:${m[2]}` : '';
}

/** "Checked in 09:24 · on time" / "Checked in 09:36 · 6 min late" / "Checked in 15:18 · 5 h 48 min late" / "Checked in 09:24". */
export function shiftCheckInLabel(checkedInAt: string, status: { minutesLate: number | null; onTime: boolean }): string {
  const text = shiftCheckInStatusText(status);
  return `Checked in ${shiftCheckInClock(checkedInAt)}${text ? ` · ${text}` : ''}`;
}

/**
 * Where an event stands for the check-in button at `nowHHMM` on `today`: 'open' on the event's day until its end
 * time (before the start too: arriving early is the point), 'ended' after the end time, 'not-today' on any other day,
 * 'cancelled' when the event was cancelled.
 */
export type ShiftCheckInWindow = 'open' | 'ended' | 'not-today' | 'cancelled';

export function shiftCheckInWindow(event: { date: string; endTime: string; status: string }, today: string, nowHHMM: string): ShiftCheckInWindow {
  if (event.status === 'cancelled') return 'cancelled';
  if (event.date !== today) return 'not-today';
  return nowHHMM.slice(0, 5) > event.endTime.slice(0, 5) ? 'ended' : 'open';
}

/** Milliseconds between two naive timestamps (b − a), both read as UTC; NaN when either does not parse. */
export function naiveDiffMs(a: string, b: string): number {
  const pa = Date.parse(`${a.slice(0, 19)}Z`);
  const pb = Date.parse(`${b.slice(0, 19)}Z`);
  return pb - pa;
}

/**
 * The earliest naive time a check-in sent later from a phone can carry at an event starting `startTime` on
 * `eventDate`: SHIFT_CHECK_IN_EARLY_MINUTES before the start, never before the event's own date (an event starting
 * before 01:00). Null when the start time does not read.
 */
function earliestOfflineTime(eventDate: string, startTime: string): string | null {
  const m = /^(\d{2}):(\d{2})/.exec(startTime);
  if (!m) return null;
  const minutes = Math.max(0, Number(m[1]) * 60 + Number(m[2]) - SHIFT_CHECK_IN_EARLY_MINUTES);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${eventDate}T${two(Math.floor(minutes / 60))}:${two(minutes % 60)}:00`;
}

export interface ShiftCheckInTimeInput {
  eventDate: string;
  /** "HH:MM" (seconds ignored): bounds how early a check-in sent later from a phone can be. */
  startTime: string;
  /** "HH:MM" */
  endTime: string;
  /** The time the check-in carries (naive, already normalised), or null for "now". */
  requested: string | null;
  /** The business clock now, naive Europe/London ("YYYY-MM-DDTHH:MM:SS"). */
  now: string;
  /** The business date. */
  today: string;
}

export type ShiftCheckInTimeResult = { ok: true; checkedInAt: string } | { ok: false; error: string };

/**
 * Which time a new check-in records, or why it is refused (400). `requested` null means a live tap: the time is
 * `now`, so the event must be today and not over (no early bound: arriving early is the point). A replayed offline
 * tap keeps its own time, within these bounds (review 1.2 S3):
 *  - it must be on the event's date and not after the event's end;
 *  - it cannot be in the future (a phone clock up to SHIFT_CHECK_IN_CLOCK_SKEW_MS ahead is taken as now);
 *  - it must reach Linear Hub within SHIFT_CHECK_IN_REPLAY_HOURS of the event's end, counted on the wall clock;
 *  - it is never earlier than SHIFT_CHECK_IN_EARLY_MINUTES before the start: an earlier time is recorded as that
 *    (still on time), or as `now` when the replay arrives before that bound has come round.
 */
export function resolveShiftCheckInTime(i: ShiftCheckInTimeInput): ShiftCheckInTimeResult {
  const end = `${i.eventDate}T${i.endTime.slice(0, 5)}:00`;
  const endLabel = i.endTime.slice(0, 5);
  if (i.requested === null) {
    if (i.eventDate !== i.today) return { ok: false, error: 'You can check in on the day of the event' };
    if (i.now > end) return { ok: false, error: `Check-in closed at ${endLabel}, when the event ended` };
    return { ok: true, checkedInAt: i.now };
  }
  let at = i.requested;
  if (at.slice(0, 10) !== i.eventDate) return { ok: false, error: "A check-in is recorded on the event's day" };
  if (naiveDiffMs(end, i.now) > SHIFT_CHECK_IN_REPLAY_HOURS * 3_600_000) {
    return {
      ok: false,
      error: `This check-in reached Linear Hub more than ${SHIFT_CHECK_IN_REPLAY_HOURS} hours after the event ended at ${endLabel}, so it cannot be recorded. Ask your team leader to record your arrival time.`,
    };
  }
  if (at > i.now) {
    const ahead = naiveDiffMs(i.now, at);
    if (!(ahead <= SHIFT_CHECK_IN_CLOCK_SKEW_MS)) return { ok: false, error: 'Check-in time cannot be in the future' };
    at = i.now; // a phone clock slightly ahead: it happened now
  }
  if (at > end) return { ok: false, error: `Check-in closed at ${endLabel}, when the event ended` };
  const earliest = earliestOfflineTime(i.eventDate, i.startTime);
  if (earliest !== null) {
    const floor = earliest < i.now ? earliest : i.now;
    if (at < floor) at = floor;
  }
  return { ok: true, checkedInAt: at };
}

/**
 * What a POST /checkins answer means for a check-in kept on the phone: 'sent' (201, recorded now), 'already' (200:
 * Linear Hub already had a check-in for that person, event and day, so the queued one is done), 'stop' (no answer,
 * 401, a 403 asking for a PIN to be set, 429 or a server error: keep it and try again later), 'failed' (any other
 * 4xx: Linear Hub refused it; the phone shows why and the person dismisses it).
 */
export type ShiftCheckInReplayOutcome = 'sent' | 'already' | 'stop' | 'failed';

export function shiftCheckInReplayOutcome(status: number, opts: { pinSetupRequired?: boolean } = {}): ShiftCheckInReplayOutcome {
  if (status === 201) return 'sent';
  if (status === 200) return 'already';
  if (status === 401 || status === 408 || status === 429) return 'stop';
  if (status === 403 && opts.pinSetupRequired) return 'stop';
  if (status >= 400 && status < 500) return 'failed';
  return 'stop';
}

/** The fields of a queued check-in the queue rule reads. */
export interface QueuedShiftCheckInKey {
  eventId: number;
  date: string;
  checkedInAt: string;
}

/**
 * Adds a tap to the phone's queue: one item per (event, date), the earliest tap kept (the server keeps the first
 * check-in too, so a second tap never moves the time later). Returns the new queue, or null when it is full.
 */
export function addToShiftCheckInQueue<T extends QueuedShiftCheckInKey>(queue: readonly T[], item: T, limit = SHIFT_CHECK_IN_QUEUE_LIMIT): T[] | null {
  const same = queue.find((q) => q.eventId === item.eventId && q.date === item.date);
  if (same) return same.checkedInAt <= item.checkedInAt ? [...queue] : queue.map((q) => (q === same ? item : q));
  if (queue.length >= limit) return null;
  return [...queue, item];
}
