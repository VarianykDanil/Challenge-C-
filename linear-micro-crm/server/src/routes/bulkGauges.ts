/**
 * Release 1.2 — POST /gauges/bulk — OWNED BY U2 bulk-entry.
 *
 *  POST /gauges/bulk  BulkGaugeInput → 200 BulkGaugeResult | 400 { error, details: { rows: BulkRowError[] } }
 *
 * Leader: own team's events and members (and themselves); admin: any. All rows or nothing (one transaction). Every
 * row is exactly a POST /gauges row: the rules come from routes/gauges.ts (gaugeBody, assertGaugeIntegrity,
 * checkInFor, rateSnapshot), lib/scope.ts (assertCanWriteGauge) and db/maintenance.ts (assertWeekUnpaidFor, the
 * payroll sync), and an existing entry for (event, person, date) is updated in place — an omitted check-in or note
 * keeps the stored value, null clears it. Event-wide problems (no such event, another team's event, cancelled, not
 * started yet, wrong date) answer once with the single-entry status; row problems are collected for every row and
 * answered together as 400 with details.rows, and then nothing is saved.
 *
 * The data version is bumped once, by the write middleware in app.ts, before this handler runs. Types:
 * shared/src/types/bulk.ts. Mounted in app.ts at /gauges/bulk BEFORE the /gauges router.
 */
import { Router } from 'express';
import { z } from 'zod';
import { GAUGE_LABELS, validateGaugeFunnel, type BulkGaugeResult, type BulkRowError, type UserWithTeam } from '@lm/shared';
import { all, run, transaction, type Db } from '../db/connection.ts';
import { affectedPayUsers, assertWeekUnpaidFor, syncPayrollRun } from '../db/maintenance.ts';
import { GAUGE_SELECT, USER_SELECT, getEvent, mapGauge, type GaugeRow } from '../db/queries.ts';
import { mondayOf, nowISO, todayISO } from '../lib/dates.ts';
import { HttpError, badRequest, notFound } from '../lib/errors.ts';
import { assertCanWriteGauge, redactEntry } from '../lib/scope.ts';
import { assertCheckInNotLocked, stampCheckInAuthor } from '../lib/shiftCheckIns.ts';
import { isoDate } from '../lib/validate.ts';
import { currentUser, requireRole } from '../middleware/auth.ts';
import { assertGaugeIntegrity, checkInFor, gaugeBody, rateSnapshot } from './gauges.ts';

/** One request saves at most this many people (a team is 5–15; the cap keeps one transaction small). */
export const BULK_MAX_ROWS = 100;

const envelope = z.object({
  eventId: z.number().int().positive(),
  date: isoDate,
  rows: z.array(z.unknown()).min(1, 'Add at least one row').max(BULK_MAX_ROWS, `At most ${BULK_MAX_ROWS} rows can be saved in one go`),
});

/** A row is a POST /gauges body without the event, date and entry id (the request carries the first two). */
const rowBody = gaugeBody.omit({ id: true, eventId: true, date: true });
type Row = z.infer<typeof rowBody>;

const FIELD_LABELS: Record<string, string> = { ...GAUGE_LABELS, userId: 'Person', checkedInAt: 'Check-in', notes: 'Notes' };

/** "Stops: Number must be less than or equal to 2000" — zod's message with the field named as the form names it. */
function zodRowErrors(err: z.ZodError): string[] {
  return err.issues.map((i) => {
    const field = i.path.length ? FIELD_LABELS[String(i.path[0])] ?? String(i.path[0]) : null;
    return field ? `${field}: ${i.message}` : i.message;
  });
}

/** Run one single-entry rule and keep its message instead of throwing (only HttpErrors; anything else is a bug). */
function collect(errors: string[], rule: () => void): void {
  try {
    rule();
  } catch (e) {
    if (!(e instanceof HttpError)) throw e;
    const details = Array.isArray(e.details) ? e.details.filter((d): d is string => typeof d === 'string') : [];
    errors.push(...(details.length ? details : [e.message]));
  }
}

type PayUser = ReturnType<typeof affectedPayUsers>[number];

