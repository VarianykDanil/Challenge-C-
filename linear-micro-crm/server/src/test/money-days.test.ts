/**
 * MON-1: a self-logged gauge entry pays a base day only with evidence that the person worked — booked on the event or
 * checked in to it (and something logged), a leader or the office logged it for them, or a leader or the office
 * confirmed the day. An all-zero entry never makes a paid day on its own. Waiting days are listed for leaders.
 * Also: an existing (1.4.0-shaped) database keeps every day it already had.
 */
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { all, get, run, type Db } from '../db/connection.ts';
import { createSchema } from '../db/schema.ts';
import { materialisePayrollRuns } from '../db/maintenance.ts';
import { addDays, mondayOf, nowISO } from '../lib/dates.ts';
import { addEvent, addGauge, startTestServer, type Json, type TestClient, type TestServer } from './helpers.ts';

let srv: TestServer;
let fx: NonNullable<TestServer['fixture']>;
let admin: TestClient;
let leader: TestClient;
let rep: TestClient;
let repA2: TestClient;
let repB: TestClient;
let client: TestClient;
let lastWeek: string;
const ev: Record<string, number> = {};

const zero = { stops: 0, table: 0, presentations: 0, closes: 0, taps: 0, sales: 0 };
const some = { stops: 20, table: 8, presentations: 4, closes: 2, taps: 2, sales: 2 };

function runOf(db: Db, userId: number, week: string) {
  return get<{ id: number; daysWorked: number; basePay: number; commission: number; gross: number; status: string }>(
    db,
    `SELECT id, days_worked AS daysWorked, base_pay AS basePay, commission, gross, status FROM payroll_runs WHERE user_id = ? AND week_start = ?`,
    [userId, week],
  );
}

function book(db: Db, eventId: number, userId: number): void {
  run(db, `INSERT INTO event_roster (event_id, user_id, booked_by, booked_at, source) VALUES (?, ?, ?, ?, 'leader')`, [eventId, userId, fx.users.leader, nowISO()]);
}

function checkIn(db: Db, eventId: number, userId: number, date: string): void {
  run(db, `INSERT INTO check_ins (user_id, event_id, date, checked_in_at, source, created_at) VALUES (?, ?, ?, ?, 'button', ?)`, [userId, eventId, date, `${date}T08:55:00`, nowISO()]);
}

async function setup(): Promise<void> {
  srv = await startTestServer();
  fx = srv.fixture!;
  [admin, leader, rep, repA2, repB, client] = await Promise.all((['admin', 'leader', 'rep', 'repA2', 'repB', 'client'] as const).map((r) => srv.login(r)));
  lastWeek = addDays(mondayOf(fx.today), -7);
  for (const [k, d] of [['mon', 0], ['tue', 1], ['wed', 2], ['thu', 3], ['fri', 4]] as const) {
    ev[k] = addEvent(srv.db, { campaignId: fx.campaignId, teamId: fx.teams.a, date: addDays(lastWeek, d) });
  }
  ev.monB = addEvent(srv.db, { campaignId: fx.campaignId, teamId: fx.teams.b, date: lastWeek });
  ev.tueB = addEvent(srv.db, { campaignId: fx.campaignId, teamId: fx.teams.b, date: addDays(lastWeek, 1) });
  // history from before the check existed: Remy's Monday (one sale — the base beats the commission)
  addGauge(srv.db, { eventId: ev.mon!, userId: fx.users.rep, date: lastWeek, stops: 30, sales: 1 });
  addGauge(srv.db, { eventId: ev.monB!, userId: fx.users.repB, date: lastWeek, stops: 30, sales: 1 });
  // the runs of last week exist (as GET /finance/payroll makes them)
  const r = await admin.get('/finance/payroll');
  assert.equal(r.status, 200);
}

const post = (who: TestClient, eventKey: string, userId: number, offset: number, counts = some) =>
  who.post('/gauges', { eventId: ev[eventKey], userId, date: addDays(lastWeek, offset), ...counts });

