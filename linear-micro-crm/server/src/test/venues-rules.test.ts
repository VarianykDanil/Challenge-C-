/**
 * P8 venue-insights — the booking rules the 1.3 review asked for, on the small fixture with the business clock pinned
 * to a Thursday at 12:00 (live events are half done):
 *  - bookings feed EVERY forecast: GET /events, the Needs-attention "behind target" item and the digest read the same
 *    numbers (eventForecasts reads the bookings itself, whoever calls it);
 *  - who is expected to work: people who logged on a live event without a booking (walk-ups) count; self-bookings alone
 *    are a floor under the team's usual turnout until a leader books anyone; the plan's share uses the same headcount,
 *    and a share far above a good day is a note, not the aim;
 *  - leavers drop off every count, list and plan; error messages never name people outside the caller's scope; a
 *    leader sees a plan built from the venue's numbers only for someone booked from another team;
 *  - GET /events carries the caller's own aim on the events they are booked on (no request per row).
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { addDays, setBusinessClock, todayISO } from '../lib/dates.ts';
import { getEvent } from '../db/queries.ts';
import { run } from '../db/connection.ts';
import { eventForecasts, eventHeadcounts } from '../lib/smart/eventForecast.ts';
import { eventPlans } from '../lib/venueInsights.ts';
import { bumpDataVersion } from '../lib/cache.ts';
import { getUser, listEvents } from '../db/queries.ts';
import type { Db } from '../db/connection.ts';
import { addClientUser, addGauge, addHistory, startTestServer, withSmart, type Fixture, type Json, type TestClient, type TestServer } from './helpers.ts';

const TODAY = '2026-10-15'; // a Thursday
setBusinessClock(new Date(`${TODAY}T12:00:00`)); // TZ=Europe/London in the server test script

after(() => setBusinessClock(null));

const ev = (list: Json[], id: number) => list.find((e) => e.id === id);

/** Count every SQL statement prepared or executed on `db` while `fn` runs (as events-forecast.test.ts does). */
function countStatements<T>(db: Db, fn: () => T): { result: T; statements: number } {
  const proto = Object.getPrototypeOf(db) as { prepare: Db['prepare']; exec: Db['exec'] };
  let statements = 0;
  const prepare = db.prepare;
  const exec = db.exec;
  Object.assign(db, {
    prepare: (sql: string) => {
      statements++;
      return proto.prepare.call(db, sql);
    },
    exec: (sql: string) => {
      statements++;
      return proto.exec.call(db, sql);
    },
  });
  try {
    return { result: fn(), statements };
  } finally {
    Object.assign(db, { prepare, exec });
  }
}

