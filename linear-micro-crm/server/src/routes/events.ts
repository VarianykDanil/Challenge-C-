import { Router } from 'express';
import { z } from 'zod';
import { funnelRatios } from '@lm/shared';
import { get, run, type Db } from '../db/connection.ts';
import { Where, getEvent, listEvents, listGauges } from '../db/queries.ts';
import { addDays, nowHHMM, todayISO } from '../lib/dates.ts';
import { badRequest, forbidden, notFound } from '../lib/errors.ts';
import { canManageTeam, redactEntry } from '../lib/scope.ts';
import { idParam, isoDate, nonNegativeInt, optionalIdQuery, optionalString, parseRange, timeHHMM } from '../lib/validate.ts';
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
  targetSales: nonNegativeInt.default(10),
  notes: z.string().trim().max(2000).nullable().optional().default(null),
});

/** Past → completed; today → live only once the start time has passed; otherwise scheduled. */
function defaultStatus(date: string, startTime: string): (typeof EVENT_STATUSES)[number] {
  const today = todayISO();
  if (date < today) return 'completed';
  return date === today && startTime <= nowHHMM() ? 'live' : 'scheduled';
}

export function eventsRouter(db: Db): Router {
  const router = Router();

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
    res.json(listEvents(db, `${where}`, where.params));
  });

  router.get('/:id', (req, res) => {
    const me = currentUser(req);
    const event = getEvent(db, idParam(req));
    if (!event) throw notFound('Event');
    // read-only for every role; check-in times and notes of other people are stripped unless admin / that team's leader
    const entries = listGauges(db, 'WHERE g.event_id = ?', [event.id], 'g.sales DESC, u.last_name ASC').map((e) => redactEntry(me, e));
    res.json({ ...event, entries, ratios: funnelRatios(event.totals) });
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
    const next = { ...existing, ...patch };
    if (next.endTime <= next.startTime) throw badRequest('endTime must be after startTime');
    run(
      db,
      `UPDATE events SET campaign_id = ?, team_id = ?, name = ?, venue = ?, city = ?, type = ?, date = ?, start_time = ?, end_time = ?, status = ?, target_sales = ?, notes = ? WHERE id = ?`,
      [next.campaignId, next.teamId, next.name, next.venue, next.city, next.type, next.date, next.startTime, next.endTime, next.status, next.targetSales, next.notes, id],
    );
    res.json(getEvent(db, id));
  });

  router.delete('/:id', requireRole('admin'), (req, res) => {
    const id = idParam(req);
    if (!getEvent(db, id)) throw notFound('Event');
    run(db, `DELETE FROM events WHERE id = ?`, [id]);
    res.status(204).end();
  });

  return router;
}
