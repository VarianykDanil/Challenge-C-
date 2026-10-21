/**
 * Release 1.2 — U4 check-ins contracts (laid down by r2-foundation; OWNED BY U4, which may add fields and types).
 * "Shift" check-ins: one tap when you arrive at an event. Not the 1.1 "Check in with…" list (CheckInPerson /
 * CheckInReason in shared/src/types.ts), which is about leaders talking to people.
 *
 * Endpoints (server/src/routes/checkins.ts, owned by U4):
 *  - POST   /checkins  ShiftCheckInInput → 201 ShiftCheckIn (or 200 with the existing one: idempotent on user+event+date)
 *  - DELETE /checkins/:id → 204 (self within 2 minutes; leader of the person's team / admin any time)
 *  - GET    /checkins?eventId= → ShiftCheckInList (admin: everyone; leader: their team and themself; others: own only)
 * A check-in never creates a gauge row and never counts as a day worked.
 */

/**
 * How the check-in reached Linear Hub: 'button' (dashboard or event page), 'quick' (Quick gauges), 'offline' (tapped
 * without signal and sent later by the phone, with the time it was tapped). 'leader' is reserved (not written in 1.2).
 */
export type ShiftCheckInSource = 'button' | 'quick' | 'offline' | 'leader';

/** The sources POST /checkins accepts. */
export const SHIFT_CHECK_IN_SOURCES = ['button', 'quick', 'offline'] as const;

/** How long the person may undo their own check-in. */
export const SHIFT_CHECK_IN_UNDO_MS = 2 * 60_000;

/** Extra time the server allows on an undo, for the request's trip over a slow hotspot. */
export const SHIFT_CHECK_IN_UNDO_GRACE_MS = 15_000;

/**
 * A check-in kept on the phone must reach Linear Hub within this many hours of the event's end; a later one is refused
 * and the phone shows why (review 1.2 S3: it was 7 days).
 */
export const SHIFT_CHECK_IN_REPLAY_HOURS = 24;

/**
 * The earliest time a check-in kept on the phone can carry: this many minutes before the event's start. An earlier
 * tap is recorded as that time, which is still on time (review 1.2 S3). A live tap has no such bound.
 */
export const SHIFT_CHECK_IN_EARLY_MINUTES = 60;

/** A phone clock up to this far ahead of Linear Hub's is treated as "now" rather than refused as a future time. */
export const SHIFT_CHECK_IN_CLOCK_SKEW_MS = 5 * 60_000;

/** Most check-ins one phone keeps waiting (per signed-in person). */
export const SHIFT_CHECK_IN_QUEUE_LIMIT = 20;

export interface ShiftCheckIn {
  id: number;
  userId: number;
  userName?: string;
  eventId: number;
  date: string;
  /** Naive Europe/London wall-clock time, the same format as GaugeEntry.checkedInAt. */
  checkedInAt: string;
  source: ShiftCheckInSource;
  /** ISO timestamp the row was written (the business clock, which ticks with real time). */
  createdAt: string;
  /** Whole minutes after the event start (0 when early or on time: shared `minutesLate`); null when unknown. */
  minutesLate: number | null;
  /** Within LATE_GRACE_MINUTES of the start (the existing punctuality rule). */
  onTime: boolean;
  /** Until when the person may undo it themself (ISO), null once that has passed or for someone else's row. */
  undoUntil: string | null;
  /**
   * Milliseconds of the undo window left when the server answered (0 when none). Clients count down from the moment
   * the answer arrived, so a phone clock that is minutes out never shows Undo too long or too briefly.
   */
  undoMsLeft?: number;
}

export interface ShiftCheckInInput {
  eventId: number;
  /** Default: the date of `checkedInAt` when given, else the business date. Must be the event's date. */
  date?: string;
  /**
   * Default: the business clock now; a replayed offline check-in sends the time it was tapped (naive wall-clock time,
   * like Log gauges' "Checked in at"). Never in the future (a phone up to 5 minutes ahead counts as now), on the
   * event's date, and not after the event's end time.
   */
  checkedInAt?: string;
  /**
   * 'button' (default) or 'quick' for a live tap. A check-in that carries `checkedInAt` is always recorded as
   * 'offline' ("sent later"), whatever is sent here (review 1.2 S3).
   */
  source?: ShiftCheckInSource;
}

export interface ShiftCheckInList {
  eventId: number;
  checkIns: ShiftCheckIn[];
}
