/**
 * Sales streaks and personal-best weeks — OWNED BY p2-personal-pace-streaks (stub and signatures laid down by p1).
 *
 * A worked day is a date with any gauge row; dates ≥ today are ignored (today is not over yet). A worked day with
 * ≥ 1 sale extends the run, one with 0 sales resets it; calendar days without gauges (days off, weekends, a week of
 * holiday) never break a streak. Positive states only: the UI never says "streak broken".
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

/**
 * Current and best run of worked days with at least one sale. `days` may be in any order and may repeat a date (its
 * sales are summed, so one person's rows on two events the same day count as one worked day).
 */
export function salesStreaks(days: ReadonlyArray<SalesDay>, today: string): SalesStreakResult {
  const byDate = new Map<string, number>();
  for (const d of days) {
    if (!(d.date < today)) continue;
    const sales = Number.isFinite(d.sales) ? d.sales : 0;
    byDate.set(d.date, (byDate.get(d.date) ?? 0) + sales);
  }
  const dates = [...byDate.keys()].sort();
  let run = 0;
  let best = 0;
  for (const date of dates) {
    run = byDate.get(date)! >= 1 ? run + 1 : 0;
    if (run > best) best = run;
  }
  return { current: run, best };
}

/** Weeks with at least this many worked days are the ones a personal best has to beat. */
export const PERSONAL_BEST_MIN_DAYS = 3;
/** …and at least this many of them must exist (a new starter's first good week is not a "best" yet). */
export const PERSONAL_BEST_MIN_WEEKS = 4;

/** True when `current.sales` beats every previous week with ≥ 3 worked days, and at least 4 such weeks exist. */
export function personalBestWeek(weeks: ReadonlyArray<Pick<WeekStat, 'sales' | 'days'>>, current: Pick<WeekStat, 'sales'>): boolean {
  const full = weeks.filter((w) => w.days >= PERSONAL_BEST_MIN_DAYS);
  if (full.length < PERSONAL_BEST_MIN_WEEKS) return false;
  return full.every((w) => current.sales > w.sales);
}
