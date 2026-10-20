/**
 * Release 1.2 — U4 check-ins contracts (laid down by r2-foundation; OWNED BY U4, which may add fields and types).
 * "Shift" check-ins: one tap when you arrive at an event. Not the 1.1 "Check in with…" list (CheckInPerson /
 * CheckInReason in shared/src/types.ts), which is about leaders talking to people.
 *
 * Endpoints (server/src/routes/checkins.ts, owned by U4):
 *  - POST   /checkins  ShiftCheckInInput → 201 ShiftCheckIn (or 200 with the existing one: idempotent on user+event+date)
 *  - DELETE /checkins/:id → 204 (self within 2 minutes; leader of the team / admin any time)
 *  - GET    /checkins?eventId= → ShiftCheckInList (leader / admin: the event's team in scope; rep: own only)
 * A check-in never creates a gauge row and never counts as a day worked.
 */

export type ShiftCheckInSource = 'button' | 'quick' | 'offline' | 'leader';

/** How long the person may undo their own check-in. */
export const SHIFT_CHECK_IN_UNDO_MS = 2 * 60_000;

export interface ShiftCheckIn {
  id: number;
  userId: number;
  userName?: string;
  eventId: number;
  date: string;
  /** Naive Europe/London wall-clock time, the same format as GaugeEntry.checkedInAt. */
  checkedInAt: string;
  source: ShiftCheckInSource;
  /** ISO timestamp the row was written (real clock). */
  createdAt: string;
  /** Whole minutes after the event start (0 when early or on time: shared `minutesLate`); null when unknown. */
  minutesLate: number | null;
  /** Within LATE_GRACE_MINUTES of the start (the existing punctuality rule). */
  onTime: boolean;
  /** Until when the person may undo it themself (ISO), null once that has passed or for someone else's row. */
  undoUntil: string | null;
}

export interface ShiftCheckInInput {
  eventId: number;
  /** Default: the business date. */
  date?: string;
  /** Default: the business clock now; a replayed offline check-in sends the time it was tapped. Never in the future. */
  checkedInAt?: string;
  source?: ShiftCheckInSource;
}

export interface ShiftCheckInList {
  eventId: number;
  checkIns: ShiftCheckIn[];
}
