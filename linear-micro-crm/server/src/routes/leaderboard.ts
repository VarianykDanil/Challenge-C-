import { Router } from 'express';
import { z } from 'zod';
import type { Db } from '../db/connection.ts';
import { previousToDateRange, rangeForPeriod, todayISO } from '../lib/dates.ts';
import { rankedBoard } from '../lib/metrics.ts';
import { optionalIdQuery } from '../lib/validate.ts';
import { currentUser } from '../middleware/auth.ts';

const query = z.object({
  period: z.enum(['week', 'month', 'quarter']).default('week'),
  metric: z.enum(['sales', 'conversion']).default('sales'),
});

/** Enough rows for every ranked person in a 30-odd person company; `X-Total-Count` carries the true total. */
const MAX_ROWS = 200;

export function leaderboardRouter(db: Db): Router {
  const router = Router();
  router.get('/', (req, res) => {
    const me = currentUser(req);
    const { period, metric } = query.parse({ period: req.query.period, metric: req.query.metric });
    let teamId = optionalIdQuery(req.query.teamId, 'teamId');
    if (me.role === 'rep') {
      if (me.teamId === null) {
        res.setHeader('X-Total-Count', '0');
        return res.json([]);
      }
      teamId = me.teamId;
    }
    const { from, to } = rangeForPeriod(period, todayISO());
    // movement compares with the same to-date span of the previous week / month / quarter
    const { rows, total } = rankedBoard(db, { from, to, previous: previousToDateRange(period, { from, to }), teamId, metric, limit: MAX_ROWS });
    res.setHeader('X-Total-Count', String(total));
    res.json(rows);
  });
  return router;
}
