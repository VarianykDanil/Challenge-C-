import { Router, type Request } from 'express';
import { z } from 'zod';
import { validateGaugeFunnel, type GaugeTotals } from '@lm/shared';
import { get, run, type Db } from '../db/connection.ts';
import { Where, getEvent, getGauge, getUser, listGauges } from '../db/queries.ts';
import { mondayOf, normaliseCheckIn, nowISO, todayISO } from '../lib/dates.ts';
import { badRequest, forbidden, notFound } from '../lib/errors.ts';
import { summaryRows, type SummaryGroup } from '../lib/metrics.ts';
import { assertCanWriteGauge, canManageTeam } from '../lib/scope.ts';
import { idParam, isoDate, isoTimestamp, nonNegativeInt, optionalIdQuery, parseRange } from '../lib/validate.ts';
import { currentUser } from '../middleware/auth.ts';

const gaugeBody = z.object({
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
    const limitRaw = req.query.limit;
    const limit = limitRaw === undefined ? 500 : Math.min(2000, Math.max(1, Number(limitRaw) || 500));
    res.json(listGauges(db, `${where}`, where.params, 'g.date DESC, g.submitted_at DESC', limit));
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
    assertFunnel(body);
    const existing = get<{ id: number }>(db, `SELECT id FROM gauge_entries WHERE event_id = ? AND user_id = ? AND date = ?`, [body.eventId, body.userId, body.date]);
    const now = nowISO();
    const checkedInAt = normaliseCheckIn(body.checkedInAt);
    if (existing) {
      run(
        db,
        `UPDATE gauge_entries SET stops = ?, table_count = ?, presentations = ?, closes = ?, taps = ?, sales = ?, checked_in_at = COALESCE(?, checked_in_at), notes = COALESCE(?, notes), submitted_at = ? WHERE id = ?`,
        [body.stops, body.table, body.presentations, body.closes, body.taps, body.sales, checkedInAt, body.notes ?? null, now, existing.id],
      );
      return res.status(200).json(getGauge(db, existing.id));
    }
    const r = run(
      db,
      `INSERT INTO gauge_entries (event_id, user_id, date, stops, table_count, presentations, closes, taps, sales, checked_in_at, notes, submitted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [body.eventId, body.userId, body.date, body.stops, body.table, body.presentations, body.closes, body.taps, body.sales, checkedInAt, body.notes ?? null, now],
    );
    res.status(201).json(getGauge(db, r.lastInsertRowid));
  });

  router.patch('/:id', (req, res) => {
    const me = currentUser(req);
    const id = idParam(req);
    const existing = getGauge(db, id);
    if (!existing) throw notFound('Gauge entry');
    const patch = gaugeBody.partial().parse(req.body);
    const next = { ...existing, ...patch };
    const event = getEvent(db, next.eventId);
    if (!event) throw notFound('Event');
    const target = getUser(db, next.userId);
    if (!target) throw notFound('User');
    assertCanWriteGauge(me, target, event);
    // the original entry must be editable by me as well
    assertCanWriteGauge(me, getUser(db, existing.userId)!, getEvent(db, existing.eventId)!);
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
