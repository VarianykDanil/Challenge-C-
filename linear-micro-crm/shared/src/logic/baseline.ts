/**
 * Personal pace baseline — OWNED BY p2-personal-pace-streaks.
 * Stub laid down by p1-foundation-contracts: the exported names and signatures are final; p2 replaces the bodies.
 *
 * Contract: personalBaselineFrom(last 8 completed weeks, this week so far) → PersonalBaseline | null.
 * Null when fewer than BASELINE_RULES.minWeeks weeks have days > 0, or when μ < minStopsPerDay stops a day.
 */
import type { PersonalBaseline } from '../types.ts';
import type { WeekStat } from './stats.ts';

export const BASELINE_RULES = {
  windowWeeks: 8,
  minWeeks: 4,
  minStopsPerDay: 20,
  stopsZ: 1.5,
  minCurrentDays: 2,
  convZ: 2,
  minCurrentStops: 100,
} as const;

/** `weeks8`: the last 8 completed Mon–Sun weeks, oldest first, zero-filled; `current`: Monday up to yesterday. */
export function personalBaselineFrom(weeks8: ReadonlyArray<WeekStat>, current: WeekStat): PersonalBaseline | null {
  void weeks8;
  void current;
  return null;
}
