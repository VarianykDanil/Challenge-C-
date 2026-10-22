/**
 * Release 1.3 — an event's roster (who is booked) and each booked person's plan — OWNED BY P8 venue-insights. Mounted
 * at /events BEFORE the 1.0 events router (routes/events.ts, also P8's in 1.3): only the paths below are answered
 * here. Role checks are per route; the client guard keeps client accounts out before any of them.
 *
 *  GET    /events/:id/plan[?userId=]   → EventPlan[] — cached. The admin and the leader of the event's team: everyone
 *                                         booked (or `userId`'s plan); anyone else: their own plan when booked (another
 *                                         person's userId → 403). Scheduled and live events only; [] otherwise and with
 *                                         LM_SMART=0 (a plan is an estimate). People who have left are not listed.
 *                                         The leader's view of someone the office booked from another team is built
 *                                         from the venue's numbers only (`limited`: no own ratios, no good day).
 *  GET    /events/:id/roster           → EventBooking[] (every staff role: event pages already name who logged)
 *  PUT    /events/:id/roster  EventRosterInput → EventBooking[] (the admin, or the leader of the event's team): the whole
 *                                         list { userIds }, or the changes { add, remove } (Edit bookings sends these,
 *                                         so a self-booking made meanwhile is kept)
 *  POST   /events/:id/roster/me        → EventBooking[] ("I'm working this": the admin; a leader or rep of the team)
 *  DELETE /events/:id/roster/me        → EventBooking[] ("I can't make it": anyone booked)
 * Bookings are open while the event is scheduled or live and dated today or later (409 otherwise). Rules:
 * lib/eventRoster.ts; plans: lib/venueInsights.ts. Never creates a gauge row. Audit specs: lib/audit/venueSpecs.ts.
 */
import { Router } from 'express';
import { z } from 'zod';
import type { EventPlan } from '@lm/shared';
import type { Db } from '../db/connection.ts';
import { getEvent } from '../db/queries.ts';
import { todayISO } from '../lib/dates.ts';
import { forbidden, notFound } from '../lib/errors.ts';
import { ROSTER_MAX_PEOPLE, bookSelf, changeRoster, listRoster, rosterPeople, saveRoster, unbookSelf } from '../lib/eventRoster.ts';
import { canManageTeam } from '../lib/scope.ts';
import { smartEnabled } from '../lib/smart/enabled.ts';
import { idParam, optionalIdQuery } from '../lib/validate.ts';
import { eventPlansFor } from '../lib/venueInsights.ts';
import { currentUser, requireRole } from '../middleware/auth.ts';

const ids = z.array(z.number().int().positive()).max(ROSTER_MAX_PEOPLE);
/** The whole list ({ userIds }), or the changes Edit bookings made ({ add, remove }: nobody else is touched). */
const rosterBody = z.union([
  z.object({ userIds: ids }).strict(),
  z
    .object({ add: ids.optional(), remove: ids.optional() })
    .strict()
    .refine((b) => b.add !== undefined || b.remove !== undefined, 'Send userIds, or the changes: add and remove'),
]);

export function eventPlansRouter(db: Db): Router {
  const router = Router();
  const eventOr404 = (id: number) => {
    const event = getEvent(db, id);
    if (!event) throw notFound('Event');
    return event;
  };

  router.get('/:id/plan', (req, res) => {
    const me = currentUser(req);
    const event = eventOr404(idParam(req));
    const userId = optionalIdQuery(req.query.userId, 'userId');
    const manage = canManageTeam(me, event.teamId);
    if (userId !== undefined && userId !== me.id && !manage) throw forbidden('You can only see your own plan');
    const none: EventPlan[] = [];
    if (!smartEnabled() || (event.status !== 'scheduled' && event.status !== 'live')) return res.json(none);
    const booked = rosterPeople(db, event.id);
    const wanted = userId !== undefined ? booked.filter((p) => p.userId === userId) : manage ? booked : booked.filter((p) => p.userId === me.id);
    // a leader reading the plan of someone booked from another team gets the venue-only plan (lib/venueInsights.ts)
    res.json(eventPlansFor(db, event, wanted, me, todayISO()));
  });

  router.get('/:id/roster', (req, res) => {
    currentUser(req);
    const event = eventOr404(idParam(req));
    res.json(listRoster(db, event.id));
  });

  router.put('/:id/roster', requireRole('admin', 'leader'), (req, res) => {
    const me = currentUser(req);
    const event = eventOr404(idParam(req));
    if (!canManageTeam(me, event.teamId)) throw forbidden("Leaders can only book people on their own team's events");
    const body = rosterBody.parse(req.body);
    res.json('userIds' in body ? saveRoster(db, me, event, body.userIds) : changeRoster(db, me, event, body.add ?? [], body.remove ?? []));
  });

  router.post('/:id/roster/me', requireRole('admin', 'leader', 'rep'), (req, res) => {
    const me = currentUser(req);
    res.json(bookSelf(db, me, eventOr404(idParam(req))));
  });

  router.delete('/:id/roster/me', requireRole('admin', 'leader', 'rep'), (req, res) => {
    const me = currentUser(req);
    res.json(unbookSelf(db, me, eventOr404(idParam(req))));
  });

  return router;
}
