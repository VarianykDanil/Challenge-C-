/**
 * Release 1.2 — /checkins (one-tap shift check-in) — OWNED BY U4 check-ins.
 *
 *  POST   /checkins           ShiftCheckInInput → 201 ShiftCheckIn | 200 the existing one (idempotent per user+event+date)
 *  DELETE /checkins/:id       → 204 (self within 2 minutes; the leader of the person's team / admin any time)
 *  GET    /checkins?eventId=  → ShiftCheckInList (admin: everyone; leader: their team and themself; others: own only)
 *
 * Who checks in: reps and leaders at their own team's events, admins at any event (the gauge rule); recruiters never.
 * A check-in never creates, edits or reads into a gauge row and never counts as a day worked: pay counts distinct
 * gauge dates only. Punctuality (lib/shiftCheckIns.ts) prefers it over the gauge entry's own time, unless a leader or
 * admin recorded that time on the person's behalf. A time sent later from a phone is bounded (shared
 * resolveShiftCheckInTime: from 60 minutes before the start, sent within 24 hours of the end) and is always recorded
 * with source 'offline', so leaders see it as "sent later". Not the 1.1
 * "Check in with…" list (lib/smart/checkIns.ts). Types: shared/src/types/checkins.ts; rules: shared logic/shiftCheckIn.ts.
 */
import { Router } from 'express';
import { z } from 'zod';
import { canUndoShiftCheckIn, resolveShiftCheckInTime, SHIFT_CHECK_IN_SOURCES, SHIFT_CHECK_IN_UNDO_GRACE_MS, type ShiftCheckInList } from '@lm/shared';
import { run, type Db } from '../db/connection.ts';
import { getEvent } from '../db/queries.ts';
import { businessNow, formatShort, normaliseCheckIn, nowISO, toBusinessISO, todayISO } from '../lib/dates.ts';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.ts';
import { isAdmin } from '../lib/scope.ts';
import { canSeeShiftCheckIn, findShiftCheckIn, getShiftCheckIn, listShiftCheckIns, managesShiftCheckIn, toShiftCheckIn } from '../lib/shiftCheckIns.ts';
import { idParam, isoDate, isoTimestamp, optionalIdQuery } from '../lib/validate.ts';
import { currentUser } from '../middleware/auth.ts';

const checkInBody = z.object({
  eventId: z.number().int().positive(),
  date: isoDate.optional(),
  checkedInAt: isoTimestamp.optional(),
  source: z.enum(SHIFT_CHECK_IN_SOURCES).optional(),
});

export function checkinsRouter(db: Db): Router {
  const router = Router();

  router.get('/', (req, res) => {
    const me = currentUser(req);
    const eventId = optionalIdQuery(req.query.eventId, 'eventId');
    if (!eventId) throw badRequest('eventId is required');
    if (!getEvent(db, eventId)) throw notFound('Event');
    const nowMs = businessNow().getTime();
    const body: ShiftCheckInList = { eventId, checkIns: listShiftCheckIns(db, me, eventId).map((r) => toShiftCheckIn(r, me, nowMs)) };
    res.json(body);
  });

  router.post('/', (req, res) => {
    const me = currentUser(req);
    const body = checkInBody.parse(req.body);
    if (me.role === 'recruiter') throw forbidden('Check-in is for the people working at an event');
    const event = getEvent(db, body.eventId);
    if (!event) throw notFound('Event');
    if (!isAdmin(me) && (me.teamId === null || me.teamId !== event.teamId)) throw forbidden("You can only check in at your own team's events");
    if (event.status === 'cancelled') throw conflict('This event was cancelled, so there is nothing to check in to');

    let requested: string | null = null;
    if (body.checkedInAt !== undefined) {
      requested = normaliseCheckIn(body.checkedInAt);
      if (requested === null) throw badRequest('checkedInAt is not a valid time');
    }
    const date = body.date ?? (requested ? requested.slice(0, 10) : todayISO());
    if (date !== event.date) throw badRequest(`Check-ins are recorded on the event's day (${formatShort(event.date)})`);

    // Idempotent: the same person, event and day answers with the check-in already recorded (the first one stands),
    // whatever time this request carries — so a phone replaying a tap whose answer was lost is simply told "done".
    const existing = findShiftCheckIn(db, { userId: me.id, eventId: event.id, date });
    if (existing) {
      res.status(200).json(toShiftCheckIn(existing, me));
      return;
    }

    const time = resolveShiftCheckInTime({
      eventDate: event.date,
      startTime: event.startTime,
      endTime: event.endTime,
      requested,
      now: toBusinessISO(businessNow()),
      today: todayISO(),
    });
    if (!time.ok) throw badRequest(time.error);
    // 'offline' ("sent later" on the roll call) exactly when the phone supplied the time, whatever the request says:
    // a time from the phone is never shown to a leader as a live tap (review 1.2 S3). Without one it is Linear Hub's
    // own time, so a live tap from Quick gauges or anywhere else.
    const source = requested !== null ? 'offline' : body.source === 'quick' ? 'quick' : 'button';
    const r = run(
      db,
      `INSERT INTO check_ins (user_id, event_id, date, checked_in_at, source, created_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id, event_id, date) DO NOTHING`,
      [me.id, event.id, date, time.checkedInAt, source, nowISO()],
    );
    const row = findShiftCheckIn(db, { userId: me.id, eventId: event.id, date })!;
    res.status(r.changes > 0 ? 201 : 200).json(toShiftCheckIn(row, me));
  });

  router.delete('/:id', (req, res) => {
    const me = currentUser(req);
    const id = idParam(req);
    const row = getShiftCheckIn(db, id);
    // Someone else's check-in outside your scope does not exist as far as you are concerned.
    if (!row || !canSeeShiftCheckIn(me, row)) throw notFound('Check-in');
    if (!managesShiftCheckIn(me, row) && !canUndoShiftCheckIn(row.createdAt, businessNow().getTime(), SHIFT_CHECK_IN_UNDO_GRACE_MS)) {
      throw forbidden('The 2 minutes to undo a check-in have passed — ask your team leader to remove it');
    }
    run(db, `DELETE FROM check_ins WHERE id = ?`, [id]);
    res.status(204).end();
  });

  return router;
}