describe('bookings feed every forecast, and who is expected to work', () => {
  let srv: TestServer;
  let fx: Fixture;
  let admin: TestClient;
  let leader: TestClient;
  let rep: TestClient;
  before(async () => {
    srv = await startTestServer();
    fx = srv.fixture!;
    assert.equal(todayISO(), TODAY);
    // team A, 4 weeks × 4 days: rep and repA2 on the same completed private sites, 3 sales each → 2 people usually, rate 3
    addHistory(srv.db, { userId: fx.users.rep, teamId: fx.teams.a, campaignId: fx.campaignId, weeks: 4, stops: 60, sales: 3 });
    addHistory(srv.db, { userId: fx.users.repA2, teamId: fx.teams.a, campaignId: fx.campaignId, weeks: 4, stops: 60, sales: 3 });
    srv.resetCache();
    admin = await srv.login('admin');
    leader = await srv.login('leader');
    rep = await srv.login('rep');
  });
  after(() => srv.close());

  test('a live event with one person booked: /events, /me/attention and a bare eventForecasts call agree', async () => {
    // target 4 at 12:00 (half the day left): the team's habit (E = 6) expects 0 + 6 × 0.5 = 3 ≥ 2.8 → not behind; one
    // person booked (E = 3) expects 1.5 < 2.8 → behind target
    run(srv.db, `UPDATE events SET target_sales = 4 WHERE id = ?`, [fx.events.todayA]);
    srv.resetCache();
    assert.equal((await leader.get(`/events/${fx.events.todayA}`)).json.forecast.flag, null, 'habit: on track');
    assert.equal((await leader.put(`/events/${fx.events.todayA}/roster`, { userIds: [fx.users.rep] })).status, 200);
    const routed = (await leader.get(`/events/${fx.events.todayA}`)).json.forecast;
    assert.equal(routed.expectedReps, 1);
    assert.equal(routed.flag, 'at_risk');
    // the attention feed and the digest call eventForecasts with events that carry no `bookings` key
    const bare = eventForecasts(srv.db, [getEvent(srv.db, fx.events.todayA)!], TODAY).get(fx.events.todayA)!;
    assert.deepEqual(bare, routed, 'the same forecast whoever asks');
    const feed = (await leader.get('/me/attention')).json;
    assert.ok(feed.items.some((i: Json) => i.key === `events:behind:${fx.events.todayA}`), 'Needs attention follows the row');
    await leader.put(`/events/${fx.events.todayA}/roster`, { userIds: [] });
    run(srv.db, `UPDATE events SET target_sales = 10 WHERE id = ?`, [fx.events.todayA]);
  });

  test('walk-ups on a live event count: expected = the larger of those booked and those who logged', async () => {
    await leader.put(`/events/${fx.events.todayA}/roster`, { userIds: [fx.users.rep, fx.users.repA2] });
    for (const userId of [fx.users.rep, fx.users.repA2, fx.users.leader]) addGauge(srv.db, { eventId: fx.events.todayA, userId, date: TODAY, stops: 30, sales: 1 });
    srv.resetCache();
    const f = (await leader.get(`/events/${fx.events.todayA}`)).json.forecast;
    assert.equal(f.expectedReps, 3, '2 booked, 3 logged');
    assert.equal(f.expectedSales, 9);
    run(srv.db, `DELETE FROM gauge_entries WHERE event_id = ?`, [fx.events.todayA]);
    await leader.put(`/events/${fx.events.todayA}/roster`, { userIds: [] });
  });

  test('self-bookings alone are a floor under the usual turnout; once a leader books anyone, the people booked count', async () => {
    run(srv.db, `UPDATE events SET target_sales = 19 WHERE id = ?`, [fx.events.tomorrowA]);
    srv.resetCache();
    await rep.post(`/events/${fx.events.tomorrowA}/roster/me`);
    const early = (await rep.get(`/events/${fx.events.tomorrowA}`)).json.forecast;
    assert.equal(early.expectedReps, 2, '1 booked themself, 2 usually: still 2');
    const plan = (await rep.get(`/events/${fx.events.tomorrowA}/plan`)).json[0];
    // ⌈19 ÷ 2⌉ = 10 each, far above Remy's good day (3 a shift) → the plan aims for the good day and says why
    assert.equal(plan.eventShare, 10);
    assert.equal(plan.sharedAmong, 2);
    assert.equal(plan.goodDay, 3);
    assert.equal(plan.targetSales, 3);
    assert.equal(plan.targetSource, 'good-day');
    assert.equal(plan.shareAboveGoodDay, true);
    // the leader books the crew: from now on the people booked are the estimate (1 + 2 here)
    await leader.put(`/events/${fx.events.tomorrowA}/roster`, { userIds: [fx.users.rep, fx.users.repA2, fx.users.leader] });
    const managed = (await rep.get(`/events/${fx.events.tomorrowA}`)).json.forecast;
    assert.equal(managed.expectedReps, 3);
    const after = (await rep.get(`/events/${fx.events.tomorrowA}/plan`)).json[0];
    assert.deepEqual([after.eventShare, after.sharedAmong, after.targetSales, after.targetSource, after.shareAboveGoodDay], [7, 3, 3, 'good-day', true]);
    // a share within 1.5 × the good day is the aim: target 12 → ⌈12 ÷ 3⌉ = 4 ≤ 4.5
    run(srv.db, `UPDATE events SET target_sales = 12 WHERE id = ?`, [fx.events.tomorrowA]);
    srv.resetCache();
    const near = (await rep.get(`/events/${fx.events.tomorrowA}/plan`)).json[0];
    assert.deepEqual([near.eventShare, near.targetSales, near.targetSource], [4, 4, 'event']);
    assert.ok(!near.shareAboveGoodDay);
    await leader.put(`/events/${fx.events.tomorrowA}/roster`, { userIds: [] });
    run(srv.db, `UPDATE events SET target_sales = 10 WHERE id = ?`, [fx.events.tomorrowA]);
  });

  test('someone who leaves drops off the counts, the roster, the plans and the forecast', async () => {
    await leader.put(`/events/${fx.events.tomorrowA}/roster`, { userIds: [fx.users.rep, fx.users.repA2, fx.users.leader] });
    assert.equal((await admin.patch(`/users/${fx.users.repA2}`, { status: 'left' })).status, 200);
    const e = (await leader.get(`/events/${fx.events.tomorrowA}`)).json;
    assert.equal(e.bookings.booked, 2);
    assert.equal(e.forecast.expectedReps, 2);
    assert.deepEqual((await leader.get(`/events/${fx.events.tomorrowA}/roster`)).json.map((b: Json) => b.userId).sort(), [fx.users.rep, fx.users.leader].sort());
    assert.deepEqual((await leader.get(`/events/${fx.events.tomorrowA}/plan`)).json.map((p: Json) => p.userId).sort(), [fx.users.rep, fx.users.leader].sort());
    // saving the list the leader sees keeps the leaver's row as it was (no audit noise); back at work, booked again
    const saved = await leader.put(`/events/${fx.events.tomorrowA}/roster`, { userIds: [fx.users.rep, fx.users.leader] });
    assert.equal(saved.status, 200);
    assert.equal((await admin.patch(`/users/${fx.users.repA2}`, { status: 'active' })).status, 200);
    assert.equal((await leader.get(`/events/${fx.events.tomorrowA}`)).json.bookings.booked, 3);
    await leader.put(`/events/${fx.events.tomorrowA}/roster`, { userIds: [] });
  });

  test("roster errors never name people outside the caller's scope", async () => {
    const clientId = addClientUser(srv.db, { campaignId: fx.campaignId, firstName: 'Hana', lastName: 'Client' });
    for (const who of [leader, admin]) {
      const r = await who.put(`/events/${fx.events.tomorrowA}/roster`, { userIds: [clientId] });
      assert.equal(r.status, 400);
      assert.equal(r.json.error, `Unknown person (id ${clientId})`);
    }
    const other = await leader.put(`/events/${fx.events.tomorrowA}/roster`, { userIds: [fx.users.repB] });
    assert.equal(other.status, 400);
    assert.doesNotMatch(other.json.error, /Bo Rep/);
    assert.equal(other.json.error, `That person is not on the Team A team (id ${fx.users.repB})`);
    const office = await leader.put(`/events/${fx.events.tomorrowA}/roster`, { userIds: [fx.users.recruiter] });
    assert.doesNotMatch(office.json.error, /Rae/);
    // the admin sees every member of staff, so the name helps
    assert.equal((await admin.put(`/events/${fx.events.tomorrowA}/roster`, { userIds: [fx.users.recruiter] })).json.error, 'Rae Recruiter cannot be booked on an event');
  });
});

