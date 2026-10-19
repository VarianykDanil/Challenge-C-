/**
 * p6 — event forecasts and "N / M logged". Three parts:
 *  - builder tests on a synthetic in-memory DB with a fixed date (hand-checked numbers, the fallback chain, at most 2
 *    statements per call and none once memoised, the roster counts, the kill switch, no writes);
 *  - a route test on the small fixture that writes gauges through the API (counts follow the data on the next read);
 *  - route tests on the full demo seed (dates shift with today): shapes and role scoping only, never seeded names, and
 *    they hold on a Sunday, when the seed has no events.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { EventType, SalesEventWithMeta } from '@lm/shared';
import { get, openDb, run, type Db } from '../db/connection.ts';
import { getEvent } from '../db/queries.ts';
import { createSchema } from '../db/schema.ts';
import { bumpDataVersion } from '../lib/cache.ts';
import { addDays, todayISO } from '../lib/dates.ts';
import { eventForecasts, eventRosters, forecastFor } from '../lib/smart/eventForecast.ts';
import { addEvent, addGauge, buildFixture, startTestServer, withSmart, type Fixture, type Json, type TestClient, type TestServer } from './helpers.ts';

// A Thursday. Team A's history: six completed private sites on the previous six Thursdays, three reps each.
const TODAY = '2026-10-15';

/** Count every SQL statement prepared or executed on `db` while `fn` runs. */
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

interface Setup {
  db: Db;
  fx: Fixture;
  ev: (id: number) => SalesEventWithMeta;
}

/**
 * Team A, private sites: 6 completed days (today − 7k, k = 1…6), reps logging 2 + 3 + 4 = 9 sales a day → 54 sales over
 * 18 rep-days, rate 3, expectedReps 3, E = 9. Team B, events: 6 completed days with one rep selling 5 → rate 5.
 * Plus an old team-A day 13 weeks back (outside both windows) with a huge score that must not count.
 */
function setup(opts: { teamADays?: number } = {}): Setup {
  const db = openDb(':memory:');
  createSchema(db);
  const fx = buildFixture(db, TODAY);
  const { campaignId } = fx;
  const days = opts.teamADays ?? 6;
  for (let k = 1; k <= days; k++) {
    const date = addDays(TODAY, -7 * k);
    const id = addEvent(db, { campaignId, teamId: fx.teams.a, date, type: 'private_site' });
    addGauge(db, { eventId: id, userId: fx.users.rep, date, stops: 60, sales: 2 });
    addGauge(db, { eventId: id, userId: fx.users.repA2, date, stops: 60, sales: 3 });
    addGauge(db, { eventId: id, userId: fx.users.leader, date, stops: 60, sales: 4 });
  }
  for (let k = 1; k <= 6; k++) {
    const date = addDays(TODAY, -7 * k - 1);
    const id = addEvent(db, { campaignId, teamId: fx.teams.b, date, type: 'event' });
    addGauge(db, { eventId: id, userId: fx.users.repB, date, stops: 80, sales: 5 });
  }
  const old = addDays(TODAY, -7 * 13);
  const oldId = addEvent(db, { campaignId, teamId: fx.teams.a, date: old, type: 'private_site' });
  addGauge(db, { eventId: oldId, userId: fx.users.rep, date: old, stops: 200, sales: 60 });
  return { db, fx, ev: (id) => getEvent(db, id)! };
}

