import { Router, type Request } from 'express';
import { z } from 'zod';
import { validateGaugeFunnel, type GaugeTotals, type SalesEventWithMeta, type UserWithTeam } from '@lm/shared';
import { get, run, type Db } from '../db/connection.ts';
import { Where, getEvent, getGauge, getUser, listGauges } from '../db/queries.ts';
import { mondayOf, normaliseCheckIn, nowISO, todayISO } from '../lib/dates.ts';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.ts';
import { summaryRows, type SummaryGroup } from '../lib/metrics.ts';
import { assertCanWriteGauge, canManageTeam, isAdmin } from '../lib/scope.ts';
import { idParam, isoDate, isoTimestamp, limitQuery, nonNegativeInt, optionalIdQuery, parseRange } from '../lib/validate.ts';
import { currentUser } from '../middleware/auth.ts';

const gaugeBody = z.object({
  /** Optional on POST: the entry the client believes it is editing. A key that resolves to another entry is refused (409). */
  id: z.number().int().positive().optional(),
  eventId: z.number().int().positive(),
  userId: z.number().int().positive(),
  date: isoDate,
  stops: nonNegativeInt,
  table: nonNegativeInt,
  presentations: nonNegativeInt,
  closes: nonNegativeInt,
  taps: nonNegativeInt,
  sales: nonNegativeInt,
  checkedInAt: isoTimestamp.nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
});

const GROUPS: SummaryGroup[] = ['user', 'team', 'campaign', 'day', 'week'];

function assertFunnel(t: GaugeTotals): void {
  const warnings = validateGaugeFunnel(t);
  if (warnings.length) throw badRequest('Invalid funnel', warnings);
}

/**
 * Data-integrity rules for gauge writes (checked after the role scoping in `assertCanWriteGauge`). Every aggregate —
 * leaderboards, finance, the live pay estimate — groups on the entry date, so an entry must describe the one day
 * the event actually ran: the date is the event's date, the event has happened and was not cancelled, and the person
 * logged belongs to the event's team (admins are exempt from the team rule; the owner works any team's events).
 */
function assertGaugeIntegrity(me: UserWithTeam, target: UserWithTeam, event: SalesEventWithMeta, date: string, opts: { checkUser: boolean }): void {
  if (event.status === 'cancelled') throw conflict('Gauges cannot be recorded for a cancelled event');
  if (event.date > todayISO()) throw badRequest('Gauges cannot be recorded before the event takes place');
  if (date !== event.date) throw badRequest("Gauges are recorded against the event's date");
  if (opts.checkUser && target.status !== 'active') throw badRequest('Gauges can only be recorded for active users');
  if (!isAdmin(me) && target.teamId !== event.teamId) throw badRequest("The user is not a member of the event's team");
}

/** Common filters for GET /gauges and GET /gauges/summary. */
function gaugeFilters(req: Request, where: Where, defaultRange: boolean): void {
  const userId = optionalIdQuery(req.query.userId, 'userId');
  const eventId = optionalIdQuery(req.query.eventId, 'eventId');
  const teamId = optionalIdQuery(req.query.teamId, 'teamId');
  const campaignId = optionalIdQuery(req.query.campaignId, 'campaignId');
  if (userId) where.add('g.user_id = ?', userId);
  if (eventId) where.add('g.event_id = ?', eventId);
  if (teamId) where.add('u.team_id = ?', teamId);
  if (campaignId) where.add('e.campaign_id = ?', campaignId);
  const hasRange = req.query.from !== undefined || req.query.to !== undefined;
  if (hasRange || (defaultRange && !eventId)) {
    const today = todayISO();
    const { from, to } = parseRange(req.query, { from: mondayOf(today), to: today });
    where.add('g.date BETWEEN ? AND ?', from, to);
  }
}

