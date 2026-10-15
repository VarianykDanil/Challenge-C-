/**
 * Punctuality: was the rep at the event on time?
 *
 * Event start is `date + "HH:MM"` interpreted in the runtime's local timezone (the business runs
 * in Europe/London and the server is expected to run there too). `checkedInAt` is a full ISO
 * timestamp; one with an offset or `Z` is converted, one without is read as local time.
 */
import { LATE_GRACE_MINUTES } from '../constants.ts';

export interface PunctualityEntry {
  eventDate: string;
  /** "HH:MM" 24h */
  startTime: string;
  checkedInAt: string | null;
}

export interface PunctualitySummary {
  /** Entries with a recorded check-in. */
  recorded: number;
  onTime: number;
  late: number;
  /** onTime / recorded, null when nothing was recorded */
  rate: number | null;
  /** Mean minutes after the scheduled start across late entries (0 when none). */
  avgMinutesLate: number;
}

/** Epoch ms of the event start, or NaN when the inputs don't parse. */
export function eventStartMs(eventDate: string, startTime: string): number {
  const time = startTime.length === 5 ? `${startTime}:00` : startTime;
  return new Date(`${eventDate}T${time}`).getTime();
}

/**
 * Was the rep on time? Compares check-in timestamp with the event start (HH:MM on the event date),
 * allowing `graceMinutes` (default 5). Returns null when no check-in was recorded or a date is invalid.
 */
export function isCheckInOnTime(
  eventDate: string,
  startTime: string,
  checkedInAt: string | null,
  graceMinutes: number = LATE_GRACE_MINUTES,
): boolean | null {
  if (!checkedInAt) return null;
  const start = eventStartMs(eventDate, startTime);
  const checkIn = new Date(checkedInAt).getTime();
  if (Number.isNaN(start) || Number.isNaN(checkIn)) return null;
  return checkIn <= start + graceMinutes * 60_000;
}

/**
 * Whole minutes after the scheduled start (rounded up; 0 when early or exactly on time).
 * Ignores the grace period, so `minutesLate > graceMinutes` ⇔ `isCheckInOnTime === false`.
 * Null when no check-in was recorded or a date is invalid.
 */
export function minutesLate(eventDate: string, startTime: string, checkedInAt: string | null): number | null {
  if (!checkedInAt) return null;
  const start = eventStartMs(eventDate, startTime);
  const checkIn = new Date(checkedInAt).getTime();
  if (Number.isNaN(start) || Number.isNaN(checkIn)) return null;
  return Math.max(0, Math.ceil((checkIn - start) / 60_000));
}

/** Counts and rate over a list of entries; entries without a check-in are ignored. */
export function punctualitySummary(
  entries: ReadonlyArray<PunctualityEntry>,
  graceMinutes: number = LATE_GRACE_MINUTES,
): PunctualitySummary {
  let recorded = 0;
  let onTime = 0;
  let lateMinutes = 0;
  for (const e of entries) {
    const ok = isCheckInOnTime(e.eventDate, e.startTime, e.checkedInAt, graceMinutes);
    if (ok === null) continue;
    recorded++;
    if (ok) onTime++;
    else lateMinutes += minutesLate(e.eventDate, e.startTime, e.checkedInAt) ?? 0;
  }
  const late = recorded - onTime;
  return {
    recorded,
    onTime,
    late,
    rate: recorded > 0 ? onTime / recorded : null,
    avgMinutesLate: late > 0 ? lateMinutes / late : 0,
  };
}

/** Share (0..1) of recorded check-ins that were on time; null when none were recorded. */
export function punctualityRate(
  entries: ReadonlyArray<PunctualityEntry>,
  graceMinutes: number = LATE_GRACE_MINUTES,
): number | null {
  return punctualitySummary(entries, graceMinutes).rate;
}
