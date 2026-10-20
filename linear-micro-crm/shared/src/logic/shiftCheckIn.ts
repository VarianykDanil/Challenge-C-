/**
 * Release 1.2 — OWNED BY U4 check-ins (laid down by r2-foundation). Pure rules for the one-tap shift check-in: on time
 * or late with the existing grace rule (logic/punctuality.ts), the undo window, and the offline replay decision.
 */
import { SHIFT_CHECK_IN_UNDO_MS } from '../types/checkins.ts';
import { isCheckInOnTime, minutesLate } from './punctuality.ts';

/** "Checked in 09:24 · on time" / "· 6 min late": the numbers behind the label (existing grace rule). */
export function shiftCheckInStatus(eventDate: string, startTime: string, checkedInAt: string): { minutesLate: number | null; onTime: boolean } {
  return { minutesLate: minutesLate(eventDate, startTime, checkedInAt), onTime: isCheckInOnTime(eventDate, startTime, checkedInAt) !== false };
}

/** Whether the person may still undo their own check-in written at `createdAt` (ISO) at `nowMs`. */
export function canUndoShiftCheckIn(createdAt: string, nowMs: number): boolean {
  const t = new Date(createdAt).getTime();
  return Number.isFinite(t) && nowMs - t <= SHIFT_CHECK_IN_UNDO_MS;
}