export function bulkGaugesRouter(db: Db): Router {
  const router = Router();

  router.post('/', requireRole('admin', 'leader'), (req, res) => {
    const me = currentUser(req);
    const body = envelope.parse(req.body);
    const event = getEvent(db, body.eventId);
    if (!event) throw notFound('Event');
    // Event-wide rules, answered once with the single-entry status: a leader works their own team's events only
    // (403), and the event must have started, not be cancelled, and the date must be its date (400 / 409). The
    // stand-in target is a member of the event's team, so only the event rules can fail here.
    assertCanWriteGauge(me, me, event);
    assertGaugeIntegrity(me, { ...me, teamId: event.teamId, status: 'active' }, event, body.date, { checkUser: false });

    // People, one query.
    const rawIds = body.rows.map((r) => (r && typeof r === 'object' && Number.isInteger((r as { userId?: unknown }).userId) ? (r as { userId: number }).userId : null));
    const ids = [...new Set(rawIds.filter((id): id is number => id !== null && id > 0))];
    const people = new Map(
      (ids.length ? all<UserWithTeam>(db, `${USER_SELECT} WHERE u.id IN (${ids.map(() => '?').join(', ')})`, ids) : []).map((u) => [u.id, u]),
    );

    // Existing entries for the day, one query: a bulk row updates them exactly as POST /gauges does.
    const existing = new Map(
      all<{ id: number; userId: number; checkedInAt: string | null; checkedInBy: number | null; notes: string | null }>(
        db,
        `SELECT id, user_id AS userId, checked_in_at AS checkedInAt, checked_in_by AS checkedInBy, notes FROM gauge_entries WHERE event_id = ? AND date = ?`,
        [event.id, body.date],
      ).map((e) => [e.userId, e]),
    );

    // Every row is checked, so the person sees every problem at once.
    const problems: BulkRowError[] = [];
    const valid: { row: Row; target: UserWithTeam; checkedInAt: string | null | undefined }[] = [];
    const firstIndexFor = new Map<number, number>();
    body.rows.forEach((raw, index) => {
      const errors: string[] = [];
      const parsed = rowBody.safeParse(raw);
      if (!parsed.success) {
        problems.push({ index, userId: rawIds[index] ?? null, errors: zodRowErrors(parsed.error) });
        return;
      }
      const row = parsed.data;
      const earlier = firstIndexFor.get(row.userId);
      if (earlier !== undefined) errors.push(`This person is already on row ${earlier + 1}`);
      else firstIndexFor.set(row.userId, index);
      const target = people.get(row.userId);
      if (!target) {
        problems.push({ index, userId: row.userId, errors: [...errors, 'Person not found'] });
        return;
      }
      // who may be logged here: the first refusal is the answer, as on a single entry
      collect(errors, () => {
        assertCanWriteGauge(me, target, event);
        assertGaugeIntegrity(me, target, event, body.date, { checkUser: true });
      });
      errors.push(...validateGaugeFunnel(row));
      collect(errors, () => assertWeekUnpaidFor(db, me, target.id, body.date)); // paid week: 409 on a single entry
      let checkedInAt: string | null | undefined;
      if (row.checkedInAt !== undefined) collect(errors, () => (checkedInAt = checkInFor(row.checkedInAt)));
      // a leader's own row whose arrival time an admin recorded: that time is the admin's to change (review 1.2 S3)
      const prev = existing.get(target.id);
      if (prev && checkedInAt !== undefined) collect(errors, () => assertCheckInNotLocked(db, me, prev, { kind: 'time', checkedInAt: checkedInAt ?? null }));
      if (errors.length) problems.push({ index, userId: row.userId, errors });
      else valid.push({ row, target, checkedInAt });
    });
    if (problems.length) {
      const n = problems.length;
      throw badRequest(`${n} row${n === 1 ? '' : 's'} need${n === 1 ? 's' : ''} fixing — nothing was saved`, { rows: problems });
    }

    const now = nowISO();
    const today = todayISO();
    // The rate snapshot depends on the event's campaign and the person's pay plan only.
    const snaps = new Map<number, { payout: number; commission: number }>();
    const snapFor = (target: UserWithTeam) => {
      let s = snaps.get(target.payPlanId);
      if (!s) snaps.set(target.payPlanId, (s = rateSnapshot(db, event, target)));
      return s;
    };

    let created = 0;
    let updated = 0;
    const savedIds = transaction(db, () => {
      const out: number[] = [];
      for (const { row, target, checkedInAt } of valid) {
        const prev = existing.get(target.id);
        if (prev) {
          // omitted key → keep the stored value; explicit null → clear it
          run(
            db,
            `UPDATE gauge_entries SET stops = ?, table_count = ?, presentations = ?, closes = ?, taps = ?, sales = ?, checked_in_at = ?, notes = ?, submitted_at = ? WHERE id = ?`,
            [row.stops, row.table, row.presentations, row.closes, row.taps, row.sales, checkedInAt === undefined ? prev.checkedInAt : checkedInAt, row.notes === undefined ? prev.notes : row.notes, now, prev.id],
          );
          stampCheckInAuthor(db, prev.id, prev.checkedInAt, me.id); // who set the check-in time (review 1.2 S3)
          out.push(prev.id);
          updated++;
        } else {
          const snap = snapFor(target);
          const r = run(
            db,
            `INSERT INTO gauge_entries (event_id, user_id, date, stops, table_count, presentations, closes, taps, sales, checked_in_at, notes, submitted_at, payout_per_sale, commission_per_sale)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [event.id, target.id, body.date, row.stops, row.table, row.presentations, row.closes, row.taps, row.sales, checkedInAt ?? null, row.notes ?? null, now, snap.payout, snap.commission],
          );
          stampCheckInAuthor(db, r.lastInsertRowid, undefined, me.id);
          out.push(r.lastInsertRowid);
          created++;
        }
      }
      // The week's unpaid runs follow the gauges, in the same transaction (syncPayrollForEntry's rule, once per
      // affected person instead of once per row: the team's leaders are affected by every row).
      const affected = new Map<number, PayUser>();
      for (const { target } of valid) for (const u of affectedPayUsers(db, { userId: target.id, eventId: event.id })) affected.set(u.id, u);
      const monday = mondayOf(body.date);
      for (const u of affected.values()) syncPayrollRun(db, u, monday, today, { flagPaid: true });
      return out;
    });

    const order = new Map(savedIds.map((id, i) => [id, i]));
    const entries = all<GaugeRow>(db, `${GAUGE_SELECT} WHERE g.id IN (${savedIds.map(() => '?').join(', ')})`, savedIds)
      .map(mapGauge)
      .sort((a, b) => order.get(a.id)! - order.get(b.id)!)
      .map((e) => redactEntry(me, e));
    const result: BulkGaugeResult = { created, updated, entries };
    res.status(200).json(result);
  });

  return router;
}
