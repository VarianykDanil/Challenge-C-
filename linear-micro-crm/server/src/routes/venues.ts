/**
 * Release 1.3 — /venues (every venue's numbers, to prove the law of averages) — every staff role; reps see aggregated
 * numbers only, never other named reps' rows — OWNED BY P8 venue-insights.
 *
 *  GET /venues?sort=sales_per_shift|shifts|last_visit → VenueSummary[] (default sales_per_shift) — cached
 *  GET /venues/:key                                   → VenueProfile (key = shared venueKey(venue, city)) — cached
 *      400 "Invalid venue" unless isVenueKey(key); 404 "Venue not found" when no event was ever held there.
 * The client guard keeps client accounts out (403) before this router runs. Builders: lib/venueInsights.ts; maths:
 * shared/src/logic/venues.ts. Types: shared/src/types/venues.ts. Read-only.
 */
import { Router } from 'express';
import { VENUE_SORTS, isVenueKey, sortVenues, type VenueSortKey } from '@lm/shared';
import type { Db } from '../db/connection.ts';
import { todayISO } from '../lib/dates.ts';
import { badRequest, notFound } from '../lib/errors.ts';
import { optionalString } from '../lib/validate.ts';
import { venueProfile, venueSummaries } from '../lib/venueInsights.ts';
import { currentUser } from '../middleware/auth.ts';

export function venuesRouter(db: Db): Router {
  const router = Router();
  router.get('/', (req, res) => {
    currentUser(req);
    const sort = optionalString(req.query.sort) ?? 'sales_per_shift';
    if (!VENUE_SORTS.includes(sort as VenueSortKey)) throw badRequest('Invalid sort');
    res.json(sortVenues(venueSummaries(db, todayISO()), sort as VenueSortKey));
  });
  router.get('/:key', (req, res) => {
    const me = currentUser(req);
    const key = String(req.params.key ?? '');
    if (!isVenueKey(key)) throw badRequest('Invalid venue');
    const profile = venueProfile(db, key, me, todayISO());
    if (!profile) throw notFound('Venue');
    res.json(profile);
  });
  return router;
}
