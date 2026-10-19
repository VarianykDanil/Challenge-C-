/**
 * Event forecasts and suggested targets — OWNED BY p6-event-forecasts-roster (stub signatures laid down by p1).
 *
 * Pure: the server (lib/smart/eventForecast.ts) gathers comparable completed days with two grouped queries and hands
 * the buckets here; the client reuses the small helpers (repsNeededFor, scheduledFlag) for the New event form.
 * See docs/smart/p6-event-forecasts-roster.md and LOGIC.md §14.6.
 */
import { EVENT_MAX_TARGET_SALES } from '../constants.ts';
import type { EventForecast, EventStatus } from '../types.ts';
import { addDays } from './dates.ts';
import { quantile } from './stats.ts';

export const EVENT_FORECAST_RULES = {
  attendanceWeeks: 8,
  rateWeeks: 12,
  minBasisDays: 5,
  z: 1.64,
  stretch: 1.3,
  atRisk: 0.7,
  targetPercentile: 0.6,
} as const;

/** "4 / 7 logged" covers completed and live events from this many days back to today (older gaps are history). */
export const EVENT_ROSTER_LOOKBACK_DAYS = 2;

/** Completed or live events dated today − 2 … today: the window where a missing entry is still worth chasing. */
export function inRosterWindow(e: { status: EventStatus; date: string }, today: string): boolean {
  return (e.status === 'completed' || e.status === 'live') && e.date <= today && e.date >= addDays(today, -EVENT_ROSTER_LOOKBACK_DAYS);
}

/** Sales and rep-days of comparable completed events, at one level of the fallback chain. */
export interface RateBucket {
  basis: EventForecast['basis'];
  /** Distinct completed events in the bucket. */
  events: number;
  sales: number;
  repDays: number;
}

/** The fallback chain: team (same campaign + type) → company (campaign + type) → campaign alone. */
export interface RateBuckets {
  team?: RateBucket | null;
  company?: RateBucket | null;
  campaign?: RateBucket | null;
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;

/** The first bucket in fallback order with ≥ EVENT_FORECAST_RULES.minBasisDays distinct completed events, else null. */
export function pickRate(buckets: RateBuckets): RateBucket | null {
  for (const b of [buckets.team, buckets.company, buckets.campaign]) {
    if (b && b.events >= EVENT_FORECAST_RULES.minBasisDays && b.repDays > 0) return b;
  }
  return null;
}

export interface EventForecastInput {
  /** Mean distinct reps over the team's recent completed events; null with fewer than 5 such events. */
  expectedReps: number | null;
  bucket: RateBucket | null;
  targetSales: number;
  status: EventStatus;
  /** "HH:MM" */
  startTime: string;
  endTime: string;
  nowHHMM: string;
  salesSoFar: number;
  /** The team's per-event sales for this campaign + type over the rate window (suggestedTarget). */
  teamEventSales: ReadonlyArray<number>;
}

/** Minutes since midnight of an "HH:MM" string (NaN when malformed). */
function minutesOf(hhmm: string): number {
  const m = /^(\d{1,2}):(\d{2})/.exec(hhmm);
  return m ? Number(m[1]) * 60 + Number(m[2]) : Number.NaN;
}

/**
 * Share of a live event still to come: clamp((end − now) ÷ (end − start), 0, 1). Before the start it is 1; after the
 * end (or with a malformed / zero-length window) it is 0.
 */
export function remainingFraction(startTime: string, endTime: string, nowHHMM: string): number {
  const start = minutesOf(startTime);
  const end = minutesOf(endTime);
  const now = minutesOf(nowHHMM);
  if (![start, end, now].every(Number.isFinite) || end <= start) return 0;
  return Math.min(1, Math.max(0, (end - now) / (end - start)));
}

/** Reps a target needs at a per-rep rate: ceil(target ÷ rate); null when there is no rate to divide by. */
export function repsNeededFor(targetSales: number, perRepRate: number): number | null {
  if (!(perRepRate > 0) || !Number.isFinite(targetSales) || targetSales < 0) return null;
  // the epsilon keeps an exact multiple exact (17 ÷ (17 ÷ 7) is 7.000000000000001 in floating point)
  return Math.max(0, Math.ceil(targetSales / perRepRate - 1e-9));
}

/** Scheduled events: 'stretch' when the target is above 1.3 × the expected sales, else null. */
export function scheduledFlag(targetSales: number, expectedSales: number): 'stretch' | null {
  return targetSales > EVENT_FORECAST_RULES.stretch * expectedSales ? 'stretch' : null;
}

/**
 * Live events: 'at_risk' (shown as "Behind target") when what is in plus what the rest of the day should bring
 * (salesSoFar + E × remainingFraction) falls short of 0.7 × the target.
 */
export function liveFlag(targetSales: number, expectedSales: number, salesSoFar: number, remaining: number): 'at_risk' | null {
  return salesSoFar + expectedSales * remaining < EVENT_FORECAST_RULES.atRisk * targetSales ? 'at_risk' : null;
}

/**
 * Suggested target: round(p60) of the team's per-event sales for this campaign + type when there are ≥ 5 such
 * events, else round(E). Kept within 0…EVENT_MAX_TARGET_SALES (the form's own limits).
 */
export function suggestedTargetFrom(teamEventSales: ReadonlyArray<number>, expectedSales: number): number {
  const raw = teamEventSales.length >= EVENT_FORECAST_RULES.minBasisDays ? quantile(teamEventSales, EVENT_FORECAST_RULES.targetPercentile) : expectedSales;
  return Math.min(EVENT_MAX_TARGET_SALES, Math.max(0, Math.round(raw)));
}

/**
 * E = expectedReps × perRepRate with a Poisson band E ± 1.64√E. Null when there is no bucket or expectedReps is null
 * (or either is empty). Only scheduled and live events carry a flag; other statuses get flag null.
 */
export function eventForecastFrom(input: EventForecastInput): EventForecast | null {
  const { expectedReps, bucket } = input;
  if (!bucket || expectedReps == null || !(expectedReps > 0) || !(bucket.repDays > 0)) return null;
  const perRepRate = bucket.sales / bucket.repDays;
  const e = expectedReps * perRepRate;
  const band = EVENT_FORECAST_RULES.z * Math.sqrt(e);
  const target = Math.max(0, input.targetSales);
  let flag: EventForecast['flag'] = null;
  if (input.status === 'scheduled') flag = scheduledFlag(target, e);
  else if (input.status === 'live') flag = liveFlag(target, e, Math.max(0, input.salesSoFar), remainingFraction(input.startTime, input.endTime, input.nowHHMM));
  return {
    expectedSales: round1(e),
    low: round1(Math.max(0, e - band)),
    high: round1(e + band),
    expectedReps: round1(expectedReps),
    perRepRate: round2(perRepRate),
    repsNeeded: repsNeededFor(target, perRepRate),
    basisDays: bucket.events,
    basis: bucket.basis,
    flag,
    suggestedTarget: suggestedTargetFrom(input.teamEventSales, e),
  };
}
