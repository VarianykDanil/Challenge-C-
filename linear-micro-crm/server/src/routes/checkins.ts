/**
 * Release 1.2 — /checkins (one-tap shift check-in) — OWNED BY U4 check-ins (laid down by r2-foundation as a stub).
 *
 *  POST   /checkins           ShiftCheckInInput → 201 ShiftCheckIn | 200 the existing one (idempotent per user+event+date)
 *  DELETE /checkins/:id       → 204 (self within 2 minutes; leader of the team / admin any time)
 *  GET    /checkins?eventId=  → ShiftCheckInList (leader / admin: the event's people in scope; rep: own only)
 * Never creates a gauge row. Not the 1.1 "Check in with…" list (lib/smart/checkIns.ts). Types: shared/src/types/checkins.ts.
 */
import { Router } from 'express';
import type { ShiftCheckInList } from '@lm/shared';
import type { Db } from '../db/connection.ts';
import { HttpError, badRequest } from '../lib/errors.ts';
import { optionalIdQuery } from '../lib/validate.ts';
import { currentUser } from '../middleware/auth.ts';

export function checkinsRouter(db: Db): Router {
  void db;
  const router = Router();
  // STUB (U4): nobody has checked in yet.
  router.get('/', (req, res) => {
    currentUser(req);
    const eventId = optionalIdQuery(req.query.eventId, 'eventId');
    if (!eventId) throw badRequest('eventId is required');
    const body: ShiftCheckInList = { eventId, checkIns: [] };
    res.json(body);
  });
  router.post('/', () => {
    throw new HttpError(501, 'Check-in is not available yet');
  });
  router.delete('/:id', () => {
    throw new HttpError(501, 'Check-in is not available yet');
  });
  return router;
}