describe('eventForecasts (synthetic DB, fixed date)', () => {
  test('team bucket: hand-checked forecast for a scheduled team-A private site', () => {
    const { db, fx, ev } = setup();
    const tomorrow = ev(fx.events.tomorrowA); // scheduled, target 10, private site
    const f = eventForecasts(db, [tomorrow], TODAY).get(tomorrow.id)!;
    assert.deepEqual(f, {
      expectedSales: 9,
      low: 4.1, // 9 − 1.64 × 3 = 4.08
      high: 13.9, // 9 + 4.92 = 13.92
      expectedReps: 3,
      perRepRate: 3,
      repsNeeded: 4, // ceil(10 ÷ 3)
      basisDays: 6,
      basis: 'team',
      flag: null, // 10 ≤ 1.3 × 9 = 11.7
      suggestedTarget: 9, // p60 of [9, 9, 9, 9, 9, 9]
    });
    db.close();
  });

  test("a target above 1.3E is a 'stretch'", () => {
    const { db, fx } = setup();
    run(db, `UPDATE events SET target_sales = 12 WHERE id = ?`, [fx.events.tomorrowA]);
    const e = getEvent(db, fx.events.tomorrowA)!;
    const f = eventForecasts(db, [e], TODAY).get(e.id)!;
    assert.equal(f.flag, 'stretch', '12 > 11.7');
    assert.equal(f.repsNeeded, 4);
    db.close();
  });

  test('fallback: no team history for the type → company (campaign + type) → campaign alone', () => {
    const { db, fx } = setup();
    // team A has never worked an 'event' day; team B has 6 of them at 5 sales per rep-day
    const eventDay = getEvent(db, addEvent(db, { campaignId: fx.campaignId, teamId: fx.teams.a, date: addDays(TODAY, 2), status: 'scheduled', type: 'event', targetSales: 20 }))!;
    // nobody has worked retail: the campaign's 12 recent days (54 + 30 sales over 18 + 6 rep-days = 3.5)
    const retailDay = getEvent(db, addEvent(db, { campaignId: fx.campaignId, teamId: fx.teams.a, date: addDays(TODAY, 3), status: 'scheduled', type: 'retail' }))!;
    const map = eventForecasts(db, [eventDay, retailDay], TODAY);
    const company = map.get(eventDay.id)!;
    assert.equal(company.basis, 'company');
    assert.equal(company.basisDays, 6);
    assert.equal(company.perRepRate, 5);
    assert.equal(company.expectedSales, 15, "team A's 3 usual reps × 5");
    assert.equal(company.suggestedTarget, 15, 'no team history for the type → round(E)');
    assert.equal(company.repsNeeded, 4, 'ceil(20 ÷ 5)');
    const campaign = map.get(retailDay.id)!;
    assert.equal(campaign.basis, 'campaign');
    assert.equal(campaign.basisDays, 12, 'the 13-week-old day is outside the 12-week window');
    assert.equal(campaign.perRepRate, 3.5);
    assert.equal(campaign.expectedSales, 10.5);
    db.close();
  });

  test('a team with fewer than 5 attended days in 8 weeks gets no forecast', () => {
    const { db, fx, ev } = setup({ teamADays: 4 });
    const tomorrow = ev(fx.events.tomorrowA);
    assert.equal(eventForecasts(db, [tomorrow], TODAY).size, 0);
    assert.equal(forecastFor(db, { campaignId: fx.campaignId, teamId: fx.teams.a, type: 'private_site', targetSales: 10 }, TODAY), null);
    db.close();
  });

  test("live events: 'at_risk' when sales so far + E × the rest of the day fall short of 0.7 × target", () => {
    const { db, fx } = setup();
    const liveId = addEvent(db, { campaignId: fx.campaignId, teamId: fx.teams.a, date: TODAY, status: 'live', startTime: '10:00', endTime: '18:00', targetSales: 20 });
    addGauge(db, { eventId: liveId, userId: fx.users.rep, date: TODAY, stops: 40, sales: 1 });
    const live = getEvent(db, liveId)!;
    // 16:00: a quarter of the day left → 1 + 9 × 0.25 = 3.25 < 14
    assert.equal(eventForecasts(db, [live], TODAY, '16:00').get(liveId)!.flag, 'at_risk');
    // 10:00 with target 12: 1 + 9 = 10 ≥ 8.4 → no flag; a live event is never a 'stretch'
    run(db, `UPDATE events SET target_sales = 12 WHERE id = ?`, [liveId]);
    const f = eventForecasts(db, [getEvent(db, liveId)!], TODAY, '10:00').get(liveId)!;
    assert.equal(f.flag, null);
    // today's live rows never feed attendance or the rate
    assert.equal(f.expectedReps, 3);
    assert.equal(f.perRepRate, 3);
    db.close();
  });

  test('completed and cancelled events get none; at most 2 statements per call whatever the number of events', () => {
    const { db, fx, ev } = setup();
    const all = Object.values(fx.events).map(ev);
    for (let i = 0; i < 25; i++) all.push(ev(addEvent(db, { campaignId: fx.campaignId, teamId: i % 2 ? fx.teams.a : fx.teams.b, date: addDays(TODAY, 1 + (i % 9)), status: 'scheduled', type: (['private_site', 'event', 'retail'] as EventType[])[i % 3] })));
    const cancelled = ev(addEvent(db, { campaignId: fx.campaignId, teamId: fx.teams.a, date: addDays(TODAY, 4), status: 'cancelled' }));
    all.push(cancelled);
    const tomorrow = ev(fx.events.tomorrowA);
    const one = countStatements(db, () => eventForecasts(db, [tomorrow], TODAY));
    bumpDataVersion(); // a fresh start, as after any write
    const many = countStatements(db, () => eventForecasts(db, all, TODAY));
    assert.equal(one.statements, 2);
    assert.equal(many.statements, 2);
    for (const e of all) {
      if (e.status === 'completed' || e.status === 'cancelled') assert.ok(!many.result.has(e.id), `no forecast for a ${e.status} event`);
    }
    assert.ok(many.result.has(fx.events.tomorrowA) && many.result.has(fx.events.todayA));
    // nothing to forecast → no query at all
    const yesterday = ev(fx.events.yesterdayA);
    const none = countStatements(db, () => eventForecasts(db, [yesterday, cancelled], TODAY));
    assert.equal(none.statements, 0);
    assert.equal(none.result.size, 0);
    db.close();
  });

  test('forecastFor: a planned event; without a target there is no repsNeeded or flag', () => {
    const { db, fx } = setup();
    const params = { campaignId: fx.campaignId, teamId: fx.teams.a, type: 'private_site' as const };
    const counted = countStatements(db, () => forecastFor(db, params, TODAY));
    assert.equal(counted.statements, 2);
    const noTarget = counted.result!;
    assert.equal(noTarget.expectedSales, 9);
    assert.equal(noTarget.repsNeeded, null);
    assert.equal(noTarget.flag, null);
    assert.equal(noTarget.suggestedTarget, 9);
    const withTarget = forecastFor(db, { ...params, targetSales: 12 }, TODAY)!;
    assert.equal(withTarget.repsNeeded, 4);
    assert.equal(withTarget.flag, 'stretch');
    // a campaign with no completed days at all → null
    const fresh = run(db, `INSERT INTO campaigns (name, code, sector, type, payout_per_sale, rep_commission_per_sale, color, active, start_date) VALUES ('New', 'NEW', 'charity', 'fundraising', 100, 40, '#000000', 1, ?)`, [TODAY]).lastInsertRowid;
    assert.equal(forecastFor(db, { ...params, campaignId: fresh }, TODAY), null);
    db.close();
  });

  test('memoised: the same lists cost no statement until the data version or the day moves', () => {
    const { db, fx, ev } = setup();
    const list = Object.values(fx.events).map(ev);
    const first = countStatements(db, () => eventForecasts(db, list, TODAY));
    assert.equal(first.statements, 2);
    const again = countStatements(db, () => eventForecasts(db, list, TODAY));
    assert.equal(again.statements, 0, 'both grouped results are remembered');
    assert.deepEqual([...again.result], [...first.result]);
    // the live flag still follows the clock with no query: only the per-event maths runs
    const late = countStatements(db, () => eventForecasts(db, list, TODAY, '23:58'));
    assert.equal(late.statements, 0);
    // a write (here a seventh completed team-A day, as POST /gauges would leave it) is seen once the version moves
    const date = addDays(TODAY, -2);
    const extra = addEvent(db, { campaignId: fx.campaignId, teamId: fx.teams.a, date, type: 'private_site' });
    addGauge(db, { eventId: extra, userId: fx.users.rep, date, stops: 60, sales: 3 });
    bumpDataVersion();
    const after = countStatements(db, () => eventForecasts(db, list, TODAY));
    assert.equal(after.statements, 2);
    assert.equal(after.result.get(fx.events.tomorrowA)!.basisDays, 7);
    // another business day is another slot
    assert.equal(countStatements(db, () => eventForecasts(db, list, addDays(TODAY, 1))).statements, 2);
    db.close();
  });

  test("eventRosters: the team's own active members who had started by the day; admins and other teams do not count", () => {
    const { db, fx, ev } = setup();
    const yesterday = addDays(TODAY, -1);
    const person = (email: string, status: string, startDate: string) =>
      run(
        db,
        `INSERT INTO users (employee_id, email, first_name, last_name, role, position, team_id, pay_plan_id, start_date, status, phone, avatar_color, city)
         VALUES (?, ?, 'Pat', 'Person', 'rep', 'field_rep', ?, ?, ?, ?, NULL, '#4F46E5', 'Manchester')`,
        [`LM-9${email.length}${status.length}`, email, fx.teams.a, fx.plans.rep, startDate, status],
      ).lastInsertRowid;
    person('starts.today@example.com', 'active', TODAY); // on team A from today: not expected yesterday
    person('on.leave@example.com', 'on_leave', addDays(TODAY, -300)); // not active: never expected
    // yesterday at team A: one member logged, plus the admin (no team) and a team-B rep, who are not team A
    addGauge(db, { eventId: fx.events.yesterdayA, userId: fx.users.rep, date: yesterday, stops: 30, sales: 2 });
    addGauge(db, { eventId: fx.events.yesterdayA, userId: fx.users.admin, date: yesterday, stops: 30, sales: 2 });
    addGauge(db, { eventId: fx.events.yesterdayA, userId: fx.users.repB, date: yesterday, stops: 30, sales: 2 });
    const twoBack = addEvent(db, { campaignId: fx.campaignId, teamId: fx.teams.a, date: addDays(TODAY, -2) });
    const threeBack = addEvent(db, { campaignId: fx.campaignId, teamId: fx.teams.a, date: addDays(TODAY, -3) });
    const cancelled = addEvent(db, { campaignId: fx.campaignId, teamId: fx.teams.a, date: TODAY, status: 'cancelled' });
    const list = [...Object.values(fx.events), twoBack, threeBack, cancelled].map(ev);
    assert.equal(ev(fx.events.yesterdayA).repCount, 3, 'three people logged there');
    const counted = countStatements(db, () => eventRosters(db, list, TODAY));
    assert.equal(counted.statements, 1);
    const r = counted.result;
    assert.deepEqual(r.get(fx.events.yesterdayA), { members: 3, logged: 1 }, 'leader, rep and repA2; only rep is team A');
    assert.deepEqual(r.get(fx.events.todayA), { members: 4, logged: 0 }, 'the newcomer counts from today');
    assert.deepEqual(r.get(fx.events.yesterdayB), { members: 1, logged: 0 });
    assert.deepEqual(r.get(twoBack), { members: 3, logged: 0 });
    for (const id of [fx.events.tomorrowA, fx.events.tomorrowB, threeBack, cancelled]) assert.ok(!r.has(id), `no count for event ${id}`);
    for (const c of r.values()) assert.ok(c.logged <= c.members);
    assert.equal(countStatements(db, () => eventRosters(db, list, TODAY)).statements, 0, 'memoised');
    const outside = [ev(fx.events.tomorrowA), ev(threeBack)];
    bumpDataVersion();
    assert.equal(countStatements(db, () => eventRosters(db, outside, TODAY)).statements, 0, 'nothing in the window → no query');
    db.close();
  });

  test('LM_SMART=0: no forecasts and no queries; the builder never writes a row', async () => {
    const { db, fx, ev } = setup();
    const count = () => get<{ g: number; p: number; e: number }>(db, `SELECT (SELECT COUNT(*) FROM gauge_entries) AS g, (SELECT COUNT(*) FROM payroll_runs) AS p, (SELECT COUNT(*) FROM events) AS e`)!;
    const before = count();
    const tomorrow = ev(fx.events.tomorrowA);
    await withSmart('0', async () => {
      const off = countStatements(db, () => eventForecasts(db, [tomorrow], TODAY));
      assert.equal(off.result.size, 0);
      assert.equal(off.statements, 0);
      assert.equal(forecastFor(db, { campaignId: fx.campaignId, teamId: fx.teams.a, type: 'private_site' }, TODAY), null);
      const events = Object.values(fx.events).map(ev);
      const rosters = countStatements(db, () => eventRosters(db, events, TODAY));
      assert.equal(rosters.result.size, 0);
      assert.equal(rosters.statements, 0);
    });
    eventForecasts(db, Object.values(fx.events).map(ev), TODAY);
    eventRosters(db, Object.values(fx.events).map(ev), TODAY);
    forecastFor(db, { campaignId: fx.campaignId, teamId: fx.teams.a, type: 'private_site', targetSales: 10 }, TODAY);
    assert.deepEqual(count(), before);
    db.close();
  });
});

