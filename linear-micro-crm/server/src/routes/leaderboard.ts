import { Router } from 'express';
import { z } from 'zod';
import { previousRange } from '@lm/shared';
import type { Db } from '../db/connection.ts';
import { rangeForPeriod } from '../lib/dates.ts';
import { leaderboard } from '../lib/metrics.ts';
import { optionalIdQuery } from '../lib/validate.ts';
import { currentUser } from '../middleware/auth.ts';

const query = z.object({
  period: z.enum(['week', 'month', 'quarter']).default('week'),
  metric: z.enum(['sales', 'conversion']).default('sales'),
});

export function leaderboardRouter(db: Db): Router {
  const router = Router();
  router.get('/', (req, res) => {
    const me = currentUser(req);
    const { period, metric } = query.parse({ period: req.query.period, metric: req.query.metric });
    let teamId = optionalIdQuery(req.query.teamId, 'teamId');
    if (me.role === 'rep') {
      if (me.teamId === null) return res.json([]);
      teamId = me.teamId;
    }
    const { from, to } = rangeForPeriod(period);
    res.json(leaderboard(db, { from, to, previous: previousRange({ from, to }), teamId, metric, limit: 25 }));
  });
  return router;
}
