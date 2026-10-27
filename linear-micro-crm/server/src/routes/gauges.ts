import { Router, type Request } from 'express';
import { z } from 'zod';
import { validateGaugeFunnel, type GaugeTotals, type SalesEventWithMeta, type UserWithTeam } from '@lm/shared';
import { get, run, transaction, type Db } from '../db/connection.ts';
import { assertWeekUnpaidFor, syncPayrollForEntry } from '../db/maintenance.ts';
import { Where, getCampaign, getEvent, getGauge, getPayPlan, getUser, listGauges } from '../db/queries.ts';
import { businessNow, mondayOf, normaliseCheckIn, nowHHMM, nowISO, toBusinessISO, todayISO } from '../lib/dates.ts';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.ts';
import { GAUGE_FROM, summaryRows, type SummaryGroup } from '../lib/metrics.ts';
import { assertCanWriteGauge, canManageTeam, isAdmin, redactEntry } from '../lib/scope.ts';
import { assertCheckInNotLocked, stampCheckInAuthor } from '../lib/shiftCheckIns.ts';
import { gaugeCount, idParam, isoDate, isoTimestamp, limitQuery, offsetQuery, optionalIdQuery, parseRange, parsePatch } from '../lib/validate.ts';
import { currentUser } from '../middleware/auth.ts';

/** The POST /gauges body (exported for POST /gauges/bulk, release 1.2 U2). */
export const gaugeBody = z.object({
  /** Optional on POST: the entry the client believes it is editing. A key that resolves to another entry is refused (409). */
  id: z.number().int().positive().optional(),
  eventId: z.number().int().positive(),
  userId: z.number().int().positive(),
  date: isoDate,
  // strict whole numbers 0..GAUGE_MAX_PER_DAY — no coercion, no 1e308, no "true"
  stops: gaugeCount,
  table: gaugeCount,
  presentations: gaugeCount,
  closes: gaugeCount,
  taps: gaugeCount,
  sales: gaugeCount,
  checkedInAt: isoTimestamp.nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
});

const GROUPS: SummaryGroup[] = ['user', 'team', 'campaign', 'day', 'week'];

// Release 1.2: assertFunnel, assertGaugeIntegrity, checkInFor and rateSnapshot are exported so POST /gauges/bulk
// (routes/bulkGauges.ts, U2) applies exactly the single-entry rules. Behaviour unchanged.

export function assertFunnel(t: GaugeTotals): void {
  const warnings = validateGaugeFunnel(t);
  if (warnings.length) throw badRequest('Invalid funnel', warnings);
}

/**
 * Data-integrity rules for gauge writes (checked after the role scoping in `assertCanWriteGauge`). Every aggregate —
 * leaderboards, finance, the live pay estimate — groups on the entry date, so an entry must describe the one day
 * the event actually ran: the date is the event's date, the event has started (today's events only once their start
 * time has passed) and was not cancelled, and the person logged belongs to the event's team (admins are exempt from
 * the team rule; the owner works any team's events).
 */
export function assertGaugeIntegrity(me: UserWithTeam, target: UserWithTeam, event: SalesEventWithMeta, date: string, opts: { checkUser: boolean }): void {
  if (event.status === 'cancelled') throw conflict('Gauges cannot be recorded for a cancelled event');
  const today = todayISO();
  if (event.date > today) throw badRequest('Gauges cannot be recorded before the event takes place');
  if (event.date === today && event.startTime > nowHHMM()) throw badRequest(`Gauges can be recorded once the event has started (${event.startTime})`);
  if (date !== event.date) throw badRequest("Gauges are recorded against the event's date");
  if (opts.checkUser && target.status !== 'active') throw badRequest('Gauges can only be recorded for active users');
  if (!isAdmin(me) && target.teamId !== event.teamId) throw badRequest("The user is not a member of the event's team");
}

/** A check-in is naive Europe/London wall-clock time and can never lie in the future. */
export function checkInFor(value: string | null | undefined): string | null {
  const normalised = normaliseCheckIn(value);
  if (normalised !== null && normalised > toBusinessISO(businessNow())) throw badRequest('Check-in time cannot be in the future');
  return normalised;
}

