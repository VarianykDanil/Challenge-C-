import { Router } from 'express';
import { z } from 'zod';
import { EVENT_MAX_TARGET_SALES, funnelRatios, type EventForecastResponse, type SalesEventWithMeta } from '@lm/shared';
import { get, run, type Db } from '../db/connection.ts';
import { Where, getEvent, listEvents, listGauges } from '../db/queries.ts';
import { addDays, nowHHMM, todayISO } from '../lib/dates.ts';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.ts';
import { canManageTeam, redactEntry } from '../lib/scope.ts';
import { smartEnabled } from '../lib/smart/enabled.ts';
import { eventForecasts, forecastFor } from '../lib/smart/eventForecast.ts';
import { idParam, isoDate, optionalIdQuery, optionalString, parseRange, positiveInt, targetSalesCount, timeHHMM } from '../lib/validate.ts';
import { currentUser, requireRole } from '../middleware/auth.ts';

const EVENT_TYPES = ['private_site', 'event', 'b2b', 'residential', 'retail'] as const;
const EVENT_STATUSES = ['scheduled', 'live', 'completed', 'cancelled'] as const;

const eventBody = z.object({
  campaignId: z.number().int().positive(),
  teamId: z.number().int().positive(),
  name: z.string().trim().min(1).max(200),
  venue: z.string().trim().min(1).max(200),
  city: z.string().trim().min(1).max(100),
  type: z.enum(EVENT_TYPES),
  date: isoDate,
  startTime: timeHHMM,
  endTime: timeHHMM,
  status: z.enum(EVENT_STATUSES).optional(),
  targetSales: targetSalesCount.default(10),
  notes: z.string().trim().max(2000).nullable().optional().default(null),
});

/** GET /events/forecast query (p1 wiring for p6): what a new event would look like. */
const forecastQuery = z.object({
  campaignId: positiveInt,
  teamId: positiveInt,
  type: z.enum(EVENT_TYPES),
  targetSales: z.coerce.number().int().min(0).max(EVENT_MAX_TARGET_SALES).optional(),
});

/**
 * Smart release 1.1: attach `forecast` (p6) to the events that have one. Nothing is attached — not even the key —
 * when the kill switch is off or the builder has no forecast for an event, so existing payloads stay byte-identical.
 */
function withForecasts<T extends SalesEventWithMeta>(db: Db, events: T[], today: string): T[] {
  if (!events.length || !smartEnabled()) return events;
  const forecasts = eventForecasts(db, events, today);
  if (!forecasts.size) return events;
  return events.map((e) => (forecasts.has(e.id) ? { ...e, forecast: forecasts.get(e.id)! } : e));
}

/** Past → completed; today → live only once the start time has passed; otherwise scheduled. */
function defaultStatus(date: string, startTime: string): (typeof EVENT_STATUSES)[number] {
  const today = todayISO();
  if (date < today) return 'completed';
  return date === today && startTime <= nowHHMM() ? 'live' : 'scheduled';
}

