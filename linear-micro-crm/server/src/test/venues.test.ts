/**
 * P8 venue-insights — route tests on the small fixture (and one on the full demo seed):
 *  - who may read and write each endpoint: anonymous 401, a client account 403 clientPortalOnly, every staff role;
 *  - the roster rules (who books whom, bookings close when the event is over, self-bookings kept, nothing written twice)
 *    and their audit rows;
 *  - `bookings` on GET /events and /events/:id, and bookings feeding the forecast;
 *  - the plan maths end to end against a hand-computed fixture, and who sees whose plan;
 *  - the venue list and profile: grouping by venue key, only finished days counting, anonymous points for reps, named
 *    rows for the admin and (own team only) a leader, the response cache.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { planSteps, venueKey } from '@lm/shared';
import { all, run, type Db } from '../db/connection.ts';
import { addDays, todayISO } from '../lib/dates.ts';
import { addGauge, addHistory, startTestServer, withSmart, type Fixture, type Json, type TestClient, type TestServer } from './helpers.ts';

const TEST_VENUE = venueKey('Test Venue', 'Manchester'); // every fixture event is at Test Venue, Manchester

/** A completed (by default) event of the fixture campaign at `venue`. */
function venueEvent(db: Db, fx: Fixture, o: { venue: string; city?: string; date: string; teamId?: number; status?: string; targetSales?: number }): number {
  return run(
    db,
    `INSERT INTO events (campaign_id, team_id, name, venue, city, type, date, start_time, end_time, status, target_sales, notes)
     VALUES (?, ?, ?, ?, ?, 'private_site', ?, '09:00', '17:00', ?, ?, NULL)`,
    [fx.campaignId, o.teamId ?? fx.teams.a, `${o.venue} ${o.date}`, o.venue, o.city ?? 'Manchester', o.date, o.status ?? 'completed', o.targetSales ?? 10],
  ).lastInsertRowid;
}

/** One shift per date for `userId`, each on its own event at `venue`. */
function shifts(db: Db, fx: Fixture, userId: number, venue: string, days: number[], stops: number, sales: number, teamId = fx.teams.a): void {
  const today = todayISO();
  for (const d of days) {
    const date = addDays(today, -d);
    const eventId = venueEvent(db, fx, { venue, date, teamId });
    addGauge(db, { eventId, userId, date, stops, sales });
  }
}

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

const rosterAudit = (db: Db) => all<{ summary: string; entityId: number; userId: number | null }>(db, `SELECT summary, entity_id AS entityId, user_id AS userId FROM audit_log WHERE entity = 'event_roster' ORDER BY id`);

// ───────────────────────────── access ─────────────────────────────

describe('access: every P8 endpoint, every role', () => {
  let srv: TestServer;
  let fx: Fixture;
  const as: Record<string, TestClient> = {};
  before(async () => {
    srv = await startTestServer();
    fx = srv.fixture!;
    for (const role of ['admin', 'leader', 'recruiter', 'rep', 'client'] as const) as[role] = await srv.login(role);
  });
  after(() => srv.close());

  const paths = () => [
    ['GET', '/venues'],
    ['GET', `/venues/${TEST_VENUE}`],
    ['GET', `/events/${fx.events.todayA}/plan`],
    ['GET', `/events/${fx.events.todayA}/roster`],
    ['PUT', `/events/${fx.events.todayA}/roster`],
    ['POST', `/events/${fx.events.todayA}/roster/me`],
    ['DELETE', `/events/${fx.events.todayA}/roster/me`],
  ] as const;

  test('anonymous → 401 and a client account → 403 clientPortalOnly, on every path', async () => {
    const anon = srv.anon();
    for (const [method, path] of paths()) {
      const body = method === 'PUT' ? { userIds: [] } : undefined;
      assert.equal((await anon.req(method, path, body)).status, 401, `anon ${method} ${path}`);
      const r = await as.client!.req(method, path, body);
      assert.equal(r.status, 403, `client ${method} ${path}`);
      assert.equal(r.json?.clientPortalOnly, true, `client ${method} ${path}`);
    }
    assert.equal(rosterAudit(srv.db).length, 0);
  });

  test('reads: every staff role; writes: the roles the rules allow', async () => {
    for (const role of ['admin', 'leader', 'recruiter', 'rep']) {
      const c = as[role]!;
      assert.equal((await c.get('/venues')).status, 200, `${role} /venues`);
      assert.equal((await c.get(`/venues/${TEST_VENUE}`)).status, 200, `${role} profile`);
      assert.equal((await c.get(`/events/${fx.events.todayA}/plan`)).status, 200, `${role} plan`);
      assert.deepEqual((await c.get(`/events/${fx.events.todayA}/roster`)).json, [], `${role} roster`);
    }
    assert.equal((await as.rep!.put(`/events/${fx.events.todayA}/roster`, { userIds: [] })).status, 403);
    assert.equal((await as.recruiter!.put(`/events/${fx.events.todayA}/roster`, { userIds: [] })).status, 403);
    assert.equal((await as.recruiter!.post(`/events/${fx.events.todayA}/roster/me`)).status, 403);
    assert.equal((await as.recruiter!.del(`/events/${fx.events.todayA}/roster/me`)).status, 403);
    assert.equal((await as.admin!.put(`/events/${fx.events.todayA}/roster`, { userIds: [] })).status, 200);
  });

  test('bad input: unknown event 404, bad id 400, bad body 400, bad venue 400 / 404, bad sort 400', async () => {
    assert.equal((await as.admin!.get('/events/999999/roster')).status, 404);
    assert.equal((await as.admin!.get('/events/999999/plan')).status, 404);
    assert.equal((await as.admin!.put('/events/999999/roster', { userIds: [] })).status, 404);
    assert.equal((await as.rep!.post('/events/999999/roster/me')).status, 404);
    assert.equal((await as.admin!.get('/events/abc/roster')).status, 400);
    assert.equal((await as.admin!.put(`/events/${fx.events.todayA}/roster`, {})).status, 400);
    assert.equal((await as.admin!.put(`/events/${fx.events.todayA}/roster`, { userIds: ['x'] })).status, 400);
    assert.equal((await as.admin!.put(`/events/${fx.events.todayA}/roster`, { userIds: Array.from({ length: 201 }, (_, i) => i + 1) })).status, 400);
    assert.equal((await as.rep!.get('/venues/not a key')).status, 400);
    const missing = await as.rep!.get('/venues/nowhere--atall');
    assert.equal(missing.status, 404);
    assert.equal(missing.json.error, 'Venue not found');
    assert.equal((await as.rep!.get('/venues?sort=nonsense')).status, 400);
    for (const sort of ['sales_per_shift', 'shifts', 'last_visit']) assert.equal((await as.rep!.get(`/venues?sort=${sort}`)).status, 200, sort);
  });
});