export function gaugesRouter(db: Db): Router {
  const router = Router();

  router.get('/', (req, res) => {
    const me = currentUser(req);
    const where = new Where();
    gaugeFilters(req, where, true);
    if (me.role === 'rep') {
      const userId = optionalIdQuery(req.query.userId, 'userId');
      if (userId && userId !== me.id) throw forbidden('Reps can only view their own gauges');
      where.add('g.user_id = ?', me.id);
    }
    res.json(listGauges(db, `${where}`, where.params, 'g.date DESC, g.submitted_at DESC', limitQuery(req.query.limit)));
  });

  router.get('/summary', (req, res) => {
    const me = currentUser(req);
    const groupBy = String(req.query.groupBy ?? 'user') as SummaryGroup;
    if (!GROUPS.includes(groupBy)) throw badRequest('groupBy must be one of user, team, campaign, day, week');
    const where = new Where();
    gaugeFilters(req, where, true);
    if (me.role === 'rep') {
      const userId = optionalIdQuery(req.query.userId, 'userId');
      if (userId && userId !== me.id) throw forbidden('Reps can only view their own gauges');
      if (!userId) {
        if (me.teamId === null) where.add('g.user_id = ?', me.id);
        else where.add('u.team_id = ?', me.teamId);
      }
    }
    res.json(summaryRows(db, groupBy, where));
  });

  router.post('/', (req, res) => {
    const me = currentUser(req);
    const body = gaugeBody.parse(req.body);
    const event = getEvent(db, body.eventId);
    if (!event) throw notFound('Event');
    const target = getUser(db, body.userId);
    if (!target) throw notFound('User');
    assertCanWriteGauge(me, target, event);
    assertGaugeIntegrity(me, target, event, body.date, { checkUser: true });
    assertFunnel(body);
    const existing = get<{ id: number; checkedInAt: string | null; notes: string | null }>(
      db,
      `SELECT id, checked_in_at AS checkedInAt, notes FROM gauge_entries WHERE event_id = ? AND user_id = ? AND date = ?`,
      [body.eventId, body.userId, body.date],
    );
    // An `id` means "I am editing that entry": if the key now points elsewhere (or nowhere) the client must PATCH
    // /gauges/:id instead, otherwise a second entry would be created and the original left behind.
    if (body.id !== undefined && existing?.id !== body.id) throw conflict('Another entry exists for that event, user and date — edit the entry with PATCH /gauges/:id');
    const now = nowISO();
    if (existing) {
      // omitted key → keep the stored value; explicit null → clear it
      const checkedInAt = body.checkedInAt === undefined ? existing.checkedInAt : normaliseCheckIn(body.checkedInAt);
      const notes = body.notes === undefined ? existing.notes : body.notes;
      run(
        db,
        `UPDATE gauge_entries SET stops = ?, table_count = ?, presentations = ?, closes = ?, taps = ?, sales = ?, checked_in_at = ?, notes = ?, submitted_at = ? WHERE id = ?`,
        [body.stops, body.table, body.presentations, body.closes, body.taps, body.sales, checkedInAt, notes, now, existing.id],
      );
      return res.status(200).json(getGauge(db, existing.id));
    }
    const r = run(
      db,
      `INSERT INTO gauge_entries (event_id, user_id, date, stops, table_count, presentations, closes, taps, sales, checked_in_at, notes, submitted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [body.eventId, body.userId, body.date, body.stops, body.table, body.presentations, body.closes, body.taps, body.sales, normaliseCheckIn(body.checkedInAt), body.notes ?? null, now],
    );
    res.status(201).json(getGauge(db, r.lastInsertRowid));
  });

  router.patch('/:id', (req, res) => {
    const me = currentUser(req);
    const id = idParam(req);
    const existing = getGauge(db, id);
    if (!existing) throw notFound('Gauge entry');
    const { id: _bodyId, ...patch } = gaugeBody.partial().parse(req.body); // the path decides which entry; nulls clear fields
    const next = { ...existing, ...patch };
    const event = getEvent(db, next.eventId);
    if (!event) throw notFound('Event');
    const target = getUser(db, next.userId);
    if (!target) throw notFound('User');
    assertCanWriteGauge(me, target, event);
    // the original entry must be editable by me as well
    assertCanWriteGauge(me, getUser(db, existing.userId)!, getEvent(db, existing.eventId)!);
    // the user's status is re-checked only when the entry is being re-pointed at someone else (history of leavers stays editable)
    assertGaugeIntegrity(me, target, event, next.date, { checkUser: next.userId !== existing.userId });
    assertFunnel(next);
    if (next.eventId !== existing.eventId || next.userId !== existing.userId || next.date !== existing.date) {
      const dup = get(db, `SELECT 1 FROM gauge_entries WHERE event_id = ? AND user_id = ? AND date = ? AND id <> ?`, [next.eventId, next.userId, next.date, id]);
      if (dup) throw badRequest('Another entry already exists for that event, user and date');
    }
    run(
      db,
      `UPDATE gauge_entries SET event_id = ?, user_id = ?, date = ?, stops = ?, table_count = ?, presentations = ?, closes = ?, taps = ?, sales = ?, checked_in_at = ?, notes = ?, submitted_at = ? WHERE id = ?`,
      [next.eventId, next.userId, next.date, next.stops, next.table, next.presentations, next.closes, next.taps, next.sales, normaliseCheckIn(next.checkedInAt), next.notes ?? null, nowISO(), id],
    );
    res.json(getGauge(db, id));
  });

  router.delete('/:id', (req, res) => {
    const me = currentUser(req);
    const id = idParam(req);
    const existing = getGauge(db, id);
    if (!existing) throw notFound('Gauge entry');
    if (!canManageTeam(me, existing.teamId) && !(me.role === 'leader' && existing.userId === me.id)) throw forbidden('Only leaders of the team or admins can delete gauge entries');
    run(db, `DELETE FROM gauge_entries WHERE id = ?`, [id]);
    res.status(204).end();
  });

  return router;
}
