/**
 * Release 1.2 (U2 bulk-entry): POST /gauges/bulk against the fixture. Role scoping (leader: own team; admin: any;
 * reps and recruiters: 403), all-or-nothing with every row's problems reported, the single-entry rules per row
 * (funnel, event started and not cancelled, date = event date, team membership, paid-week lock, check-in not in the
 * future), upsert semantics (omitted check-in / notes kept, null clears), the rate snapshot, payroll parity with the
 * same rows sent one by one through POST /gauges, and one data-version bump per request.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { BulkGaugeRow, GaugeTotals } from '@lm/shared';
import { all, get, run } from '../db/connection.ts';
import { PAID_WEEK_MESSAGE } from '../db/maintenance.ts';
import { currentDataVersion } from '../lib/cache.ts';
import { addDays, mondayOf } from '../lib/dates.ts';
import { addEvent, pinBusinessClock, startTestServer, type Json, type TestClient, type TestServer } from './helpers.ts';

// A check-in at 00:01 today is in the future for the first minute after midnight: check one fixed afternoon.
pinBusinessClock();

let srv: TestServer;
let admin: TestClient;
let leader: TestClient;
let rep: TestClient;
let recruiter: TestClient;

before(async () => {
  srv = await startTestServer();
  [admin, leader, rep, recruiter] = await Promise.all([srv.login('admin'), srv.login('leader'), srv.login('rep'), srv.login('recruiter')]);
});
after(async () => {
  await srv.close();
});

const fx = () => srv.fixture!;
const G = (stops: number, table: number, presentations: number, closes: number, taps: number, sales: number): GaugeTotals => ({ stops, table, presentations, closes, taps, sales });
const row = (userId: number, g: GaugeTotals, extra: Partial<BulkGaugeRow> = {}): BulkGaugeRow => ({ userId, ...g, ...extra });
const count = (eventId: number) => get<{ n: number }>(srv.db, `SELECT COUNT(*) AS n FROM gauge_entries WHERE event_id = ?`, [eventId])!.n;
/** A completed event on Wednesday of last week (a whole pay week behind us, whatever today is). */
function lastWeekEvent(teamId: number, offset = 0): { id: number; date: string } {
  const date = addDays(mondayOf(fx().today), -5 + offset);
  return { id: addEvent(srv.db, { campaignId: fx().campaignId, teamId, date, name: `Bulk test ${date} ${teamId}` }), date };
}

test('only leaders and admins may bulk-save; anonymous is 401', async () => {
  const body = { eventId: fx().events.todayA, date: fx().today, rows: [row(fx().users.rep, G(10, 5, 3, 2, 1, 1))] };
  assert.equal((await srv.anon().post('/gauges/bulk', body)).status, 401);
  assert.equal((await rep.post('/gauges/bulk', body)).status, 403);
  assert.equal((await recruiter.post('/gauges/bulk', body)).status, 403);
  assert.equal(count(fx().events.todayA), 0);
});

test('a leader saves their team in one go: created, entries back in row order, rate snapshot taken', async () => {
  const { events, users, today } = fx();
  const before = currentDataVersion();
  const r = await leader.post('/gauges/bulk', {
    eventId: events.todayA,
    date: today,
    rows: [row(users.repA2, G(40, 12, 6, 2, 1, 1), { checkedInAt: `${today}T00:01`, notes: 'Pasted' }), row(users.rep, G(65, 22, 11, 5, 3, 3)), row(users.leader, G(30, 10, 5, 2, 2, 1))],
  });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(currentDataVersion() - before, 1, 'one request, one data-version bump');
  assert.equal(r.json.created, 3);
  assert.equal(r.json.updated, 0);
  assert.deepEqual(r.json.entries.map((e: Json) => e.userId), [users.repA2, users.rep, users.leader]);
  const a2 = r.json.entries[0];
  assert.equal(a2.eventId, events.todayA);
  assert.equal(a2.date, today);
  assert.equal(a2.stops, 40);
  assert.equal(a2.checkedInAt, `${today}T00:01:00`);
  assert.equal(a2.notes, 'Pasted');
  assert.equal(count(events.todayA), 3);
  const snaps = all<{ userId: number; payout: number; commission: number }>(srv.db, `SELECT user_id AS userId, payout_per_sale AS payout, commission_per_sale AS commission FROM gauge_entries WHERE event_id = ? ORDER BY user_id`, [events.todayA]);
  assert.ok(snaps.every((s) => s.payout === 120 && s.commission === 45), JSON.stringify(snaps));
  // the rep sees their own day like any other entry
  const mine = await rep.get(`/gauges?eventId=${events.todayA}&userId=${users.rep}`);
  assert.equal(mine.json.length, 1);
  assert.equal(mine.json[0].sales, 3);
});

