/**
 * Personal pace (baseline alerts + conversion direction) — OWNED BY p2-personal-pace-streaks (stub and signatures
 * laid down by p1).
 *
 * personalPace runs ONE weeklyHistory call (16 completed weeks + current) for the caller and derives both parts:
 * the baseline from the last 8 weeks (shared personalBaselineFrom) and the direction from all 16 (conversionTrend).
 * /me/insights calls personalPace; the two single-purpose wrappers exist for other callers (digest, tests).
 * Only ever computed for the caller themself. Recruiters and new starters get nulls.
 * "Completed" (weeklyHistory): rows dated today or later and rows on an event still 'live' never count.
 */
import { BASELINE_RULES, conversionTrend, personalBaselineFrom, type PersonalBaseline, type TrendDirection, type UserWithTeam } from '@lm/shared';
import type { Db } from '../../db/connection.ts';
import { weeklyHistory } from '../history.ts';
import { smartEnabled } from './enabled.ts';

/** Completed weeks read for the direction (the baseline uses the newest 8 of them). */
export const PACE_HISTORY_WEEKS = 16;

export interface PersonalPace {
  baseline: PersonalBaseline | null;
  direction: TrendDirection | null;
}

const NONE: PersonalPace = { baseline: null, direction: null };

export function personalPace(db: Db, me: UserWithTeam, today: string): PersonalPace {
  if (!smartEnabled()) return { ...NONE };
  // Recruiters never log gauges; their card stays exactly as it was.
  if (me.role === 'recruiter') return { ...NONE };
  const history = weeklyHistory(db, { userIds: [me.id] }, PACE_HISTORY_WEEKS, today).get(me.id);
  if (!history) return { ...NONE };
  return {
    baseline: personalBaselineFrom(history.weeks.slice(-BASELINE_RULES.windowWeeks), history.current),
    direction: conversionTrend(history.weeks),
  };
}

export function personalBaseline(db: Db, me: UserWithTeam, today: string): PersonalBaseline | null {
  return personalPace(db, me, today).baseline;
}

export function trendDirection(db: Db, me: UserWithTeam, today: string): TrendDirection | null {
  return personalPace(db, me, today).direction;
}