/**
 * Money rates captured on the entry when it is first logged (or moved to another event / person): the campaign's
 * payout and the person's pay-plan commission at that moment. Revenue and commission aggregates read these, so a
 * later change to a campaign payout or a promotion only affects future days.
 */
export function rateSnapshot(db: Db, event: SalesEventWithMeta, target: UserWithTeam): { payout: number; commission: number } {
  return { payout: getCampaign(db, event.campaignId)?.payoutPerSale ?? 0, commission: getPayPlan(db, target.payPlanId)?.commissionPerSale ?? 0 };
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
    const limit = limitQuery(req.query.limit);
    const offset = offsetQuery(req.query.offset);
    // X-Total-Count = rows matching the filters before limit/offset, so clients can page through long ranges
    const total = get<{ n: number }>(db, `SELECT COUNT(*) AS n ${GAUGE_FROM} ${where}`, where.params)!.n;
    res.setHeader('X-Total-Count', String(total));
    // check-in times and notes of other people are stripped unless admin / that person's leader (same rule as events)
    res.json(listGauges(db, `${where}`, where.params, 'g.date DESC, g.submitted_at DESC', limit, offset).map((e) => redactEntry(me, e)));
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
    assertWeekUnpaidFor(db, me, body.userId, body.date); // 409 once the week's run is paid, unless admin
    const existing = get<{ id: number; userId: number; checkedInAt: string | null; checkedInBy: number | null; notes: string | null }>(
      db,
      `SELECT id, user_id AS userId, checked_in_at AS checkedInAt, checked_in_by AS checkedInBy, notes FROM gauge_entries WHERE event_id = ? AND user_id = ? AND date = ?`,
      [body.eventId, body.userId, body.date],
    );
    // An `id` means "I am editing that entry": if the key now points elsewhere (or nowhere) the client must PATCH
    // /gauges/:id instead, otherwise a second entry would be created and the original left behind.
    if (body.id !== undefined && existing?.id !== body.id) throw conflict('Another entry exists for that event, user and date — edit the entry with PATCH /gauges/:id');
    const now = nowISO();
    const today = todayISO();
    const key = { userId: body.userId, eventId: body.eventId, date: body.date };
    if (existing) {
      // omitted key → keep the stored value; explicit null → clear it
      const checkedInAt = body.checkedInAt === undefined ? existing.checkedInAt : checkInFor(body.checkedInAt);
      // a time a leader or admin recorded for me is theirs to change (review 1.2 S3); counts and notes stay editable
      assertCheckInNotLocked(db, me, existing, { kind: 'time', checkedInAt });
      const notes = body.notes === undefined ? existing.notes : body.notes;
      transaction(db, () => {
        run(
          db,
          `UPDATE gauge_entries SET stops = ?, table_count = ?, presentations = ?, closes = ?, taps = ?, sales = ?, checked_in_at = ?, notes = ?, submitted_at = ? WHERE id = ?`,
          [body.stops, body.table, body.presentations, body.closes, body.taps, body.sales, checkedInAt, notes, now, existing.id],
        );
        stampCheckInAuthor(db, existing.id, existing.checkedInAt, me.id); // who set the check-in time (review 1.2 S3)
        syncPayrollForEntry(db, key, today); // the week's unpaid run follows the gauges, in the same transaction
      });
      return res.status(200).json(getGauge(db, existing.id));
    }
    const checkedInAt = checkInFor(body.checkedInAt);
    const snap = rateSnapshot(db, event, target);
    const id = transaction(db, () => {
      const r = run(
        db,
        `INSERT INTO gauge_entries (event_id, user_id, date, stops, table_count, presentations, closes, taps, sales, checked_in_at, notes, submitted_at, payout_per_sale, commission_per_sale)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [body.eventId, body.userId, body.date, body.stops, body.table, body.presentations, body.closes, body.taps, body.sales, checkedInAt, body.notes ?? null, now, snap.payout, snap.commission],
      );
      stampCheckInAuthor(db, r.lastInsertRowid, undefined, me.id);
      syncPayrollForEntry(db, key, today);
      return r.lastInsertRowid;
    });
    res.status(201).json(getGauge(db, id));
  });

  router.patch('/:id', (req, res) => {
    const me = currentUser(req);
    const id = idParam(req);
    const existing = getGauge(db, id);
    if (!existing) throw notFound('Gauge entry');
    const { id: _bodyId, ...patch } = parsePatch(gaugeBody, req.body); // the path decides which entry; nulls clear fields
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
    const moved = next.eventId !== existing.eventId || next.userId !== existing.userId || next.date !== existing.date;
    if (moved) {
      const dup = get(db, `SELECT 1 FROM gauge_entries WHERE event_id = ? AND user_id = ? AND date = ? AND id <> ?`, [next.eventId, next.userId, next.date, id]);
      if (dup) throw badRequest('Another entry already exists for that event, user and date');
    }
    // both the week the entry leaves and the week it lands in must still be unpaid (unless admin)
    assertWeekUnpaidFor(db, me, existing.userId, existing.date);
    if (next.userId !== existing.userId || mondayOf(next.date) !== mondayOf(existing.date)) assertWeekUnpaidFor(db, me, next.userId, next.date);
    const checkedInAt = patch.checkedInAt === undefined ? existing.checkedInAt : checkInFor(patch.checkedInAt);
    // the rate snapshot stays with the entry unless it is re-pointed at another event or person
    const stored = get<{ payout: number | null; commission: number | null; checkedInBy: number | null }>(
      db,
      `SELECT payout_per_sale AS payout, commission_per_sale AS commission, checked_in_by AS checkedInBy FROM gauge_entries WHERE id = ?`,
      [id],
    )!;
    // a time a leader or admin recorded for me is theirs to change, and it does not travel with a move I make (review 1.2 S3)
    assertCheckInNotLocked(db, me, { userId: existing.userId, checkedInAt: existing.checkedInAt, checkedInBy: stored.checkedInBy }, moved ? { kind: 'move' } : { kind: 'time', checkedInAt });
    const snap = next.eventId !== existing.eventId || next.userId !== existing.userId || stored.payout === null ? rateSnapshot(db, event, target) : { payout: stored.payout, commission: stored.commission ?? 0 };
    const today = todayISO();
    transaction(db, () => {
      run(
        db,
        `UPDATE gauge_entries SET event_id = ?, user_id = ?, date = ?, stops = ?, table_count = ?, presentations = ?, closes = ?, taps = ?, sales = ?, checked_in_at = ?, notes = ?, submitted_at = ?, payout_per_sale = ?, commission_per_sale = ? WHERE id = ?`,
        [next.eventId, next.userId, next.date, next.stops, next.table, next.presentations, next.closes, next.taps, next.sales, checkedInAt, next.notes ?? null, nowISO(), snap.payout, snap.commission, id],
      );
      // who set the check-in time (review 1.2 S3): moving the entry to another event or day keeps the time's author;
      // re-pointing it at another person makes the time the mover's
      stampCheckInAuthor(db, id, next.userId !== existing.userId ? undefined : existing.checkedInAt, me.id);
      syncPayrollForEntry(db, { userId: existing.userId, eventId: existing.eventId, date: existing.date }, today);
      if (moved) syncPayrollForEntry(db, { userId: next.userId, eventId: next.eventId, date: next.date }, today);
    });
    res.json(getGauge(db, id));
  });

  router.delete('/:id', (req, res) => {
    const me = currentUser(req);
    const id = idParam(req);
    const existing = getGauge(db, id);
    if (!existing) throw notFound('Gauge entry');
    if (!canManageTeam(me, existing.teamId) && !(me.role === 'leader' && existing.userId === me.id)) throw forbidden('Only leaders of the team or admins can delete gauge entries');
    if (existing.checkInOnBehalf) {
      // a leader deleting their own day whose arrival time an admin recorded (review 1.2 S3)
      const by = get<{ by: number | null }>(db, `SELECT checked_in_by AS by FROM gauge_entries WHERE id = ?`, [id])!.by;
      assertCheckInNotLocked(db, me, { userId: existing.userId, checkedInAt: existing.checkedInAt, checkedInBy: by }, { kind: 'delete' });
    }
    assertWeekUnpaidFor(db, me, existing.userId, existing.date);
    const today = todayISO();
    transaction(db, () => {
      run(db, `DELETE FROM gauge_entries WHERE id = ?`, [id]);
      syncPayrollForEntry(db, { userId: existing.userId, eventId: existing.eventId, date: existing.date }, today);
    });
    res.status(204).end();
  });

  return router;
}
