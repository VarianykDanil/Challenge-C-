/**
 * Personal pace (baseline alerts + conversion direction) — OWNED BY p2-personal-pace-streaks.
 * Stub laid down by p1-foundation-contracts: the exported names and signatures are final; p2 replaces the bodies.
 *
 * personalPace runs ONE weeklyHistory call (16 completed weeks + current) for the caller and derives both parts:
 * the baseline from the last 8 weeks (shared personalBaselineFrom) and the direction from all 16 (conversionTrend).
 * /me/insights calls personalPace; the two single-purpose wrappers exist for other callers (digest, tests).
 * Only ever computed for the caller themself. Recruiters and new starters get nulls.
 */
import type { PersonalBaseline, TrendDirection, UserWithTeam } from '@lm/shared';
import type { Db } from '../../db/connection.ts';
import { smartEnabled } from './enabled.ts';

/** Completed weeks read for the direction (the baseline uses the newest 8 of them). */
export const PACE_HISTORY_WEEKS = 16;

export interface PersonalPace {
  baseline: PersonalBaseline | null;
  direction: TrendDirection | null;
}

export function personalPace(db: Db, me: UserWithTeam, today: string): PersonalPace {
  void db;
  void me;
  void today;
  if (!smartEnabled()) return { baseline: null, direction: null };
  return { baseline: null, direction: null };
}

export function personalBaseline(db: Db, me: UserWithTeam, today: string): PersonalBaseline | null {
  return personalPace(db, me, today).baseline;
}

export function trendDirection(db: Db, me: UserWithTeam, today: string): TrendDirection | null {
  return personalPace(db, me, today).direction;
}
