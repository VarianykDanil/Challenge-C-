/**
 * Release 1.3 — an event's roster (who is booked) and each booked person's plan — OWNED BY P8 venue-insights (laid down
 * by r3-foundation as a stub: reads empty, writes 501). Mounted at /events BEFORE the 1.0 events router
 * (routes/events.ts, also P8's in 1.3): only the paths below are answered here. Role checks are per route.
 *
 *  GET    /events/:id/plan[?userId=]   → EventPlan[] (yours; the event's leader / admin: everyone booked) — cached
 *  GET    /events/:id/roster           → EventBooking[]
 *  PUT    /events/:id/roster  EventRosterInput → EventBooking[] (the leader of the event's team / admin)
 *  POST   /events/:id/roster/me        → EventBooking[] ("I'm working this": a rep or leader of the event's team)
 *  DELETE /events/:id/roster/me        → EventBooking[]
 * Never creates a gauge row. Types: shared/src/types/venues.ts. Audit specs: lib/audit/venueSpecs.ts.
 */
import { Router } from 'express';
import type { EventBooking, EventPlan } from '@lm/shared';
import type { Db } from '../db/connection.ts';
import { HttpError } from '../lib/errors.ts';
import { currentUser, requireRole } from '../middleware/auth.ts';

const notYet = () => {
  throw new HttpError(501, 'Event bookings are not available yet');
};

export function eventPlansRouter(db: Db): Router {
  void db;
  const router = Router();
  router.get('/:id/plan', (req, res) => {
    currentUser(req);
    const rows: EventPlan[] = [];
    res.json(rows);
  });
  router.get('/:id/roster', (req, res) => {
    currentUser(req);
    const rows: EventBooking[] = [];
    res.json(rows);
  });
  router.put('/:id/roster', requireRole('admin', 'leader'), notYet);
  router.post('/:id/roster/me', requireRole('admin', 'leader', 'rep'), notYet);
  router.delete('/:id/roster/me', requireRole('admin', 'leader', 'rep'), notYet);
  return router;
}
