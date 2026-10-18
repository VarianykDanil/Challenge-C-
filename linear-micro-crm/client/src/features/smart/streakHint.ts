// Sales-tile streak hint — OWNED BY p2-personal-pace-streaks.
// Stub from p1: always undefined, so the Sales tile hint is unchanged. The dashboard joins the existing hint with this
// one ("Ranked #3 of 9 in your team · 12-day sales streak · best 26"). Positive states only, never "streak broken":
//   current ≥ 3        → '12-day sales streak · best 26'
//   personalBestWeek   → 'Personal best week so far'
//   otherwise          → undefined
import type { Streaks } from '@lm/shared';

export function streakHint(streaks: Streaks | null | undefined): string | undefined {
  void streaks;
  return undefined;
}