describe('MON-1: a base day needs evidence that the person worked', () => {
  beforeEach(setup);
  afterEach(() => srv.close());

  test('the review probe: an all-zero self-logged day on an event the rep was not booked on pays nothing', async () => {
    const before = runOf(srv.db, fx.users.rep, lastWeek)!;
    assert.equal(before.daysWorked, 1);
    const r = await post(rep, 'tue', fx.users.rep, 1, zero);
    assert.equal(r.status, 201, JSON.stringify(r.json));
    const after = runOf(srv.db, fx.users.rep, lastWeek)!;
    assert.equal(after.daysWorked, 1, 'no new paid day');
    assert.equal(after.gross, before.gross, 'the pay did not move');
    // the leader sees it waiting, and why
    const list = await leader.get('/pay/day-checks');
    assert.equal(list.status, 200, JSON.stringify(list.json));
    const day = (list.json as Json[]).find((d) => d.userId === fx.users.rep && d.date === addDays(lastWeek, 1));
    assert.ok(day, JSON.stringify(list.json));
    assert.equal(day.reason, 'nothing_logged');
    assert.equal(day.weekStart, lastWeek);
    assert.equal(day.events[0].eventId, ev.tue);
    // the rep sees it on their own pay breakdown
    const mine = await rep.get(`/pay/breakdown?weekStart=${lastWeek}`);
    assert.deepEqual(mine.json.daysWaiting, [addDays(lastWeek, 1)]);
    assert.ok((mine.json.explanation as string[]).some((s) => /waiting for your leader/i.test(s)), JSON.stringify(mine.json.explanation));
  });

  test('a self-logged day with sales but no booking or check-in waits; the leader confirms it and it is paid', async () => {
    const before = runOf(srv.db, fx.users.rep, lastWeek)!;
    assert.equal((await post(rep, 'tue', fx.users.rep, 1)).status, 201);
    assert.equal(runOf(srv.db, fx.users.rep, lastWeek)!.daysWorked, 1);
    const list = await leader.get('/pay/day-checks');
    const day = (list.json as Json[]).find((d) => d.userId === fx.users.rep);
    assert.equal(day.reason, 'not_booked');
    const ok = await leader.post('/pay/day-checks', { userId: fx.users.rep, date: addDays(lastWeek, 1), decision: 'confirmed' });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.equal(ok.json.decision, 'confirmed');
    assert.equal(ok.json.byName, 'Lee Leader');
    const after = runOf(srv.db, fx.users.rep, lastWeek)!;
    assert.equal(after.daysWorked, 2);
    assert.ok(after.gross > before.gross);
    // gone from the list, recorded in the audit trail
    assert.equal(((await leader.get('/pay/day-checks')).json as Json[]).filter((d) => d.userId === fx.users.rep).length, 0);
    const audit = all<{ summary: string }>(srv.db, `SELECT summary FROM audit_log WHERE action = 'POST /pay/day-checks' AND entity = 'user'`);
    assert.equal(audit.length, 1);
    assert.ok(get(srv.db, `SELECT 1 FROM audit_log WHERE action = 'POST /pay/day-checks' AND entity = 'payroll_run' AND summary LIKE 'Recalculated after a day was confirmed%'`), 'and the run it moved');
    assert.match(audit[0]!.summary, /Confirmed a day worked: Remy Rep/);
  });

  test('booked on the event (or checked in) with something logged: the day is paid at once', async () => {
    book(srv.db, ev.tue!, fx.users.rep);
    assert.equal((await post(rep, 'tue', fx.users.rep, 1)).status, 201);
    assert.equal(runOf(srv.db, fx.users.rep, lastWeek)!.daysWorked, 2, 'booked');
    checkIn(srv.db, ev.wed!, fx.users.rep, addDays(lastWeek, 2));
    assert.equal((await post(rep, 'wed', fx.users.rep, 2)).status, 201);
    assert.equal(runOf(srv.db, fx.users.rep, lastWeek)!.daysWorked, 3, 'checked in');
    assert.equal(((await leader.get('/pay/day-checks')).json as Json[]).length, 0);
  });

  test('booked but nothing logged: an all-zero entry still waits', async () => {
    book(srv.db, ev.tue!, fx.users.rep);
    assert.equal((await post(rep, 'tue', fx.users.rep, 1, zero)).status, 201);
    assert.equal(runOf(srv.db, fx.users.rep, lastWeek)!.daysWorked, 1);
  });

  test('a leader logging for someone confirms the day; the office too', async () => {
    assert.equal((await post(leader, 'tue', fx.users.rep, 1)).status, 201);
    assert.equal(runOf(srv.db, fx.users.rep, lastWeek)!.daysWorked, 2);
    assert.equal((await post(admin, 'wed', fx.users.repA2, 2)).status, 201);
    assert.equal(runOf(srv.db, fx.users.repA2, lastWeek)!.daysWorked, 1);
  });

  test('"Not worked": the day is not paid even when the rep was booked', async () => {
    assert.equal((await post(rep, 'tue', fx.users.rep, 1)).status, 201);
    const no = await leader.post('/pay/day-checks', { userId: fx.users.rep, date: addDays(lastWeek, 1), decision: 'not_worked', note: 'Went home at 10' });
    assert.equal(no.status, 200, JSON.stringify(no.json));
    book(srv.db, ev.tue!, fx.users.rep);
    // a later edit by the rep does not bring the day back
    assert.equal((await post(rep, 'tue', fx.users.rep, 1, { ...some, sales: 3, closes: 3, taps: 3 })).status, 200);
    assert.equal(runOf(srv.db, fx.users.rep, lastWeek)!.daysWorked, 1);
    const mine = await rep.get(`/pay/breakdown?weekStart=${lastWeek}`);
    assert.deepEqual(mine.json.daysNotWorked, [addDays(lastWeek, 1)]);
  });

  test('who may confirm: the leader of the person\'s team (not their own day) or the office', async () => {
    // Bo is on team B: Lee leads team A
    assert.equal((await post(repB, 'tueB', fx.users.repB, 1)).status, 201);
    const notMine = await leader.post('/pay/day-checks', { userId: fx.users.repB, date: addDays(lastWeek, 1), decision: 'confirmed' });
    assert.equal(notMine.status, 403);
    assert.ok(!((await leader.get('/pay/day-checks')).json as Json[]).some((d) => d.userId === fx.users.repB), 'another team is not listed');
    // the leader's own day: the office decides
    assert.equal((await post(leader, 'wed', fx.users.leader, 2)).status, 201);
    const own = await leader.post('/pay/day-checks', { userId: fx.users.leader, date: addDays(lastWeek, 2), decision: 'confirmed' });
    assert.equal(own.status, 403);
    // reps and client accounts cannot confirm; signed out is 401
    assert.equal((await repA2.post('/pay/day-checks', { userId: fx.users.repB, date: addDays(lastWeek, 1), decision: 'confirmed' })).status, 403);
    assert.equal((await rep.get('/pay/day-checks')).status, 403);
    assert.equal((await client.get('/pay/day-checks')).status, 403);
    assert.equal((await srv.anon().get('/pay/day-checks')).status, 401);
    // the office sees every team's and confirms both
    const all_ = (await admin.get('/pay/day-checks')).json as Json[];
    assert.ok(all_.some((d) => d.userId === fx.users.repB) && all_.some((d) => d.userId === fx.users.leader));
    assert.equal((await admin.post('/pay/day-checks', { userId: fx.users.repB, date: addDays(lastWeek, 1), decision: 'confirmed' })).status, 200);
    assert.equal((await admin.post('/pay/day-checks', { userId: fx.users.leader, date: addDays(lastWeek, 2), decision: 'confirmed' })).status, 200);
    assert.equal(runOf(srv.db, fx.users.repB, lastWeek)!.daysWorked, 2);
  });

  test('a day with no gauges, a bad body, or a paid week is refused', async () => {
    const none = await leader.post('/pay/day-checks', { userId: fx.users.rep, date: addDays(lastWeek, 3), decision: 'confirmed' });
    assert.equal(none.status, 404);
    const bad = await leader.post('/pay/day-checks', { userId: fx.users.rep, date: addDays(lastWeek, 1), decision: 'maybe' });
    assert.equal(bad.status, 400);
    assert.equal((await post(rep, 'tue', fx.users.rep, 1)).status, 201);
    run(srv.db, `UPDATE payroll_runs SET status = 'paid', paid_date = ? WHERE user_id = ? AND week_start = ?`, [addDays(lastWeek, 7), fx.users.rep, lastWeek]);
    const paid = await admin.post('/pay/day-checks', { userId: fx.users.rep, date: addDays(lastWeek, 1), decision: 'confirmed' });
    assert.equal(paid.status, 409);
    assert.ok(!((await admin.get('/pay/day-checks')).json as Json[]).some((d) => d.userId === fx.users.rep), 'a paid week is not listed');
  });

  test('the leader is told in Needs attention; the office sees the waiting days on Runs to pay', async () => {
    assert.equal((await post(rep, 'tue', fx.users.rep, 1)).status, 201);
    const feed = await leader.get('/me/attention');
    assert.equal(feed.status, 200);
    const item = (feed.json.items as Json[]).find((i) => String(i.key).startsWith('payments:days'));
    assert.ok(item, JSON.stringify(feed.json.items.map((i: Json) => i.key)));
    assert.match(item.title, /1 day to confirm/);
    assert.equal(item.href, '/pay/days');
    const office = await admin.get('/me/attention');
    assert.ok((office.json.items as Json[]).some((i) => String(i.key).startsWith('payments:days')), 'the office too');
    assert.ok(!((await rep.get('/me/attention')).json.items as Json[]).some((i) => String(i.key).startsWith('payments:days')), 'not the rep');
    const runs = await admin.get(`/finance/payroll?status=pending&from=${lastWeek}&to=${lastWeek}`);
    const mine = (runs.json as Json[]).find((r) => r.userId === fx.users.rep);
    assert.equal(mine.checks?.daysWaiting, 1, JSON.stringify(mine));
  });

  // review: the rep's estimate dropped with no visible reason; their own bell now says why
  test('the rep is told their own day waits, and for whom; it goes once the leader confirms it', async () => {
    assert.equal((await post(rep, 'tue', fx.users.rep, 1)).status, 201);
    const own = ((await rep.get('/me/attention')).json.items as Json[]).find((i) => String(i.key).startsWith('payments:mydays:'));
    assert.ok(own, 'the rep is told');
    assert.match(String(own.title), /^1 of your days waits for your leader$/);
    assert.match(String(own.body), /not paid as a base day until your leader confirms it/);
    assert.equal(own.href, '/finance?tab=me');
    assert.equal(own.severity, 'info');
    const ok = await leader.post('/pay/day-checks', { userId: fx.users.rep, date: addDays(lastWeek, 1), decision: 'confirmed' });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    srv.resetCache();
    assert.ok(!((await rep.get('/me/attention')).json.items as Json[]).some((i) => String(i.key).startsWith('payments:mydays:')));
  });
});

