// Sales-tile streak hint — OWNED BY p2-personal-pace-streaks.
// The dashboard puts this hint second on the Sales tile, after the rank ("#3 of 9 in your team · 12-day sales
// streak · best 26"; the Sales tile lets its hint wrap to three lines), through PersonalKpis' safeStreakHint().
// Positive states only, never "streak broken"; one fragment at most:
//   current ≥ 3        → '12-day sales streak · best 26'
//   personalBestWeek   → 'Personal best week so far'
//   otherwise          → undefined
import type { Streaks } from '@lm/shared';

/** The Sales tile shows a streak from this many selling days in a row. */
export const STREAK_HINT_MIN = 3;

export function streakHint(streaks: Streaks | null | undefined): string | undefined {
  if (!streaks) return undefined;
  if (streaks.current >= STREAK_HINT_MIN) return `${streaks.current}-day sales streak · best ${Math.max(streaks.best, streaks.current)}`;
  if (streaks.personalBestWeek) return 'Personal best week so far';
  return undefined;
}

