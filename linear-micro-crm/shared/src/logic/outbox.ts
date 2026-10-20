/**
 * Signal-proof logging — OWNED BY p7-signal-proof-logging.
 *
 * Pure rules behind the gauge outbox (entries saved on the phone while Linear Hub is unreachable) and the live tally
 * counter. No I/O: the client's features/gauges/outbox.ts does the storage and the requests, and calls these.
 *
 *  - replayDecision    is it safe to POST a queued entry, or does it need the person to look first?
 *  - sameGaugeDay      does the server already hold exactly what was queued (a save whose answer was lost)?
 *  - replayOutcome     what a POST /gauges status means for the queued item
 *  - inCheckInWindow, preselectTodayEvent, firstMemberWithoutEntry   Log gauges' smart defaults
 *  - tallyPerson       one +1 / −1 on the tally: one person, counted at the furthest stage they reached
 *  - normaliseTally    stored tally counts → whole numbers that respect the funnel
 */
import type { GaugeKey, GaugeTotals, GaugeUpsertInput } from '../types.ts';
import { GAUGE_KEYS } from '../types.ts';
import { GAUGE_LABELS, GAUGE_MAX_PER_DAY } from '../constants.ts';

export type ReplayDecision = 'send' | 'review';

/** What the phone knew when it queued the entry. */
export interface QueuedGaugeMeta {
  /** ISO timestamp the entry was saved on the phone. */
  queuedAt: string;
  /** The existing entry id the modal had prefilled when queuing, or null when there was none. */
  expectedExistingId: number | null;
}

/** The entry the server holds now for the same (event, user, date), if any. */
export interface ExistingEntryMeta {
  id: number;
  submittedAt: string;
}

/** Most entries one phone keeps waiting (per signed-in person). */
export const OUTBOX_LIMIT = 50;

/** Milliseconds since the epoch, or null when the text is not a timestamp. */
function instant(iso: string): number | null {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/**
 * 'send' when it is safe to POST the queued entry; 'review' when the server's day is not what the user saw when
 * queuing: an entry exists that they had not seen (expectedExistingId is null, the id differs, or it was submitted
 * after queuedAt), or the entry they were changing is gone (expectedExistingId set, nothing on the server — someone
 * deleted it meanwhile, and sending would quietly bring the day back).
 *
 * Timestamps are compared as instants (any ISO offset); one that cannot be read gives 'review' — when in doubt the
 * phone never overwrites.
 */
export function replayDecision(item: QueuedGaugeMeta, existing: ExistingEntryMeta | null): ReplayDecision {
  if (!existing) return item.expectedExistingId == null ? 'send' : 'review';
  if (item.expectedExistingId == null || existing.id !== item.expectedExistingId) return 'review';
  const submitted = instant(existing.submittedAt);
  const queued = instant(item.queuedAt);
  if (submitted === null || queued === null) return 'review';
  return submitted > queued ? 'review' : 'send';
}

/** The fields of a stored entry that a queued save can set. */
export type GaugeDayValues = GaugeTotals & { checkedInAt?: string | null; notes?: string | null };

/** A check-in compared to the minute ("2026-10-19T09:58" and "2026-10-19T09:58:00" are the same). */
const minuteOf = (v: string | null | undefined) => (v ? v.slice(0, 16) : null);
const noteOf = (v: string | null | undefined) => (v == null || v.trim() === '' ? null : v.trim());

/**
 * True when the server's entry already holds exactly what was queued: the six counts match, and so do the check-in
 * (to the minute) and notes wherever the queued save carries them (an omitted field is "keep what is stored").
 * That is a save that reached the server but whose answer was lost, so there is nothing left to send.
 */
export function sameGaugeDay(existing: GaugeDayValues, input: GaugeUpsertInput): boolean {
  if (GAUGE_KEYS.some((k) => existing[k] !== input[k])) return false;
  if (input.checkedInAt !== undefined && minuteOf(existing.checkedInAt) !== minuteOf(input.checkedInAt)) return false;
  if (input.notes !== undefined && noteOf(existing.notes) !== noteOf(input.notes)) return false;
  return true;
}

/**
 * What a POST /gauges answer means for a queued item: 201 'logged', 200 'updated' (the server found the day and
 * updated it), any other 4xx 'failed' (keep the server's message for the person), and 'stop' for a 401 (the session
 * ended: keep waiting and send after the next sign-in) or a 5xx / anything else (try again later).
 */
export type ReplayOutcome = 'logged' | 'updated' | 'failed' | 'stop';

export function replayOutcome(status: number): ReplayOutcome {
  if (status === 201) return 'logged';
  if (status === 200) return 'updated';
  if (status === 401) return 'stop';
  if (status >= 400 && status < 500) return 'failed';
  return 'stop';
}

// ───────────────────────────── Smart defaults for Log gauges ─────────────────────────────

/** Minutes since midnight of an "HH:MM" string, or null. */
function minutesOf(hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})/.exec(hhmm);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h < 24 && min < 60 ? h * 60 + min : null;
}

/** How early and how late the "Checking in? Use now" chip is offered around an event's start. */
export const CHECK_IN_CHIP_BEFORE_MIN = 60;
export const CHECK_IN_CHIP_AFTER_MIN = 90;

/**
 * True when `now` (HH:MM) lies within [start − 60 min, start + 90 min], both ends included. Outside that window a
 * "now" check-in would be wrong (an end-of-day form must never record a punctual arrival), so the chip is not offered.
 */
