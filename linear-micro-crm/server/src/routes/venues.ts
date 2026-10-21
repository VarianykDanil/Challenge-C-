/**
 * Release 1.3 — /venues (every venue's numbers, to prove the law of averages) — every staff role; reps see aggregated
 * numbers only, never other named reps' rows — OWNED BY P8 venue-insights (laid down by r3-foundation as a stub).
 *
 *  GET /venues?sort=sales_per_shift|shifts|last_visit → VenueSummary[] — cached
 *  GET /venues/:key                                   → VenueProfile (key = shared venueKey(venue, city)) — cached
 * Types: shared/src/types/venues.ts.
 */
import { Router } from 'express';
import { isVenueKey, type VenueSummary } from '@lm/shared';
import type { Db } from '../db/connection.ts';
import { badRequest, notFound } from '../lib/errors.ts';
import { currentUser } from '../middleware/auth.ts';

export function venuesRouter(db: Db): Router {
  void db;
  const router = Router();
  router.get('/', (req, res) => {
    currentUser(req);
    const rows: VenueSummary[] = [];
    res.json(rows);
  });
  router.get('/:key', (req) => {
    currentUser(req);
    if (!isVenueKey(String(req.params.key ?? ''))) throw badRequest('Invalid venue');
    throw notFound('Venue');
  });
  return router;
}