describe('plans: other teams and the events list', () => {
  let srv: TestServer;
  let fx: Fixture;
  let admin: TestClient;
  let leader: TestClient;
  let rep: TestClient;
  let repB: TestClient;
  before(async () => {
    srv = await startTestServer();
    fx = srv.fixture!;
    addHistory(srv.db, { userId: fx.users.rep, teamId: fx.teams.a, campaignId: fx.campaignId, weeks: 4, stops: 60, sales: 3 });
    addHistory(srv.db, { userId: fx.users.repA2, teamId: fx.teams.a, campaignId: fx.campaignId, weeks: 4, stops: 60, sales: 3 });
    // Bo (team B) sells 6 a shift at Bo Hall: his good day is his own business, not team A's leader's
    addHistory(srv.db, { userId: fx.users.repB, teamId: fx.teams.b, campaignId: fx.campaignId, weeks: 4, stops: 80, sales: 6 });
    run(srv.db, `UPDATE events SET venue = 'Bo Hall' WHERE team_id = ? AND status = 'completed'`, [fx.teams.b]);
    srv.resetCache();
    admin = await srv.login('admin');
    leader = await srv.login('leader');
    rep = await srv.login('rep');
    repB = await srv.login('repB');
  });
  after(() => srv.close());

  test("a leader sees a venue-only plan for someone booked from another team; the admin and the person see it all", async () => {
    await admin.put(`/events/${fx.events.tomorrowA}/roster`, { userIds: [fx.users.repB, fx.users.rep] });
    const theirs = (await leader.get(`/events/${fx.events.tomorrowA}/plan?userId=${fx.users.repB}`)).json[0];
    assert.equal(theirs.limited, true);
    assert.equal(theirs.basis.ownShifts, 0, 'none of his own numbers');
    // a good day at Test Venue (team A's 3 a shift), not his 6; the steps from the venue's ratios alone
    assert.deepEqual([theirs.goodDay, theirs.targetSource, theirs.venueWeight], [3, 'venue-good-day', 1]);
    const full = (await admin.get(`/events/${fx.events.tomorrowA}/plan?userId=${fx.users.repB}`)).json[0];
    assert.ok(!full.limited);
    assert.equal(full.goodDay, 6);
    assert.equal(full.basis.ownShifts, 16);
    assert.deepEqual((await repB.get(`/events/${fx.events.tomorrowA}/plan`)).json[0].goodDay, 6, 'his own plan in full');
    // the leader's own team member: in full
    const remy = (await leader.get(`/events/${fx.events.tomorrowA}/plan?userId=${fx.users.rep}`)).json[0];
    assert.ok(!remy.limited);
    assert.equal(remy.basis.ownShifts, 16);
    await admin.put(`/events/${fx.events.tomorrowA}/roster`, { userIds: [] });
  });

  test('GET /events carries the caller\'s own aim on the open events they are booked on, the same as the plan', async () => {
    await admin.put(`/events/${fx.events.tomorrowA}/roster`, { userIds: [] });
    await rep.post(`/events/${fx.events.tomorrowA}/roster/me`);
    await rep.post(`/events/${fx.events.todayA}/roster/me`);
    const list = (await rep.get('/events')).json as Json[];
    for (const id of [fx.events.tomorrowA, fx.events.todayA]) {
      const plan = (await rep.get(`/events/${id}/plan`)).json[0];
      assert.deepEqual(ev(list, id).bookings.aim, { targetSales: plan.targetSales, steps: plan.steps }, `aim on ${id}`);
      assert.deepEqual((await rep.get(`/events/${id}`)).json.bookings.aim, ev(list, id).bookings.aim);
    }
    // the leader is not booked: bookings without an aim; nobody else's aim travels on the list
    const asLeader = (await leader.get('/events')).json as Json[];
    assert.deepEqual(ev(asLeader, fx.events.tomorrowA).bookings, { booked: 1, me: false });
    await withSmart('0', async () => {
      srv.resetCache();
      assert.deepEqual(ev((await rep.get('/events')).json, fx.events.tomorrowA).bookings, { booked: 1, me: true }, 'an aim is an estimate');
    });
    // a finished event never carries one
    run(srv.db, `INSERT INTO event_roster (event_id, user_id, booked_by, booked_at, source) VALUES (?, ?, ?, ?, 'self')`, [fx.events.yesterdayA, fx.users.rep, fx.users.rep, `${addDays(TODAY, -2)}T09:00:00.000Z`]);
    srv.resetCache();
    assert.deepEqual(ev((await rep.get('/events')).json, fx.events.yesterdayA).bookings, { booked: 1, me: true });
  });

  test('plans for many events cost a fixed number of statements, and none once remembered', () => {
    const db = srv.db;
    const me = getUser(db, fx.users.rep)!;
    const venues = ['Test Venue', 'Mill Gate', 'Bo Hall', 'Ash Court'];
    const ids = venues.flatMap((venue, i) => [1, 2, 3].map((d) => run(db, `INSERT INTO events (campaign_id, team_id, name, venue, city, type, date, start_time, end_time, status, target_sales, notes) VALUES (?, ?, ?, ?, 'Manchester', 'private_site', ?, '09:00', '17:00', 'scheduled', 12, NULL)`, [fx.campaignId, fx.teams.a, `${venue} ${d}`, venue, addDays(TODAY, d + 7 * i)]).lastInsertRowid));
    bumpDataVersion();
    const events = listEvents(db, `WHERE e.id IN (${ids.map(() => '?').join(',')})`, ids);
    const person = { userId: me.id, userName: 'Remy Rep', teamId: me.teamId };
    const requests = events.map((event) => ({ event, people: [person, { userId: fx.users.repA2, userName: 'Rita Rep', teamId: fx.teams.a }] }));
    const first = countStatements(db, () => eventPlans(db, requests, me, TODAY, eventHeadcounts(db, events, TODAY)));
    assert.equal(first.result.size, 12);
    // the forecast's headcount query, the venue index, the two people's last 8 weeks and the thin venues' shift sales,
    // once each: never per event or per person
    assert.equal(first.statements, 4, `${first.statements} statements for 12 events × 2 people`);
    const again = countStatements(db, () => eventPlans(db, requests, me, TODAY, eventHeadcounts(db, events, TODAY)));
    assert.equal(again.statements, 0, 'memoised until the data version moves');
    assert.deepEqual([...again.result], [...first.result]);
    run(db, `DELETE FROM events WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
    bumpDataVersion();
  });
});
