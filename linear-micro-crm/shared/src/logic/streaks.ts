/**
 * Sales streaks and personal-best weeks — OWNED BY p2-personal-pace-streaks.
 * Stub laid down by p1-foundation-contracts: the exported names and signatures are final; p2 replaces the bodies.
 *
 * A worked day is a date with any gauge row; dates ≥ today are ignored. A worked day with ≥ 1 sale extends the run,
 * one with 0 sales resets it; calendar days without gauges never break a streak.
 */
import type { WeekStat } from './stats.ts';

/** One worked date and the sales logged on it. */
export interface SalesDay {
  date: string;
  sales: number;
}

export interface SalesStreakResult {
  /** The run ending at the last worked day before today. */
  current: number;
  /** The longest run in `days`. */
  best: number;
}

export function salesStreaks(days: ReadonlyArray<SalesDay>, today: string): SalesStreakResult {
  void days;
  void today;
  return { current: 0, best: 0 };
}

/** True when `current.sales` beats every previous week with ≥ 3 worked days, and at least 4 such weeks exist. */
export function personalBestWeek(weeks: ReadonlyArray<Pick<WeekStat, 'sales' | 'days'>>, current: Pick<WeekStat, 'sales'>): boolean {
  void weeks;
  void current;
  return false;
}