// ───────────────────────────── the roster ─────────────────────────────

describe('roster: who books whom', () => {
  let srv: TestServer;
  let fx: Fixture;
  let admin: TestClient;
  let leader: TestClient;
  let rep: TestClient;
  let repB: TestClient;
  before(async () => {
    srv = await startTestServer();
    fx = srv.fixture!;
    admin = await srv.login('admin');
    leader = await srv.login('leader');
    rep = await srv.login('rep');
    repB = await srv.login('repB');
  });
  after(() => srv.close());

  test('the leader books their team; the list replaces the roster; saving it again writes nothing', async () => {
    const { users, events } = fx;
    const r = await leader.put(`/events/${events.todayA}/roster`, { userIds: [users.rep, users.repA2, users.leader, users.rep] });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.map((b: Json) => b.userName), ['Lee Leader', 'Remy Rep', 'Rita Rep'], 'deduplicated, by first name');
    for (const b of r.json) {
      assert.equal(b.source, 'leader');
      assert.equal(b.bookedBy, users.leader);
      assert.equal(b.bookedByName, 'Lee Leader');
      assert.equal(b.eventId, events.todayA);
    }
    const first = rosterAudit(srv.db);
    assert.equal(first.length, 1);
    assert.match(first[0]!.summary, /^Bookings for Team A .+: booked Lee Leader, Remy Rep and Rita Rep$/);
    assert.equal(first[0]!.entityId, events.todayA, 'filed under the event');
    // the same list again: nothing changes, no audit row, booking times kept
    const again = await leader.put(`/events/${events.todayA}/roster`, { userIds: [users.leader, users.repA2, users.rep] });
    assert.deepEqual(again.json, r.json);
    assert.equal(rosterAudit(srv.db).length, 1);
    // leaving people out takes them off
    const fewer = await leader.put(`/events/${events.todayA}/roster`, { userIds: [users.rep] });
    assert.deepEqual(fewer.json.map((b: Json) => b.userId), [users.rep]);
    assert.match(rosterAudit(srv.db)[1]!.summary, /: took off Lee Leader and Rita Rep$/);
  });

  test('a leader cannot book on another team\'s event, or book people from another team or the office', async () => {
    const { users, events } = fx;
    assert.equal((await leader.put(`/events/${events.todayB}/roster`, { userIds: [users.leader] })).status, 403);
    const other = await leader.put(`/events/${events.tomorrowA}/roster`, { userIds: [users.repB] });
    assert.equal(other.status, 400);
    assert.equal(other.json.error, `That person is not on the Team A team (id ${users.repB})`, 'no name outside the leader\'s team');
    assert.equal((await leader.put(`/events/${events.tomorrowA}/roster`, { userIds: [users.recruiter] })).status, 400);
    assert.equal((await admin.put(`/events/${events.tomorrowA}/roster`, { userIds: [users.recruiter] })).status, 400, 'recruiters work in the office');
    assert.equal((await admin.put(`/events/${events.tomorrowA}/roster`, { userIds: [987654] })).status, 400);
    run(srv.db, `UPDATE users SET status = 'left' WHERE id = ?`, [users.repA2]);
    assert.equal((await leader.put(`/events/${events.tomorrowA}/roster`, { userIds: [users.repA2] })).status, 400, 'not active');
    run(srv.db, `UPDATE users SET status = 'active' WHERE id = ?`, [users.repA2]);
    // the admin books anyone in the field, on any event
    const cross = await admin.put(`/events/${events.tomorrowA}/roster`, { userIds: [users.repB, users.admin] });
    assert.equal(cross.status, 200);
    assert.deepEqual(cross.json.map((b: Json) => [b.userId, b.source, b.bookedBy]), [[users.admin, 'leader', users.admin], [users.repB, 'leader', users.admin]]);
    // someone already booked stays booked when the leader saves the list, even if they could not be booked now
    const kept = await leader.put(`/events/${events.tomorrowA}/roster`, { userIds: [users.repB, users.admin, users.rep] });
    assert.equal(kept.status, 200);
    assert.deepEqual(kept.json.map((b: Json) => b.userId).sort(), [users.admin, users.rep, users.repB].sort());
  });

  test('"I\'m working this": own team only, twice changes nothing; a leader\'s save keeps the self-booking as it was', async () => {
    const { users, events } = fx;
    const before = rosterAudit(srv.db).length;
    assert.equal((await rep.post(`/events/${events.todayB}/roster/me`)).status, 403, 'not their team');
    const mine = await repB.post(`/events/${events.todayB}/roster/me`);
    assert.equal(mine.status, 200);
    assert.deepEqual(mine.json.map((b: Json) => [b.userId, b.source, b.bookedBy]), [[users.repB, 'self', users.repB]]);
    const twice = await repB.post(`/events/${events.todayB}/roster/me`);
    assert.deepEqual(twice.json, mine.json);
    const rows = rosterAudit(srv.db).slice(before);
    assert.equal(rows.length, 1);
    assert.match(rows[0]!.summary, /^Bo Rep is working Team B .+ \(I'm working this\)$/);
    assert.equal(rows[0]!.userId, users.repB);
    // the admin can book themself anywhere
    assert.equal((await admin.post(`/events/${events.todayB}/roster/me`)).status, 200);
    // the admin saves the list with repB in it: the self-booking keeps its source and time
    const saved = await admin.put(`/events/${events.todayB}/roster`, { userIds: [users.repB] });
    assert.deepEqual(saved.json.map((b: Json) => [b.userId, b.source, b.bookedAt]), [[users.repB, 'self', mine.json[0].bookedAt]]);
  });

  test('"I can\'t make it": anyone booked may come off, whoever booked them; not booked changes nothing', async () => {
    const { users, events } = fx;
    await leader.put(`/events/${events.tomorrowA}/roster`, { userIds: [users.rep] });
    const before = rosterAudit(srv.db).length;
    const off = await rep.del(`/events/${events.tomorrowA}/roster/me`);
    assert.equal(off.status, 200);
    assert.ok(!off.json.some((b: Json) => b.userId === users.rep));
    const again = await rep.del(`/events/${events.tomorrowA}/roster/me`);
    assert.equal(again.status, 200);
    const rows = rosterAudit(srv.db).slice(before);
    assert.equal(rows.length, 1);
    assert.match(rows[0]!.summary, /^Remy Rep can no longer work Team A /);
  });

  test('bookings close once the event is over (completed, cancelled or in the past)', async () => {
    const { users, events } = fx;
    const done = await leader.put(`/events/${events.yesterdayA}/roster`, { userIds: [users.rep] });
    assert.equal(done.status, 409);
    assert.equal(done.json.error, 'This event has finished, so its bookings are closed');
    assert.equal((await rep.post(`/events/${events.yesterdayA}/roster/me`)).status, 409);
    run(srv.db, `INSERT INTO event_roster (event_id, user_id, booked_by, booked_at, source) VALUES (?, ?, ?, '2026-01-01T09:00:00.000Z', 'self')`, [events.yesterdayA, users.rep, users.rep]);
    assert.equal((await rep.del(`/events/${events.yesterdayA}/roster/me`)).status, 409, 'history stays as it was');
    assert.equal((await rep.get(`/events/${events.yesterdayA}/roster`)).json.length, 1);
    const cancelled = venueEvent(srv.db, fx, { venue: 'Test Venue', date: addDays(todayISO(), 3), status: 'cancelled' });
    const c = await leader.put(`/events/${cancelled}/roster`, { userIds: [users.rep] });
    assert.equal(c.status, 409);
    assert.equal(c.json.error, 'This event is cancelled, so its bookings are closed');
    const stale = venueEvent(srv.db, fx, { venue: 'Test Venue', date: addDays(todayISO(), -2), status: 'scheduled' });
    assert.equal((await rep.post(`/events/${stale}/roster/me`)).status, 409, 'a past day still marked scheduled');
  });

  test('GET /events and /events/:id carry bookings { booked, me } only on booked events, with LM_SMART=0 too', async () => {
    const { users, events } = fx;
    await leader.put(`/events/${events.todayA}/roster`, { userIds: [users.rep, users.repA2] });
    await leader.put(`/events/${events.tomorrowA}/roster`, { userIds: [] });
    const list = await rep.get('/events');
    const byId = new Map<number, Json>(list.json.map((e: Json) => [e.id, e]));
    assert.deepEqual(byId.get(events.todayA).bookings, { booked: 2, me: true });
    assert.ok(!('bookings' in byId.get(events.tomorrowA)), 'nobody booked: no key at all');
    assert.ok(!('bookings' in byId.get(events.yesterdayA)) || byId.get(events.yesterdayA).bookings.booked > 0);
    const asLeader = await leader.get(`/events/${events.todayA}`);
    assert.deepEqual(asLeader.json.bookings, { booked: 2, me: false });
    await withSmart('0', async () => {
      const off = await rep.get(`/events/${events.todayA}`);
      assert.deepEqual(off.json.bookings, { booked: 2, me: true }, 'a workflow rule, not an estimate');
      assert.ok(!('forecast' in off.json));
    });
  });
});

// ───────────────────────────── bookings feed forecasts ─────────────────────────────

describe('bookings feed the event forecast', () => {
  let srv: TestServer;
  let fx: Fixture;
  before(async () => {
    srv = await startTestServer();
    fx = srv.fixture!;
    // team A, 4 weeks × 4 days: rep and repA2 on the same completed private sites, 3 sales each → 2 reps usually, rate 3
    addHistory(srv.db, { userId: fx.users.rep, teamId: fx.teams.a, campaignId: fx.campaignId, weeks: 4, stops: 60, sales: 3 });
    addHistory(srv.db, { userId: fx.users.repA2, teamId: fx.teams.a, campaignId: fx.campaignId, weeks: 4, stops: 60, sales: 3 });
    srv.resetCache();
  });
  after(() => srv.close());

  test('expectedReps = the people booked once a leader books; self-bookings are a floor under the habit', async () => {
    const leader = await srv.login('leader');
    const rep = await srv.login('rep');
    const habit = (await leader.get(`/events/${fx.events.tomorrowA}`)).json.forecast;
    assert.equal(habit.expectedReps, 2);
    assert.equal(habit.expectedSales, 6);
    await leader.put(`/events/${fx.events.tomorrowA}/roster`, { userIds: [fx.users.rep, fx.users.repA2, fx.users.leader] });
    const booked = (await leader.get(`/events/${fx.events.tomorrowA}`)).json.forecast;
    assert.equal(booked.expectedReps, 3);
    assert.equal(booked.expectedSales, 9);
    // only a self-booking so far: the roster is still filling up, so the habit (2) is the floor
    await rep.post(`/events/${fx.events.todayA}/roster/me`);
    const live = (await rep.get('/events')).json.find((e: Json) => e.id === fx.events.todayA).forecast;
    assert.equal(live.expectedReps, 2);
    assert.equal(live.expectedSales, 6);
    // with too little history for a habit (team B), a booking alone gives a forecast from the company's rate
    const repB = await srv.login('repB');
    assert.ok(!('forecast' in (await repB.get(`/events/${fx.events.tomorrowB}`)).json));
    await repB.post(`/events/${fx.events.tomorrowB}/roster/me`);
    const teamB = (await repB.get(`/events/${fx.events.tomorrowB}`)).json.forecast;
    assert.equal(teamB.expectedReps, 1);
    assert.equal(teamB.basis, 'company');
  });
});

// ───────────────────────────── plans ─────────────────────────────

describe('event plans: the hand-computed fixture end to end, and who sees whose plan', () => {
  let srv: TestServer;
  let fx: Fixture;
  let rep: TestClient;
  let repA2: TestClient;
  let leader: TestClient;
  let admin: TestClient;
  let recruiter: TestClient;
  before(async () => {
    srv = await startTestServer();
    fx = srv.fixture!;
    // rep: 8 shifts in the last 8 weeks at Other Venue, 100 / 35 / 18 / 7 / 4 / 4 each
    shifts(srv.db, fx, fx.users.rep, 'Other Venue', range(2, 9), 100, 4);
    // repA2: 12 shifts at Test Venue (the fixture events' venue), 80 / 28 / 14 / 6 / 4 / 2 each
    shifts(srv.db, fx, fx.users.repA2, 'Test Venue', range(10, 21), 80, 2);
    srv.resetCache();
    rep = await srv.login('rep');
    repA2 = await srv.login('repA2');
    leader = await srv.login('leader');
    admin = await srv.login('admin');
    recruiter = await srv.login('recruiter');
  });
  after(() => srv.close());

  test('not booked → no plan; booked → the blended plan, number for number', async () => {
    assert.deepEqual((await rep.get(`/events/${fx.events.todayA}/plan`)).json, []);
    await rep.post(`/events/${fx.events.todayA}/roster/me`);
    const r = await rep.get(`/events/${fx.events.todayA}/plan`);
    assert.equal(r.status, 200);
    assert.equal(r.json.length, 1);
    const plan = r.json[0];
    // own (8 shifts): 0.35 · 18/35 · 7/18 · 4/7 · 1; venue (12 shifts): 0.35 · 0.5 · 6/14 · 4/6 · 0.5;
    // company (both): 616/1760 · 312/616 · 128/312 · 80/128 · 56/80. w_v = 12/22, w = 10/18:
    //   location = w_v × venue + (1 − w_v) × company; ratio = (1 − w) × own + w × location
    //   → 0.35 · 0.50799 · 0.40631 · 0.61382 · 0.77273
    assert.deepEqual(plan.ratios, { stopToTable: 0.35, tableToPresentation: 0.508, presentationToClose: 0.4063, closeToTap: 0.6138, tapToSale: 0.7727 });
    assert.equal(plan.venueWeight, 0.56);
    assert.deepEqual(plan.basis, { ownShifts: 8, venueShifts: 12 });
    // target: the event's 10 shared among the 1 expected (his self-booking; the team's habit here is 1 a day) = 10, more
    // than 1.5 × his good day of 4 → the plan aims for the good day and says so (shareAboveGoodDay)
    assert.deepEqual([plan.targetSales, plan.targetSource, plan.eventShare, plan.sharedAmong, plan.goodDay, plan.shareAboveGoodDay], [4, 'good-day', 10, 1, 4, true]);
    // conversion to a sale: taps 0.77273 → ⌈5.18⌉ = 6; closes 0.47431 → ⌈8.43⌉ = 9; presentations 0.19272 → ⌈20.76⌉ = 21;
    // table 0.09790 → ⌈40.86⌉ = 41; stops 0.034265 → ⌈116.74⌉ = 117
    assert.deepEqual(plan.steps.map((s: Json) => s.need), [117, 41, 21, 9, 6]);
    // the range for 4 sales: λ 2.438 – 6.562 → stops round(2.438 ÷ 0.034265) = 71 – round(6.562 ÷ 0.034265) = 191
    assert.deepEqual([plan.steps[0].low, plan.steps[0].high], [71, 191]);
    assert.equal(plan.sentence, 'To make 4 sales at Test Venue you need about 117 stops → 41 to table → 21 presentations → 9 closes → 6 taps.');
    // the same ratios for 10 sales (the docs' worked example): 292 → 103 → 52 → 22 → 13, stops 213–400
    const ten = planSteps(10, plan.ratios);
    assert.deepEqual(ten.map((s) => s.need), [292, 103, 52, 22, 13]);
    assert.deepEqual([ten[0]!.low, ten[0]!.high], [213, 400]);
    assert.equal(plan.userName, 'Remy Rep');
    assert.equal(plan.venueName, 'Test Venue');
  });

  test('a good day above the event\'s share wins; a newcomer\'s good day comes from the venue', async () => {
    await leader.put(`/events/${fx.events.tomorrowA}/roster`, { userIds: [fx.users.rep, fx.users.repA2, fx.users.leader] });
    const plans = (await leader.get(`/events/${fx.events.tomorrowA}/plan`)).json;
    assert.deepEqual(plans.map((p: Json) => p.userName), ['Lee Leader', 'Remy Rep', 'Rita Rep'], 'the leader sees everyone booked');
    const byName = new Map<string, Json>(plans.map((p: Json) => [p.userName, p]));
    // ⌈10 ÷ 3⌉ = 4; Remy's good day 4 → a tie → the event's share
    assert.deepEqual([byName.get('Remy Rep').targetSales, byName.get('Remy Rep').targetSource], [4, 'event']);
    // Lee has no shifts: the venue's good day (Rita's 2 a shift → 2); the share 4 is more than 1.5 × 2, so he aims for
    // a good day there and the page says why; venue weight 1
    const lee = byName.get('Lee Leader');
    assert.deepEqual([lee.targetSales, lee.targetSource, lee.eventShare, lee.shareAboveGoodDay, lee.venueWeight], [2, 'venue-good-day', 4, true, 1]);
    // the event target 1 ÷ 3 → 1: Remy's good day 4 wins; Lee (no shifts) gets the venue's good day 2
    run(srv.db, `UPDATE events SET target_sales = 1 WHERE id = ?`, [fx.events.tomorrowA]);
    srv.resetCache();
    const low = new Map<string, Json>((await leader.get(`/events/${fx.events.tomorrowA}/plan`)).json.map((p: Json) => [p.userName, p]));
    assert.deepEqual([low.get('Remy Rep').targetSales, low.get('Remy Rep').targetSource], [4, 'good-day']);
    assert.deepEqual([low.get('Lee Leader').targetSales, low.get('Lee Leader').targetSource, low.get('Lee Leader').goodDay], [2, 'venue-good-day', 2]);
  });

  test('who sees whose plan: own only for reps; ?userId for the team\'s leader and the admin', async () => {
    const mine = (await repA2.get(`/events/${fx.events.tomorrowA}/plan`)).json;
    assert.deepEqual(mine.map((p: Json) => p.userId), [fx.users.repA2]);
    assert.equal((await repA2.get(`/events/${fx.events.tomorrowA}/plan?userId=${fx.users.rep}`)).status, 403);
    assert.equal((await repA2.get(`/events/${fx.events.tomorrowA}/plan?userId=${fx.users.repA2}`)).json.length, 1);
    assert.deepEqual((await leader.get(`/events/${fx.events.tomorrowA}/plan?userId=${fx.users.rep}`)).json.map((p: Json) => p.userId), [fx.users.rep]);
    assert.equal((await admin.get(`/events/${fx.events.tomorrowA}/plan`)).json.length, 3);
    assert.deepEqual((await recruiter.get(`/events/${fx.events.tomorrowA}/plan`)).json, [], 'not booked, not managing');
    assert.equal((await recruiter.get(`/events/${fx.events.tomorrowA}/plan?userId=${fx.users.rep}`)).status, 403);
    // another team's leader sees only their own plan (none)
    const leaderB = await srv.login('repB');
    assert.deepEqual((await leaderB.get(`/events/${fx.events.tomorrowA}/plan`)).json, []);
  });

  test('no plans on finished events or with LM_SMART=0; the plan is cached and a booking refreshes it', async () => {
    assert.deepEqual((await admin.get(`/events/${fx.events.yesterdayA}/plan`)).json, []);
    await withSmart('0', async () => {
      srv.resetCache();
      assert.deepEqual((await rep.get(`/events/${fx.events.todayA}/plan`)).json, []);
    });
    srv.resetCache();
    const a = await rep.get(`/events/${fx.events.todayA}/plan`);
    const b = await rep.get(`/events/${fx.events.todayA}/plan`);
    assert.equal(a.headers.get('x-cache'), 'MISS');
    assert.equal(b.headers.get('x-cache'), 'HIT');
    assert.equal(b.json.length, 1);
    await rep.del(`/events/${fx.events.todayA}/roster/me`);
    const c = await rep.get(`/events/${fx.events.todayA}/plan`);
    assert.equal(c.headers.get('x-cache'), 'MISS');
    assert.deepEqual(c.json, []);
  });
});

// ───────────────────────────── venues ─────────────────────────────

describe('venues: the list, the profile and who sees what', () => {
  let srv: TestServer;
  let fx: Fixture;
  let rep: TestClient;
  let leader: TestClient;
  let admin: TestClient;
  let recruiter: TestClient;
  before(async () => {
    srv = await startTestServer();
    fx = srv.fixture!;
    const db = srv.db;
    // Test Venue (however it is typed): repA2 × 6 (60 stops, 3 sales), rep × 3 (90, 3), repB (team B) × 3 (50, 1)
    shifts(db, fx, fx.users.repA2, 'Test Venue', range(3, 8), 60, 3);
    shifts(db, fx, fx.users.rep, 'test  venue', range(9, 11), 90, 3);
    const today = todayISO();
    for (const d of [12, 13, 14]) {
      const date = addDays(today, -d);
      const id = venueEvent(db, fx, { venue: 'TEST VENUE', city: 'manchester', date, teamId: fx.teams.b });
      addGauge(db, { eventId: id, userId: fx.users.repB, date, stops: 50, sales: 1 });
    }
    // Mill Gate, Bury: rep × 2 (40, 2)
    shifts(db, fx, fx.users.rep, 'Mill Gate', [20, 21], 40, 2);
    // only ever cancelled: left out of the list
    venueEvent(db, fx, { venue: 'Ghost Hall', date: addDays(today, -5), status: 'cancelled' });
    // today's live event at Test Venue: its gauges do not count yet
    addGauge(db, { eventId: fx.events.todayA, userId: fx.users.rep, date: today, stops: 500, sales: 0 });
    srv.resetCache();
    rep = await srv.login('rep');
    leader = await srv.login('leader');
    admin = await srv.login('admin');
    recruiter = await srv.login('recruiter');
  });
  after(() => srv.close());

  test('the list: one row per venue key, finished days only, sorted three ways', async () => {
    const r = await rep.get('/venues');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.map((v: Json) => v.key), [TEST_VENUE, venueKey('Mill Gate', 'Manchester')], 'Ghost Hall (cancelled only) is left out');
    const tv = r.json[0];
    // 6 × 3 + 3 × 3 + 3 × 1 = 30 sales over 12 shifts = 2.5 a shift; 6 × 60 + 3 × 90 + 3 × 50 = 780 stops
    assert.equal(tv.shifts, 12);
    assert.equal(tv.sales, 30);
    assert.equal(tv.salesPerShift, 2.5);
    assert.equal(tv.stops, 780);
    assert.equal(tv.eventCount, 12, 'visits: events with a counted shift');
    assert.equal(tv.lastVisit, addDays(todayISO(), -3));
    assert.equal(tv.nextVisit, todayISO(), 'today\'s live event');
    assert.deepEqual(tv.campaigns, ['FXC']);
    const mg = r.json[1];
    assert.deepEqual([mg.shifts, mg.salesPerShift, mg.nextVisit], [2, 2, null]);
    assert.deepEqual((await rep.get('/venues?sort=last_visit')).json.map((v: Json) => v.venue), ['Test Venue', 'Mill Gate']);
    assert.deepEqual((await rep.get('/venues?sort=shifts')).json.map((v: Json) => v.shifts), [12, 2]);
  });

  test('the profile: per shift, the company, the law of averages, events; anonymous for a rep', async () => {
    const r = await rep.get(`/venues/${TEST_VENUE}`);
    assert.equal(r.status, 200);
    const p = r.json;
    assert.equal(p.shifts, 12);
    // 780 / 274 / 141 / 54 / 36 / 30 over 12 shifts (helpers' funnelFrom: 90 × 0.35 is 31.499… in floating point → 31)
    assert.deepEqual(p.perShift, { stops: 65, table: 22.8, presentations: 11.8, closes: 4.5, taps: 3, sales: 2.5 });
    // the company adds Mill Gate's 2 shifts: 34 sales over 14 shifts
    assert.equal(p.company.shifts, 14);
    assert.equal(p.company.salesPerShift, 2.43);
    // fitted rate = 30 ÷ 780 = 0.03846; every 26 stops a sale
    assert.equal(p.lawOfAverages.fittedRate, 0.03846);
    assert.equal(p.lawOfAverages.stopsPerSale, 26);
    assert.equal(p.lawOfAverages.points.length, 12);
    for (const pt of p.lawOfAverages.points) assert.deepEqual(Object.keys(pt).sort(), ['date', 'sales', 'stops'], 'anonymous points');
    assert.equal(p.lawOfAverages.bands.length, 3);
    assert.match(p.lawOfAverages.sentence, /^At Test Venue, every 26 stops made a sale on average/);
    assert.ok(p.lawOfAverages.steadiness.overallConversion, '12 visits: stability is measured');
    assert.equal(p.lawOfAverages.visits, 12);
    assert.ok(!('people' in p), 'no named rows for a rep');
    // the rep's own three shifts: 90 / 3 each
    assert.deepEqual([p.you.shifts, p.you.sales, p.you.salesPerShift, p.you.perShift.stops], [3, 9, 3, 90]);
    // every event, newest first: today's live one and tomorrow's scheduled one too
    assert.equal(p.events[0].date, addDays(todayISO(), 1));
    assert.ok(p.events.some((e: Json) => e.id === fx.events.todayA && e.status === 'live'));
    assert.equal(p.byCampaign.length, 1);
    assert.equal(p.byCampaign[0].shifts, 12);
    // the campaign here against the same campaign everywhere (Mill Gate's 2 shifts too): the six gauges and the ratios
    assert.deepEqual(p.byCampaign[0].perShift, p.perShift);
    assert.deepEqual(p.byCampaign[0].ratios, p.ratios);
    assert.equal(p.byCampaign[0].company.shifts, 14);
    assert.equal(p.byCampaign[0].company.salesPerShift, 2.43);
    assert.deepEqual(p.byCampaign[0].company.perShift, p.company.perShift);
    assert.equal(p.byWeekday.reduce((n: number, d: Json) => n + d.shifts, 0), 12);
    // each weekday: its six gauges here, its ratios, and the same weekday company-wide (never fewer shifts than here)
    for (const d of p.byWeekday) {
      assert.deepEqual(Object.keys(d.perShift).sort(), ['closes', 'presentations', 'sales', 'stops', 'table', 'taps']);
      assert.ok(Math.abs(d.perShift.sales - d.salesPerShift) <= 0.05 + 1e-9, 'the same sales a shift, to 1 dp');
      assert.ok(d.ratios && typeof d.ratios.stopToTable === 'number');
      assert.ok(d.company.shifts >= d.shifts, `weekday ${d.weekday}`);
    }
    assert.equal(p.byWeekday.reduce((n: number, d: Json) => n + d.company.shifts, 0), 14, 'company-wide by weekday covers every counted shift');
    assert.ok(!('people' in (await recruiter.get(`/venues/${TEST_VENUE}`)).json), 'nor for a recruiter');
  });

  test('named rows: the admin sees everyone; a leader their own team only', async () => {
    const all = (await admin.get(`/venues/${TEST_VENUE}`)).json.people;
    // by sales per shift, then shifts: Rita and Remy both sell 3 a shift; Rita has more shifts
    assert.deepEqual(all.map((x: Json) => [x.name, x.shifts, x.salesPerShift]), [['Rita Rep', 6, 3], ['Remy Rep', 3, 3], ['Bo Rep', 3, 1]]);
    const team = (await leader.get(`/venues/${TEST_VENUE}`)).json.people;
    assert.deepEqual(team.map((x: Json) => x.name), ['Rita Rep', 'Remy Rep'], 'Bo is on team B');
  });

  test('cached per caller; a new gauge shows on the next read', async () => {
    srv.resetCache();
    const a = await rep.get('/venues');
    const b = await rep.get('/venues');
    assert.equal(a.headers.get('x-cache'), 'MISS');
    assert.equal(b.headers.get('x-cache'), 'HIT');
    const p1 = await rep.get(`/venues/${TEST_VENUE}`);
    const p2 = await rep.get(`/venues/${TEST_VENUE}`);
    assert.equal(p1.headers.get('x-cache'), 'MISS');
    assert.equal(p2.headers.get('x-cache'), 'HIT');
    // a gauge written through the API bumps the data version
    const date = addDays(todayISO(), -1);
    const g = await admin.post('/gauges', { eventId: fx.events.yesterdayA, userId: fx.users.repA2, date, stops: 70, table: 20, presentations: 10, closes: 5, taps: 3, sales: 2 });
    assert.equal(g.status, 201, JSON.stringify(g.json));
    const after = await rep.get('/venues');
    assert.equal(after.headers.get('x-cache'), 'MISS');
    assert.equal(after.json[0].shifts, 13);
  });
});

