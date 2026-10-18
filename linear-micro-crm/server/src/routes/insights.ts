/**
 * GET /me/insights → SmartInsights (p1). Composes the lib/smart builders into one cached payload for the dashboard.
 * Scoping lives HERE, not in the builders' callers:
 *  - personal      the caller only (pace, streaks, pay forecast);
 *  - boardStreaks  rep / leader: own team; admin: every active rep and leader; recruiter: [] (rule kept by p2);
 *  - team          leader with a team only: checkInList(own team, excluding the leader);
 *  - company       admin only: checkInList(every team, excluding the admin);
 *  - reps and recruiters always get team: null and company: null.
 * LM_SMART=0 → every part null / [] (the shape stays the same).
 */
import { Router } from 'express';
import type { SmartInsights, UserWithTeam } from '@lm/shared';
import type { Db } from '../db/connection.ts';
import { todayISO } from '../lib/dates.ts';
import { personalPace } from '../lib/smart/baseline.ts';
import { checkInList } from '../lib/smart/checkIns.ts';
import { smartEnabled } from '../lib/smart/enabled.ts';
import { weekPayForecast } from '../lib/smart/payForecast.ts';
import { boardStreaks, personalStreaks } from '../lib/smart/streaks.ts';
import { currentUser } from '../middleware/auth.ts';

export function emptyInsights(today: string): SmartInsights {
  return {
    generatedFor: today,
    personal: { baseline: null, direction: null, streaks: null, payForecast: null },
    boardStreaks: [],
    team: null,
    company: null,
  };
}

export function buildInsights(db: Db, me: UserWithTeam, today: string): SmartInsights {
  if (!smartEnabled()) return emptyInsights(today);
  const pace = personalPace(db, me, today);
  return {
    generatedFor: today,
    personal: {
      baseline: pace.baseline,
      direction: pace.direction,
      streaks: personalStreaks(db, me, today),
      payForecast: weekPayForecast(db, me, today),
    },
    boardStreaks: me.role === 'recruiter' ? [] : boardStreaks(db, me, today),
    team: me.role === 'leader' && me.teamId !== null ? { checkIns: checkInList(db, { teamId: me.teamId, excludeUserId: me.id }, today) } : null,
    company: me.role === 'admin' ? { checkIns: checkInList(db, { teamId: null, excludeUserId: me.id }, today) } : null,
  };
}

export function insightsRouter(db: Db): Router {
  const router = Router();
  router.get('/insights', (req, res) => {
    res.json(buildInsights(db, currentUser(req), todayISO()));
  });
  return router;
}