test('saving again updates in place: an omitted check-in and note are kept, null clears them', async () => {
  const { events, users, today } = fx();
  const r = await leader.post('/gauges/bulk', { eventId: events.todayA, date: today, rows: [row(users.repA2, G(42, 12, 6, 2, 1, 1))] });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.created, 0);
  assert.equal(r.json.updated, 1);
  assert.equal(r.json.entries[0].stops, 42);
  assert.equal(r.json.entries[0].checkedInAt, `${today}T00:01:00`);
  assert.equal(r.json.entries[0].notes, 'Pasted');
  const cleared = await leader.post('/gauges/bulk', { eventId: events.todayA, date: today, rows: [row(users.repA2, G(42, 12, 6, 2, 1, 1), { checkedInAt: null, notes: null })] });
  assert.equal(cleared.json.entries[0].checkedInAt, null);
  assert.equal(cleared.json.entries[0].notes, null);
  assert.equal(count(events.todayA), 3, 'never a second row for the same day');
});

test('all or nothing: every bad row is reported with its index, and nothing is saved', async () => {
  const { users, teams } = fx();
  const ev = lastWeekEvent(teams.a);
  const r = await leader.post('/gauges/bulk', {
    eventId: ev.id,
    date: ev.date,
    rows: [
      row(users.rep, G(65, 22, 11, 5, 3, 3)),
      row(users.repA2, G(10, 22, 11, 5, 3, 3)), // funnel
      row(users.repB, G(20, 5, 3, 2, 1, 1)), // another team
      row(users.rep, G(65, 22, 11, 5, 3, 3)), // twice
      row(999_999, G(1, 1, 1, 1, 1, 1)), // nobody
      { userId: users.leader, stops: -1, table: 0, presentations: 0, closes: 0, taps: 0, sales: 0 }, // not a count
      row(users.leader, G(5, 4, 3, 2, 1, 1), { checkedInAt: `${addDays(fx().today, 2)}T09:00` }), // check-in in the future
    ],
  });
  assert.equal(r.status, 400);
  assert.equal(r.json.error, '6 rows need fixing — nothing was saved');
  const rows: Json[] = r.json.details.rows;
  assert.deepEqual(rows.map((x) => x.index), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(rows[0].errors, ['table (22) cannot exceed stops (10)']);
  assert.equal(rows[0].userId, users.repA2);
  assert.deepEqual(rows[1].errors, ['Leaders can only record gauges for their own team']);
  assert.deepEqual(rows[2].errors, ['This person is already on row 1']);
  assert.deepEqual(rows[3].errors, ['Person not found']);
  assert.match(rows[4].errors[0], /^Stops: /);
  assert.deepEqual(rows[5].errors, ['Check-in time cannot be in the future']);
  assert.equal(count(ev.id), 0, 'the valid first row was not saved either');
});

test('event-wide rules answer once with the single-entry status', async () => {
  const { events, users, today, teams } = fx();
  const one = [row(users.rep, G(10, 5, 3, 2, 1, 1))];
  // another team's event (leader) → 403
  const other = await leader.post('/gauges/bulk', { eventId: events.todayB, date: today, rows: [row(users.repB, G(10, 5, 3, 2, 1, 1))] });
  assert.equal(other.status, 403);
  assert.equal(other.json.error, "Leaders can only record gauges at their own team's events");
  // not yet
  const future = await leader.post('/gauges/bulk', { eventId: events.tomorrowA, date: addDays(today, 1), rows: one });
  assert.equal(future.status, 400);
  assert.equal(future.json.error, 'Gauges cannot be recorded before the event takes place');
  // the date must be the event's
  const wrongDate = await leader.post('/gauges/bulk', { eventId: events.yesterdayA, date: today, rows: one });
  assert.equal(wrongDate.status, 400);
  assert.equal(wrongDate.json.error, "Gauges are recorded against the event's date");
  // cancelled → 409
  const cancelled = addEvent(srv.db, { campaignId: fx().campaignId, teamId: teams.a, date: addDays(today, -2), status: 'cancelled' });
  const c = await leader.post('/gauges/bulk', { eventId: cancelled, date: addDays(today, -2), rows: one });
  assert.equal(c.status, 409);
  // no such event, no rows, too many rows
  assert.equal((await leader.post('/gauges/bulk', { eventId: 999_999, date: today, rows: one })).status, 404);
  const empty = await leader.post('/gauges/bulk', { eventId: events.todayA, date: today, rows: [] });
  assert.equal(empty.status, 400);
  assert.equal(empty.json.error, 'Validation failed');
  const many = await leader.post('/gauges/bulk', { eventId: events.todayA, date: today, rows: Array.from({ length: 101 }, () => one[0]) });
  assert.equal(many.status, 400);
});

test('an admin may save any team', async () => {
  const { events, users, today } = fx();
  const r = await admin.post('/gauges/bulk', { eventId: events.todayB, date: today, rows: [row(users.repB, G(20, 8, 4, 2, 1, 1))] });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.created, 1);
});