export function eventsRouter(db: Db): Router {
  const router = Router();
  const hasGauges = (eventId: number) => Boolean(get(db, `SELECT 1 FROM gauge_entries WHERE event_id = ? LIMIT 1`, [eventId]));

  router.get('/', (req, res) => {
    const me = currentUser(req);
    const today = todayISO();
    const { from, to } = parseRange(req.query, { from: addDays(today, -7), to: addDays(today, 21) });
    const where = new Where().add('e.date BETWEEN ? AND ?', from, to);
    let teamId = optionalIdQuery(req.query.teamId, 'teamId');
    if (me.role === 'rep') {
      // reps only see their own team's calendar
      if (me.teamId === null) return res.json([]);
      teamId = me.teamId;
    }
    if (teamId) where.add('e.team_id = ?', teamId);
    const campaignId = optionalIdQuery(req.query.campaignId, 'campaignId');
    if (campaignId) where.add('e.campaign_id = ?', campaignId);
    const status = optionalString(req.query.status);
    if (status) {
      if (!EVENT_STATUSES.includes(status as (typeof EVENT_STATUSES)[number])) throw badRequest('Invalid status');
      where.add('e.status = ?', status);
    }
    // the date window is pushed into the gauge aggregate too, so the list never scans the whole gauge table
    res.json(withForecasts(db, listEvents(db, `${where}`, where.params, undefined, { from, to }), today));
  });

  // Smart release 1.1 (p6 fills forecastFor): admin / leader only; declared before /:id so the literal path wins.
  router.get('/forecast', requireRole('admin', 'leader'), (req, res) => {
    const me = currentUser(req);
    const q = forecastQuery.parse(req.query);
    if (!canManageTeam(me, q.teamId)) throw forbidden('Leaders can only forecast events for their own team');
    const body: EventForecastResponse = {
      forecast: smartEnabled() ? forecastFor(db, { campaignId: q.campaignId, teamId: q.teamId, type: q.type, targetSales: q.targetSales }, todayISO()) : null,
    };
    res.json(body);
  });

  router.get('/:id', (req, res) => {
    const me = currentUser(req);
    const found = getEvent(db, idParam(req));
    if (!found) throw notFound('Event');
    const [event] = withForecasts(db, [found], todayISO());
    // read-only for every role; check-in times and notes of other people are stripped unless admin / that team's leader
    const entries = listGauges(db, 'WHERE g.event_id = ?', [event!.id], 'g.sales DESC, u.last_name ASC').map((e) => redactEntry(me, e));
    res.json({ ...event!, entries, ratios: funnelRatios(event!.totals) });
  });

  router.post('/', requireRole('admin', 'leader'), (req, res) => {
    const me = currentUser(req);
    const body = eventBody.parse(req.body);
    if (!canManageTeam(me, body.teamId)) throw forbidden('Leaders can only create events for their own team');
    if (!get(db, `SELECT 1 FROM campaigns WHERE id = ?`, [body.campaignId])) throw badRequest('Unknown campaignId');
    if (!get(db, `SELECT 1 FROM teams WHERE id = ?`, [body.teamId])) throw badRequest('Unknown teamId');
    if (body.endTime <= body.startTime) throw badRequest('endTime must be after startTime');
    const r = run(
      db,
      `INSERT INTO events (campaign_id, team_id, name, venue, city, type, date, start_time, end_time, status, target_sales, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [body.campaignId, body.teamId, body.name, body.venue, body.city, body.type, body.date, body.startTime, body.endTime, body.status ?? defaultStatus(body.date, body.startTime), body.targetSales, body.notes],
    );
    res.status(201).json(getEvent(db, r.lastInsertRowid));
  });

  router.patch('/:id', requireRole('admin', 'leader'), (req, res) => {
    const me = currentUser(req);
    const id = idParam(req);
    const existing = getEvent(db, id);
    if (!existing) throw notFound('Event');
    if (!canManageTeam(me, existing.teamId)) throw forbidden('Leaders can only edit events of their own team');
    const patch = eventBody.partial().parse(req.body);
    if (patch.teamId !== undefined && !canManageTeam(me, patch.teamId)) throw forbidden('Leaders cannot move events to another team');
    if (patch.campaignId !== undefined && !get(db, `SELECT 1 FROM campaigns WHERE id = ?`, [patch.campaignId])) throw badRequest('Unknown campaignId');
    if (patch.teamId !== undefined && !get(db, `SELECT 1 FROM teams WHERE id = ?`, [patch.teamId])) throw badRequest('Unknown teamId');
    // Once gauges are recorded the event's date, team and campaign are frozen: every entry is keyed on the event date
    // and scoped to the team, and revenue is grouped by campaign — moving the event would orphan or double-count them.
    if (hasGauges(id)) {
      const frozen = (['date', 'teamId', 'campaignId'] as const).filter((k) => patch[k] !== undefined && patch[k] !== existing[k]);
      if (frozen.length) throw conflict(`This event has recorded gauges — its ${frozen.join(', ')} cannot change; cancel it and create a new event instead`);
    }
    const next = { ...existing, ...patch };
    if (next.endTime <= next.startTime) throw badRequest('endTime must be after startTime');
    // a new date or start time re-derives the status (past → completed, today after start → live) unless the event is cancelled
    const timingChanged = next.date !== existing.date || next.startTime !== existing.startTime;
    const status = patch.status ?? (timingChanged && existing.status !== 'cancelled' ? defaultStatus(next.date, next.startTime) : existing.status);
    run(
      db,
      `UPDATE events SET campaign_id = ?, team_id = ?, name = ?, venue = ?, city = ?, type = ?, date = ?, start_time = ?, end_time = ?, status = ?, target_sales = ?, notes = ? WHERE id = ?`,
      [next.campaignId, next.teamId, next.name, next.venue, next.city, next.type, next.date, next.startTime, next.endTime, status, next.targetSales, next.notes, id],
    );
    res.json(getEvent(db, id));
  });

  router.delete('/:id', requireRole('admin'), (req, res) => {
    const id = idParam(req);
    if (!getEvent(db, id)) throw notFound('Event');
    // recorded gauges are pay and revenue history: an event that has them can only be cancelled, never deleted
    if (hasGauges(id)) throw conflict('This event has recorded gauges and cannot be deleted — mark it cancelled instead');
    run(db, `DELETE FROM events WHERE id = ?`, [id]);
    res.status(204).end();
  });

  return router;
}