describe('GET /events roster counts (fixture server, writes through the API)', () => {
  let srv: TestServer;
  let admin: TestClient;
  let leader: TestClient;

  before(async () => {
    srv = await startTestServer();
    [admin, leader] = await Promise.all([srv.login('admin'), srv.login('leader')]);
  });
  after(async () => {
    await srv.close();
  });

  test("'N / M logged' counts the team only, never reads N > M, and follows a saved entry on the next read", async () => {
    const fx = srv.fixture!;
    const yesterday = addDays(fx.today, -1);
    const list = async (who: TestClient) => {
      const r = await who.get(`/events?from=${addDays(fx.today, -3)}&to=${addDays(fx.today, 3)}`);
      assert.equal(r.status, 200);
      return r.json as Json[];
    };
    const find = (rows: Json[], id: number) => rows.find((e) => e.id === id)!;
    let rows = await list(leader);
    assert.deepEqual(find(rows, fx.events.yesterdayA).roster, { members: 3, logged: 0 });
    assert.deepEqual(find(rows, fx.events.todayA).roster, { members: 3, logged: 0 });
    assert.ok(!('roster' in find(rows, fx.events.tomorrowA)), 'no count before the day');
    const g = { eventId: fx.events.yesterdayA, date: yesterday, stops: 20, table: 10, presentations: 6, closes: 3, taps: 2, sales: 2 };
    // the admin (no team) logs at team A's event: repCount moves, the team's count does not
    assert.equal((await admin.post('/gauges', { ...g, userId: fx.users.admin })).status, 201);
    let y = find(await list(leader), fx.events.yesterdayA);
    assert.equal(y.repCount, 1);
    assert.deepEqual(y.roster, { members: 3, logged: 0 });
    // the leader logs for a team member: the memoised count is replaced on the very next read
    assert.equal((await leader.post('/gauges', { ...g, userId: fx.users.rep })).status, 201);
    y = find(await list(leader), fx.events.yesterdayA);
    assert.equal(y.repCount, 2);
    assert.deepEqual(y.roster, { members: 3, logged: 1 });
    assert.deepEqual((await leader.get(`/events/${fx.events.yesterdayA}`)).json.roster, { members: 3, logged: 1 }, 'GET /events/:id agrees');
    // LM_SMART=0: the key is absent, as before the smart release
    await withSmart('0', async () => {
      srv.resetCache();
      for (const e of await list(admin)) assert.ok(!('roster' in e) && !('forecast' in e));
    });
    srv.resetCache();
  });
});