describe('MON-1: upgrading a 1.4.0 database keeps the days it already had', () => {
  let db: Db;
  before(async () => {
    srv = await startTestServer();
    fx = srv.fixture!;
    db = srv.db;
  });
  after(() => srv.close());

  test('existing gauge days stay paid; new self-logged ones are checked', async () => {
    lastWeek = addDays(mondayOf(fx.today), -7);
    const a = addEvent(db, { campaignId: fx.campaignId, teamId: fx.teams.a, date: lastWeek });
    const b = addEvent(db, { campaignId: fx.campaignId, teamId: fx.teams.a, date: addDays(lastWeek, 1) });
    addGauge(db, { eventId: a, userId: fx.users.rep, date: lastWeek, stops: 0, sales: 0 });
    addGauge(db, { eventId: b, userId: fx.users.rep, date: addDays(lastWeek, 1), stops: 25, sales: 1 });
    // a 1.4.0 database: the runs it made, and no day checks at all
    materialisePayrollRunsOld(db);
    const before = runOf(db, fx.users.rep, lastWeek)!;
    assert.equal(before.daysWorked, 2, '1.4.0 counted both days (even the all-zero one)');
    const changed = createSchema(db);
    assert.ok(Array.isArray(changed));
    assert.equal(get<{ value: string }>(db, `SELECT value FROM meta WHERE key = 'ext:pay:day_checks'`)?.value, 'on');
    materialisePayrollRuns(db);
    const after = runOf(db, fx.users.rep, lastWeek)!;
    assert.equal(after.daysWorked, 2, 'the days it already had are kept');
    assert.equal(after.gross, before.gross);
    // a second start changes nothing
    assert.deepEqual(createSchema(db).filter((c) => c.startsWith('pay:')), []);
  });
});

/** The runs as 1.4.0 made them (the day checks are off until the upgrade). */
function materialisePayrollRunsOld(db: Db): void {
  materialisePayrollRuns(db);
  // a 1.4.0 database never had the flag: materialising here may have switched the checks on; undo for the upgrade
  run(db, `DELETE FROM meta WHERE key = 'ext:pay:day_checks'`);
  db.exec(`DROP TABLE IF EXISTS pay_day_checks`);
}