export function inCheckInWindow(startHHMM: string, nowHHMM: string, before = CHECK_IN_CHIP_BEFORE_MIN, after = CHECK_IN_CHIP_AFTER_MIN): boolean {
  const start = minutesOf(startHHMM);
  const now = minutesOf(nowHHMM);
  if (start === null || now === null) return false;
  return now >= start - before && now <= start + after;
}

/** The fields of an event the preselection reads. */
export interface PreselectEvent {
  id: number;
  teamId: number;
  date: string;
  status: string;
}

/**
 * The event Log gauges preselects: the one own-team event dated today that is live or completed, when there is
 * exactly one. Null when there is none, several (the person chooses), or no team.
 */
export function preselectTodayEvent(events: readonly PreselectEvent[], today: string, teamId: number | null): number | null {
  if (teamId == null) return null;
  const todays = events.filter((e) => e.teamId === teamId && e.date === today && (e.status === 'live' || e.status === 'completed'));
  return todays.length === 1 ? todays[0]!.id : null;
}

/** The fields of a person the rep picker reads. */
export interface PickerMember {
  id: number;
  role: string;
  status: string;
}

/**
 * The rep a leader or admin is offered first: the first active member (in list order) who logs gauges and has no
 * entry for the event yet. Null when everyone has logged.
 */
export function firstMemberWithoutEntry(members: readonly PickerMember[], loggedUserIds: Iterable<number>): number | null {
  const logged = new Set(loggedUserIds);
  const m = members.find((u) => u.status === 'active' && u.role !== 'recruiter' && !logged.has(u.id));
  return m ? m.id : null;
}

// ───────────────────────────── Tally ─────────────────────────────

/** Lower-case stage names for hints ("Can't take one off presentations: …"). */
const STAGE: Record<GaugeKey, string> = {
  stops: 'stops',
  table: 'to table',
  presentations: 'presentations',
  closes: 'closes',
  taps: 'taps',
  sales: 'sales',
};

/** How far a person got, for hints ("3 people got as far as closes"). */
const FAR: Record<GaugeKey, string> = {
  stops: 'a stop',
  table: 'the table',
  presentations: 'presentations',
  closes: 'closes',
  taps: 'taps',
  sales: 'sales',
};

/** 2000 → "2,000" (fixed, so a hint never depends on the phone's locale). */
const thousands = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

export type TallyStepResult = { ok: true; counts: GaugeTotals } | { ok: false; counts: GaugeTotals; hint: string };

/**
 * One tap on the tally, counted as one person at the furthest stage they reached. The owner's rule: someone who got
 * to a presentation was also stopped and got to the table, so +1 on Presentations adds one to Stops, To table and
 * Presentations; +1 on Taps adds one to every stage from Stops to Taps; +1 on Stops adds a stop only; +1 on Sales adds
 * one to all six. The stages after `key` never move.
 *
 * −1 takes that one person off again: every stage from Stops down to `key` goes down by 1, so it is the exact inverse
 * of the +1. It is refused when `key` is 0, or when it would leave `key` below the stage after it (those people got
 * past `key` too, so one of them has to come off first). A +1 is refused only when a stage it would raise is at the
 * daily maximum. A refused tap returns the same counts object and one short hint naming what to do instead.
 *
 * Given a valid funnel (stops ≥ to table ≥ presentations ≥ closes ≥ taps ≥ sales) the result is a valid funnel, and
 * every valid funnel is a sum of people's outcomes, so no order of taps is ever needed. Pure and deterministic; the
 * input is never changed.
 */
export function tallyPerson(counts: GaugeTotals, key: GaugeKey, delta: 1 | -1, max: number = GAUGE_MAX_PER_DAY): TallyStepResult {
  const i = GAUGE_KEYS.indexOf(key);
  const stages = GAUGE_KEYS.slice(0, i + 1);
  if (delta === 1) {
    const full = stages.find((k) => counts[k] >= max);
    if (full) return { ok: false, counts, hint: `${GAUGE_LABELS[full]} is at the daily maximum of ${thousands(max)}.` };
  } else {
    if (counts[key] <= 0) return { ok: false, counts, hint: `${GAUGE_LABELS[key]} is already 0.` };
    const after = GAUGE_KEYS[i + 1];
    if (after && counts[key] - 1 < counts[after]) {
      const n = counts[after];
      return {
        ok: false,
        counts,
        hint: `Can't take one off ${STAGE[key]}: ${n} ${n === 1 ? 'person' : 'people'} got as far as ${FAR[after]}. Take one off ${GAUGE_LABELS[after]} first.`,
      };
    }
    // Only reachable with counts that are not a funnel (never stored: normaliseTally): never go below 0.
    const empty = stages.find((k) => counts[k] <= 0);
    if (empty) return { ok: false, counts, hint: `${GAUGE_LABELS[empty]} is already 0.` };
  }
  const next: GaugeTotals = { ...counts };
  for (const k of stages) next[k] += delta;
  return { ok: true, counts: next };
}

/**
 * Counts read back from storage (or anywhere untrusted) as a valid funnel: each value becomes a whole number from 0 to
 * `max`, then no stage may exceed the one above it (a stage that does is lowered to it). Never throws.
 */
export function normaliseTally(raw: unknown, max: number = GAUGE_MAX_PER_DAY): GaugeTotals {
  const src = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const out = {} as GaugeTotals;
  let ceiling = max;
  for (const k of GAUGE_KEYS) {
    const v = src[k];
    const n = typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : 0;
    out[k] = Math.min(Math.max(n, 0), ceiling);
    ceiling = out[k];
  }
  return out;
}