describe('GET /events forecasts on the demo seed', () => {
  let srv: TestServer;
  let admin: TestClient;
  let leader: TestClient;
  let recruiter: TestClient;
  let rep: TestClient;
  const today = todayISO();

  before(async () => {
    srv = await startTestServer({ seed: true });
    [admin, leader, recruiter, rep] = await Promise.all([srv.login('admin'), srv.login('leader'), srv.login('recruiter'), srv.login('rep')]);
  });
  after(async () => {
    await srv.close();
  });

  const FORECAST_KEYS = ['basis', 'basisDays', 'expectedReps', 'expectedSales', 'flag', 'high', 'low', 'perRepRate', 'repsNeeded', 'suggestedTarget'];

  function assertForecastShape(f: Json, e: Json): void {
    assert.deepEqual(Object.keys(f).sort(), FORECAST_KEYS);
    assert.ok(f.basisDays >= 5, 'basisDays ≥ 5');
    assert.ok(f.expectedReps > 0, 'expectedReps > 0');
    assert.ok(f.low <= f.expectedSales && f.expectedSales <= f.high, 'low ≤ expectedSales ≤ high');
    assert.ok(f.low >= 0);
    assert.ok(['team', 'company', 'campaign'].includes(f.basis));
    assert.ok(f.perRepRate > 0);
    assert.ok(f.repsNeeded === null || Number.isInteger(f.repsNeeded));
    assert.ok(Number.isInteger(f.suggestedTarget) && f.suggestedTarget >= 0);
    if (e.status === 'scheduled') assert.ok(f.flag === null || f.flag === 'stretch');
    if (e.status === 'live') assert.ok(f.flag === null || f.flag === 'at_risk');
  }

  test('next 14 days as the leader: every scheduled / live event has no forecast or a sound one', async () => {
    const r = await leader.get(`/events?from=${today}&to=${addDays(today, 14)}`);
    assert.equal(r.status, 200);
    for (const e of r.json as Json[]) {
      if (e.forecast === undefined || e.forecast === null) continue;
      assert.ok(e.status === 'scheduled' || e.status === 'live', `forecast only on scheduled / live (${e.status})`);
      assertForecastShape(e.forecast, e);
    }
  });

  test('completed and cancelled events carry no forecast', async () => {
    const r = await admin.get(`/events?from=${addDays(today, -14)}&to=${addDays(today, 7)}`);
    assert.equal(r.status, 200);
    for (const e of r.json as Json[]) {
      if (e.status === 'completed' || e.status === 'cancelled') assert.ok(!('forecast' in e), `${e.status} event ${e.id} has a forecast`);
    }
  });

  test('roster counts: only on completed / live events from today − 2, logged ≤ members, logged ≤ repCount', async () => {
    for (const who of [admin, leader, rep]) {
      const r = await who.get(`/events?from=${addDays(today, -7)}&to=${addDays(today, 7)}`);
      assert.equal(r.status, 200);
      for (const e of r.json as Json[]) {
        const inWindow = (e.status === 'completed' || e.status === 'live') && e.date <= today && e.date >= addDays(today, -2);
        if (!inWindow) {
          assert.ok(!('roster' in e), `event ${e.id} (${e.status}, ${e.date}) is outside the window`);
          continue;
        }
        assert.deepEqual(Object.keys(e.roster).sort(), ['logged', 'members']);
        assert.ok(Number.isInteger(e.roster.members) && Number.isInteger(e.roster.logged) && e.roster.logged >= 0);
        assert.ok(e.roster.logged <= e.roster.members, `event ${e.id}: ${e.roster.logged} / ${e.roster.members}`);
        assert.ok(e.roster.logged <= e.repCount);
      }
    }
  });

  test('GET /events/:id carries the same forecast as the list', async () => {
    const list = (await admin.get(`/events?from=${today}&to=${addDays(today, 14)}`)).json as Json[];
    const withForecast = list.find((e) => e.forecast && e.status === 'scheduled');
    if (!withForecast) return; // shape-only on a seed without forecasts
    const detail = await admin.get(`/events/${withForecast.id}`);
    assert.equal(detail.status, 200);
    assert.deepEqual(detail.json.forecast, withForecast.forecast);
  });

  test('reps see forecasts only on their own team calendar', async () => {
    const mine = (await rep.get('/auth/me')).json.user;
    const r = await rep.get(`/events?from=${today}&to=${addDays(today, 14)}`);
    assert.equal(r.status, 200);
    for (const e of r.json as Json[]) assert.equal(e.teamId, mine.teamId);
  });

  test('GET /events/forecast: a campaign created in the test → { forecast: null }; rep and recruiter → 403', async () => {
    const teams = (await admin.get('/teams')).json as Json[];
    const leaderMe = (await leader.get('/auth/me')).json.user;
    const code = `P6${String(Date.now() % 10000).padStart(4, '0')}`;
    const created = await admin.post('/campaigns', { name: `Forecast test ${code}`, code, sector: 'charity', type: 'fundraising', payoutPerSale: 100, repCommissionPerSale: 40, color: '#334455', active: true, startDate: today, description: null });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    const q = (teamId: number, campaignId = created.json.id) => `/events/forecast?campaignId=${campaignId}&teamId=${teamId}&type=private_site&targetSales=12`;
    const a = await admin.get(q(teams[0].id));
    assert.equal(a.status, 200);
    assert.deepEqual(a.json, { forecast: null });
    const l = await leader.get(q(leaderMe.teamId));
    assert.equal(l.status, 200);
    assert.deepEqual(l.json, { forecast: null });
    for (const client of [rep, recruiter]) assert.equal((await client.get(q(leaderMe.teamId))).status, 403);
    // an existing campaign answers 200 with a forecast or null, never anything else
    const campaigns = (await admin.get('/campaigns')).json as Json[];
    const f = await leader.get(q(leaderMe.teamId, campaigns[0].id));
    assert.equal(f.status, 200);
    if (f.json.forecast) assertForecastShape(f.json.forecast, { status: 'scheduled' });
  });
});
