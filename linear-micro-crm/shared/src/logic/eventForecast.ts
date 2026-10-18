/**
 * Event forecasts and suggested targets — OWNED BY p6-event-forecasts-roster.
 * Stub laid down by p1-foundation-contracts: the exported names and signatures are final; p6 replaces the bodies.
 */
import type { EventForecast, EventStatus } from '../types.ts';

export const EVENT_FORECAST_RULES = {
  attendanceWeeks: 8,
  rateWeeks: 12,
  minBasisDays: 5,
  z: 1.64,
  stretch: 1.3,
  atRisk: 0.7,
  targetPercentile: 0.6,
} as const;

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

/** The first bucket in fallback order with ≥ EVENT_FORECAST_RULES.minBasisDays distinct completed events, else null. */
export function pickRate(buckets: RateBuckets): RateBucket | null {
  void buckets;
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

/** Null when there is no bucket or expectedReps is null. */
export function eventForecastFrom(input: EventForecastInput): EventForecast | null {
  void input;
  return null;
}