test('paid week: a leader is refused on that row (nothing saved); an admin goes through and the run is flagged adjusted', async () => {
  const { users, teams } = fx();
  const ev = lastWeekEvent(teams.a, 1);
  const monday = mondayOf(ev.date);
  run(
    srv.db,
    `INSERT INTO payroll_runs (user_id, week_start, week_end, days_worked, sales, team_sales, base_pay, commission, bonus, overrides, deductions, gross, due_date, paid_date, status, reference)
     VALUES (?, ?, ?, 1, 1, 0, 60, 45, 0, 0, 0, 105, ?, ?, 'paid', 'PAY-BULK-TEST')`,
    [users.rep, monday, addDays(monday, 6), addDays(monday, 11), addDays(monday, 11)],
  );
  const body = { eventId: ev.id, date: ev.date, rows: [row(users.rep, G(30, 10, 5, 2, 1, 1)), row(users.repA2, G(20, 8, 4, 2, 1, 1))] };
  const refused = await leader.post('/gauges/bulk', body);
  assert.equal(refused.status, 400);
  assert.deepEqual(refused.json.details.rows, [{ index: 0, userId: users.rep, errors: [PAID_WEEK_MESSAGE] }]);
  assert.equal(count(ev.id), 0);
  const ok = await admin.post('/gauges/bulk', body);
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  const runRow = get<{ status: string; adjustedAt: string | null }>(srv.db, `SELECT status, adjusted_at AS adjustedAt FROM payroll_runs WHERE reference = 'PAY-BULK-TEST'`)!;
  assert.equal(runRow.status, 'paid', 'a paid run is never recomputed');
  assert.ok(runRow.adjustedAt, 'but it is flagged as adjusted after payment');
});

test('payroll parity on a clean week: identical runs', async () => {
  const bulkSrv = await startTestServer();
  const singleSrv = await startTestServer();
  try {
    const date = addDays(mondayOf(bulkSrv.fixture!.today), -4); // Thursday of last week
    const rowsFor = (s: TestServer) => [row(s.fixture!.users.rep, G(65, 22, 11, 5, 3, 3)), row(s.fixture!.users.repA2, G(40, 12, 6, 2, 1, 1)), row(s.fixture!.users.leader, G(30, 10, 5, 2, 2, 2))];
    const runs = (s: TestServer) =>
      all(s.db, `SELECT u.employee_id AS emp, r.days_worked, r.sales, r.team_sales, r.base_pay, r.commission, r.bonus, r.overrides, r.gross, r.status FROM payroll_runs r JOIN users u ON u.id = r.user_id WHERE r.week_start = ? ORDER BY u.employee_id`, [mondayOf(date)]);
    const bev = addEvent(bulkSrv.db, { campaignId: bulkSrv.fixture!.campaignId, teamId: bulkSrv.fixture!.teams.a, date });
    const sev = addEvent(singleSrv.db, { campaignId: singleSrv.fixture!.campaignId, teamId: singleSrv.fixture!.teams.a, date });
    const b = await (await bulkSrv.login('leader')).post('/gauges/bulk', { eventId: bev, date, rows: rowsFor(bulkSrv) });
    assert.equal(b.status, 200, JSON.stringify(b.json));
    const sl = await singleSrv.login('leader');
    for (const x of rowsFor(singleSrv)) assert.equal((await sl.post('/gauges', { ...x, eventId: sev, date })).status, 201);
    const bulkRuns = runs(bulkSrv);
    assert.ok(bulkRuns.length >= 3, JSON.stringify(bulkRuns));
    assert.deepEqual(bulkRuns, runs(singleSrv));
    assert.ok((bulkRuns as Json[]).some((x) => x.emp === 'FX-0002' && x.overrides > 0), "the leader's override counts the team's sales");
  } finally {
    await bulkSrv.close();
    await singleSrv.close();
  }
});