// ───────────────────────────── the demo seed ─────────────────────────────

describe('the demo seed', () => {
  let srv: TestServer;
  before(async () => {
    srv = await startTestServer({ seed: true });
  });
  after(() => srv.close());

  test('demo bookings: Jordan on his team\'s first three upcoming events, not the fourth; only event_roster rows', async () => {
    const db = srv.db;
    const jordan = Number(all<{ id: number }>(db, `SELECT id FROM users WHERE employee_id = 'LM-0010'`)[0]!.id);
    const team = Number(all<{ t: number }>(db, `SELECT team_id AS t FROM users WHERE id = ?`, [jordan])[0]!.t);
    const upcoming = all<{ id: number; jordan: number }>(
      db,
      `SELECT e.id, EXISTS (SELECT 1 FROM event_roster r WHERE r.event_id = e.id AND r.user_id = ?) AS jordan
       FROM events e WHERE e.team_id = ? AND e.status IN ('scheduled', 'live') AND e.date >= ? AND e.date <= ? ORDER BY e.date, e.start_time, e.id`,
      [jordan, team, todayISO(), addDays(todayISO(), 13)],
    );
    if (upcoming.length >= 4) assert.deepEqual(upcoming.slice(0, 4).map((e) => Number(e.jordan)), [1, 1, 1, 0]);
    // every booking is a staff member of a field role, on a scheduled or live event in the next two weeks
    const odd = all(
      db,
      `SELECT r.event_id FROM event_roster r JOIN users u ON u.id = r.user_id JOIN events e ON e.id = r.event_id
       WHERE u.role NOT IN ('rep', 'leader') OR e.status NOT IN ('scheduled', 'live') OR e.date < ? OR r.source NOT IN ('leader', 'self')`,
      [todayISO()],
    );
    assert.deepEqual(odd, []);
  });

  test('the demo rep sees his plan and every venue; the venue list and a profile answer quickly', async () => {
    const rep = await srv.login('rep');
    const events = (await rep.get('/events')).json as Json[];
    const mine = events.find((e) => e.bookings?.me && (e.status === 'scheduled' || e.status === 'live'));
    if (mine) {
      const plans = (await rep.get(`/events/${mine.id}/plan`)).json;
      assert.equal(plans.length, 1);
      assert.equal(plans[0].steps.length, 5);
      assert.match(plans[0].sentence, /^To make \d+ sales? at .+ you need about [\d,]+ stops → /);
    }
    srv.resetCache();
    const t0 = performance.now();
    const list = await rep.get('/venues');
    const t1 = performance.now();
    assert.ok(list.json.length > 20);
    const profile = await rep.get(`/venues/${list.json[0].key}`);
    const t2 = performance.now();
    assert.equal(profile.status, 200);
    assert.ok(!('people' in profile.json));
    assert.ok(t1 - t0 < 1000 && t2 - t1 < 1000, `list ${Math.round(t1 - t0)} ms, profile ${Math.round(t2 - t1)} ms`);
  });
});
