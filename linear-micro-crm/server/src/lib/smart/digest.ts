/**
 * "Your week in review" builder — OWNED BY p9-week-in-review-digest.
 * Stub laid down by p1-foundation-contracts: the exported names and signatures are final; p9 replaces the bodies.
 *
 * weekDigest(db, me, monday, today): the caller's digest for the completed Mon–Sun week starting `monday` (the route
 * has already validated and normalised it). Figures come only from existing functions (totalsFor, rankedBoard,
 * weekPayFor / the stored run, coachingInsights, recruitmentSummary, eventForecasts, checkInList count) so they never
 * contradict the tiles. With LM_SMART=0 (and in this stub) bullets are [] and text is ''.
 */
import type { UserWithTeam, WeekDigest } from '@lm/shared';
import type { Db } from '../../db/connection.ts';
import { addDays, formatWeek } from '../dates.ts';
import { smartEnabled } from './enabled.ts';

/** The empty digest for a week: the title only, no bullets (also the LM_SMART=0 answer). */
export function emptyDigest(me: Pick<UserWithTeam, 'role'>, monday: string): WeekDigest {
  return { weekStart: monday, weekEnd: addDays(monday, 6), role: me.role, title: `Your week in review · ${formatWeek(monday)}`, bullets: [], text: '' };
}

export function weekDigest(db: Db, me: UserWithTeam, monday: string, today: string): WeekDigest {
  void db;
  void today;
  if (!smartEnabled()) return emptyDigest(me, monday);
  return emptyDigest(me, monday);
}
