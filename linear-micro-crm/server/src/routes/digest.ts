/**
 * GET /me/digest?week=YYYY-MM-DD → WeekDigest — OWNED BY p9-week-in-review-digest (laid down by p1).
 * Mounted under /me and cached per user through CACHED_PATHS (20 s, cleared by any write). Any date normalises to its
 * Monday; the default is the last completed week; a week that has not finished yet, or one before 2020, → 400.
 * The bullets come from lib/smart/digest.ts (facts from the tiles' own functions, worded by shared logic/digest.ts).
 * LM_SMART=0 → the empty digest (title, no bullets, text '').
 */
import { Router } from 'express';
import { z } from 'zod';
import type { Db } from '../db/connection.ts';
import { addDays, mondayOf, sundayOf, todayISO } from '../lib/dates.ts';
import { badRequest } from '../lib/errors.ts';
import { emptyDigest, weekDigest } from '../lib/smart/digest.ts';
import { smartEnabled } from '../lib/smart/enabled.ts';
import { MIN_RANGE_DATE, isoDate } from '../lib/validate.ts';
import { currentUser } from '../middleware/auth.ts';

const digestQuery = z.object({ week: isoDate.optional() });

/** The Monday of the requested week (default: the last completed week); throws 400 for unfinished or pre-2020 weeks. */
export function digestWeek(query: unknown, today: string): string {
  const { week } = digestQuery.parse(query);
  const monday = week ? mondayOf(week) : addDays(mondayOf(today), -7);
  if (monday < MIN_RANGE_DATE) throw badRequest(`Weeks before ${MIN_RANGE_DATE} are not supported`);
  if (sundayOf(monday) >= today) throw badRequest('That week has not finished yet');
  return monday;
}

export function digestRouter(db: Db): Router {
  const router = Router();
  router.get('/digest', (req, res) => {
    const me = currentUser(req);
    const today = todayISO();
    const monday = digestWeek(req.query, today);
    res.json(smartEnabled() ? weekDigest(db, me, monday, today) : emptyDigest(me, monday));
  });
  return router;
}
