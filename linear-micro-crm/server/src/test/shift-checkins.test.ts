/**
 * Release 1.2 U4: the one-tap shift check-in (POST / DELETE / GET /checkins) against the fixture, under a business
 * clock pinned to 15:00 today. Checks idempotency on (person, event, day), who may check in where, the time rules
 * (live tap vs a replayed offline tap), the undo window and the leader's removal, read scoping, that punctuality
 * prefers the check-in over the gauge entry's own time — and pay integrity: a check-in never creates a gauge row,
 * never counts as a day worked and never touches payroll. (Not the 1.1 "Check in with…" list: see checkins.test.ts.)
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { all, get, openDb, run } from '../db/connection.ts';
import { Where } from '../db/queries.ts';
import { createSchema } from '../db/schema.ts';
import { seed } from '../db/seed.ts';
import { addDays, mondayOf, setBusinessClock, todayISO } from '../lib/dates.ts';
import { punctualityFor } from '../lib/metrics.ts';
import { weekPayFor } from '../lib/pay.ts';
import { getUser } from '../db/queries.ts';
import { addEvent, addGauge, startTestServer, type Json, type TestClient, type TestServer } from './helpers.ts';

// 15:00 today, London (the server test script pins TZ=Europe/London). Set before the fixture is built.
const TODAY = todayISO();
setBusinessClock(new Date(`${TODAY}T15:00:00`));

let srv: TestServer;
let admin: TestClient;
let leader: TestClient;
let recruiter: TestClient;
let rep: TestClient;
let repA2: TestClient;
let repB: TestClient;
/** Team A, today 15:00–18:00: a live tap at 15:00 is on time. */
let afternoonA: number;

before(async () => {
  srv = await startTestServer({ today: TODAY });
  [admin, leader, recruiter, rep, repA2, repB] = await Promise.all(
    (['admin', 'leader', 'recruiter', 'rep', 'repA2', 'repB'] as const).map((w) => srv.login(w)),
  );
  afternoonA = addEvent(srv.db, { campaignId: fx().campaignId, teamId: fx().teams.a, date: TODAY, status: 'live', startTime: '15:00', endTime: '18:00', name: 'Afternoon A' });
});
after(async () => {
  await srv.close();
  setBusinessClock(null);
});

const fx = () => srv.fixture!;
const count = (table: string) => get<{ n: number }>(srv.db, `SELECT COUNT(*) AS n FROM ${table}`)!.n;
const checkInRows = (eventId: number) => all<{ userId: number }>(srv.db, `SELECT user_id AS userId FROM check_ins WHERE event_id = ?`, [eventId]);

test('a rep checks in with one tap: 201 with the business time and the grace rule, then idempotent (200, same row)', async () => {
  const gaugesBefore = count('gauge_entries');
  const first = await rep.post('/checkins', { eventId: afternoonA, source: 'quick' });
  assert.equal(first.status, 201, JSON.stringify(first.json));
  const c = first.json as Json;
  assert.equal(c.userId, fx().users.rep);
  assert.equal(c.eventId, afternoonA);
  assert.equal(c.date, TODAY);
  assert.match(c.checkedInAt, new RegExp(`^${TODAY}T15:0\\d:\\d{2}$`), 'naive London wall-clock time from the business clock');
  assert.equal(c.source, 'quick');
  assert.equal(c.onTime, true);
  assert.equal(c.minutesLate, c.checkedInAt.slice(11, 19) === '15:00:00' ? 0 : 1);
  assert.equal(c.userName, 'Remy Rep');
  assert.ok(c.undoUntil, 'own fresh check-in carries its undo window');
  assert.ok(c.undoMsLeft > 100_000 && c.undoMsLeft <= 120_000);

  const again = await rep.post('/checkins', { eventId: afternoonA });
  assert.equal(again.status, 200);
  assert.equal(again.json.id, c.id);
  assert.equal(again.json.checkedInAt, c.checkedInAt, 'the first check-in stands');
  // a replayed offline copy of the same tap is "already there" too
  const replay = await rep.post('/checkins', { eventId: afternoonA, date: TODAY, checkedInAt: `${TODAY}T14:58:00`, source: 'offline' });
  assert.equal(replay.status, 200);
  assert.equal(replay.json.id, c.id);
  assert.equal(checkInRows(afternoonA).length, 1);
  assert.equal(count('gauge_entries'), gaugesBefore, 'no gauge row is created');
});

test('late: a live tap long after the start reads "N min late" with the existing grace rule', async () => {
  // The all-day fixture event started at 00:00. Lateness is real time elapsed, so 15:00 is 900 minutes late on most
  // days but 840 on the Sunday the clocks go forward and 960 when they go back: work it out from the clock.
  const elapsed = (new Date(`${TODAY}T15:00:00`).getTime() - new Date(`${TODAY}T00:00:00`).getTime()) / 60_000;
  const r = await repA2.post('/checkins', { eventId: fx().events.todayA });
  assert.equal(r.status, 201);
  assert.equal(r.json.onTime, false);
  assert.ok(r.json.minutesLate >= elapsed && r.json.minutesLate <= elapsed + 5, `${r.json.minutesLate} minutes late, expected about ${elapsed}`);
  assert.equal(r.json.source, 'button', 'a live tap without a source is a button tap');
});

test('who may check in where: own team only (admin anywhere), never a recruiter, never a cancelled event', async () => {
  assert.equal((await repB.post('/checkins', { eventId: fx().events.todayA })).status, 403);
  assert.equal((await leader.post('/checkins', { eventId: fx().events.todayB })).status, 403);
  assert.equal((await recruiter.post('/checkins', { eventId: fx().events.todayA })).status, 403);
  assert.equal((await rep.post('/checkins', { eventId: 999_999 })).status, 404);
  const cancelled = addEvent(srv.db, { campaignId: fx().campaignId, teamId: fx().teams.a, date: TODAY, status: 'cancelled', startTime: '10:00', endTime: '16:00' });
  assert.equal((await rep.post('/checkins', { eventId: cancelled })).status, 409);
  const adminTap = await admin.post('/checkins', { eventId: fx().events.todayB });
  assert.equal(adminTap.status, 201, 'admins work any team’s events (the gauge rule)');
  // body validation
  assert.equal((await rep.post('/checkins', { eventId: 'x' })).status, 400);
  assert.equal((await rep.post('/checkins', { eventId: afternoonA, source: 'leader' })).status, 400, "'leader' is reserved");
  assert.equal((await rep.post('/checkins', { eventId: afternoonA, checkedInAt: 'soon' })).status, 400);
});

test('time rules: a live tap only on the event day and before its end; an offline tap keeps its own time', async () => {
  // tomorrow / yesterday without a time: not the event day
  assert.equal((await rep.post('/checkins', { eventId: fx().events.tomorrowA })).status, 400);
  assert.equal((await rep.post('/checkins', { eventId: fx().events.yesterdayA })).status, 400);
  // an event that ended at 14:00 today: closed
  const morning = addEvent(srv.db, { campaignId: fx().campaignId, teamId: fx().teams.a, date: TODAY, status: 'live', startTime: '09:00', endTime: '14:00' });
  const closed = await rep.post('/checkins', { eventId: morning });
  assert.equal(closed.status, 400);
  assert.match(closed.json.error, /closed at 14:00/);
  // …but a tap kept on the phone at 08:57 is accepted with its own time and marked offline
  const offline = await rep.post('/checkins', { eventId: morning, date: TODAY, checkedInAt: `${TODAY}T08:57:00`, source: 'offline' });
  assert.equal(offline.status, 201);
  assert.equal(offline.json.checkedInAt, `${TODAY}T08:57:00`);
  assert.equal(offline.json.source, 'offline');
  assert.equal(offline.json.onTime, true);
  // yesterday's event, replayed today with yesterday's time: accepted (a client time without a source counts as offline)
  const yesterday = addDays(TODAY, -1);
  const y = await rep.post('/checkins', { eventId: fx().events.yesterdayA, checkedInAt: `${yesterday}T09:07:00` });
  assert.equal(y.status, 201);
  assert.equal(y.json.date, yesterday);
  assert.equal(y.json.source, 'offline');
  assert.deepEqual([y.json.onTime, y.json.minutesLate], [false, 7]);
  // a time in the future, on another day, after the end, or a date that is not the event's
  assert.equal((await repA2.post('/checkins', { eventId: morning, checkedInAt: `${TODAY}T16:30:00` })).status, 400);
  assert.equal((await repA2.post('/checkins', { eventId: morning, checkedInAt: `${yesterday}T09:00:00` })).status, 400);
  assert.equal((await repA2.post('/checkins', { eventId: morning, checkedInAt: `${TODAY}T14:30:00` })).status, 400);
  assert.equal((await repA2.post('/checkins', { eventId: morning, date: yesterday })).status, 400);
  // a phone clock 2 minutes ahead is taken as now
  const ahead = await leader.post('/checkins', { eventId: afternoonA, checkedInAt: `${TODAY}T15:02:00`, source: 'offline' });
  assert.equal(ahead.status, 201);
  assert.ok(ahead.json.checkedInAt <= `${TODAY}T15:01:00`, `clamped to now, got ${ahead.json.checkedInAt}`);
  // zoned input is converted to London wall-clock time (as for gauges)
  const zoned = await repA2.post('/checkins', { eventId: morning, checkedInAt: new Date(`${TODAY}T09:01:00`).toISOString() });
  assert.equal(zoned.status, 201);
  assert.equal(zoned.json.checkedInAt, `${TODAY}T09:01:00`);
});

test('GET /checkins: admin everyone, a leader their team and themself, a rep only their own', async () => {
  assert.equal((await rep.get('/checkins')).status, 400);
  assert.equal((await rep.get('/checkins?eventId=999999')).status, 404);
  assert.equal((await srv.anon().get(`/checkins?eventId=${afternoonA}`)).status, 401);
  const ids = async (c: TestClient, eventId: number) => {
    const r = await c.get(`/checkins?eventId=${eventId}`);
    assert.equal(r.status, 200);
    assert.equal(r.json.eventId, eventId);
    return (r.json.checkIns as Json[]).map((x) => x.userId).sort();
  };
  assert.deepEqual(await ids(admin, afternoonA), [fx().users.leader, fx().users.rep].sort());
  assert.deepEqual(await ids(leader, afternoonA), [fx().users.leader, fx().users.rep].sort());
  assert.deepEqual(await ids(rep, afternoonA), [fx().users.rep]);
  assert.deepEqual(await ids(repA2, afternoonA), [], "another rep's check-in time is private");
  assert.deepEqual(await ids(repB, afternoonA), []);
  // the admin's own check-in at team B's event: team A's leader never sees it, team B's people only their own
  assert.deepEqual(await ids(leader, fx().events.todayB), []);
  assert.deepEqual(await ids(admin, fx().events.todayB), [fx().users.admin]);
  // undo information is only ever for the caller's own row
  const seen = (await leader.get(`/checkins?eventId=${afternoonA}`)).json.checkIns as Json[];
  const repRow = seen.find((x) => x.userId === fx().users.rep)!;
  assert.equal(repRow.undoUntil, null);
  assert.equal(repRow.undoMsLeft, 0);
});

test('undo: self within 2 minutes; after that only the leader of the team or an admin; others get 404', async () => {
  const r = await repA2.post('/checkins', { eventId: afternoonA });
  assert.equal(r.status, 201);
  const id = r.json.id as number;
  assert.equal((await repB.del(`/checkins/${id}`)).status, 404, 'another team: not even revealed');
  assert.equal((await rep.del(`/checkins/${id}`)).status, 404, "a teammate cannot remove someone else's");
  assert.equal((await repA2.del(`/checkins/${id}`)).status, 204, 'own, within 2 minutes');
  assert.equal(checkInRows(afternoonA).some((x) => x.userId === fx().users.repA2), false);

  const again = await repA2.post('/checkins', { eventId: afternoonA });
  assert.equal(again.status, 201, 'checking in again after an undo is a new check-in');
  // three minutes later the person can no longer undo it themself
  run(srv.db, `UPDATE check_ins SET created_at = ? WHERE id = ?`, [new Date(Date.parse(again.json.createdAt) - 3 * 60_000).toISOString(), again.json.id]);
  const late = await repA2.del(`/checkins/${again.json.id}`);
  assert.equal(late.status, 403);
  assert.match(late.json.error, /2 minutes/);
  const listed = (await repA2.get(`/checkins?eventId=${afternoonA}`)).json.checkIns as Json[];
  assert.equal(listed[0].undoUntil, null, 'no undo offered once the window has passed');
  assert.equal((await leader.del(`/checkins/${again.json.id}`)).status, 204, "the team's leader removes it any time");
  assert.equal((await leader.del(`/checkins/${again.json.id}`)).status, 404);
  // team A's leader cannot remove the admin's check-in at team B; the admin can
  const adminRow = get<{ id: number }>(srv.db, `SELECT id FROM check_ins WHERE user_id = ? AND event_id = ?`, [fx().users.admin, fx().events.todayB])!;
  assert.equal((await leader.del(`/checkins/${adminRow.id}`)).status, 404);
  assert.equal((await admin.del(`/checkins/${adminRow.id}`)).status, 204);
  assert.equal((await rep.del('/checkins/abc')).status, 400);
});

test('punctuality prefers the check-in over the gauge entry’s own time, and falls back when it is removed', async () => {
  // A fresh morning event 09:00–12:00 for team A: the gauge says 08:55 (on time), the one-tap check-in 09:20 (late).
  const ev = addEvent(srv.db, { campaignId: fx().campaignId, teamId: fx().teams.a, date: TODAY, status: 'live', startTime: '09:00', endTime: '12:00', name: 'Punctuality A' });
  addGauge(srv.db, { eventId: ev, userId: fx().users.leader, date: TODAY, stops: 30, sales: 2, checkedInAt: `${TODAY}T08:55:00` });
  const where = () => new Where().add('g.user_id = ?', fx().users.leader).add('g.event_id = ?', ev);
  assert.equal(punctualityFor(srv.db, where()), 1, 'before any check-in: the gauge entry decides (1.1 behaviour)');
  const tap = await leader.post('/checkins', { eventId: ev, checkedInAt: `${TODAY}T09:20:00`, source: 'offline' });
  assert.equal(tap.status, 201);
  assert.equal(punctualityFor(srv.db, where()), 0, 'the check-in is the time that counts');
  srv.resetCache();
  const perf = await leader.get(`/users/${fx().users.leader}/performance?from=${TODAY}&to=${TODAY}`);
  assert.equal(perf.status, 200);
  assert.equal(typeof perf.json.punctualityRate, 'number');
  assert.equal((await leader.del(`/checkins/${tap.json.id}`)).status, 204);
  assert.equal(punctualityFor(srv.db, where()), 1, 'removed: back to the gauge entry');
  // a check-in alone (no gauge row) is not a punctuality sample of its own
  const solo = await leader.post('/checkins', { eventId: fx().events.todayA });
  assert.equal(solo.status, 201);
  assert.equal(punctualityFor(srv.db, new Where().add('g.user_id = ?', fx().users.leader).add('g.event_id = ?', fx().events.todayA)), null);
});

test('pay integrity: check-ins never create a gauge row, a day worked or a payroll change', async () => {
  const before = { gauges: count('gauge_entries'), runs: count('payroll_runs') };
  const user = getUser(srv.db, fx().users.repB)!;
  const monday = mondayOf(TODAY);
  const payBefore = weekPayFor(srv.db, user, monday);
  const r = await repB.post('/checkins', { eventId: fx().events.todayB });
  assert.equal(r.status, 201);
  const y = await repB.post('/checkins', { eventId: fx().events.yesterdayB, checkedInAt: `${addDays(TODAY, -1)}T08:50:00` });
  assert.equal(y.status, 201);
  assert.equal(count('gauge_entries'), before.gauges, 'no gauge row');
  assert.equal(count('payroll_runs'), before.runs, 'no payroll run');
  assert.deepEqual(weekPayFor(srv.db, user, monday), payBefore, 'no day worked, no pay');
  assert.equal(payBefore, null, 'repB has no gauges this week: nothing to pay, check-ins or not');
  srv.resetCache();
  const dash = await repB.get('/me/dashboard?range=week');
  assert.equal(dash.status, 200);
  assert.equal(dash.json.personal.days, 0, 'the dashboard counts no day worked');
  assert.equal(dash.json.personal.punctualityRate, null);
  // the event pages show no gauges for them either
  const evB = await repB.get(`/events/${fx().events.todayB}`);
  assert.equal(evB.status, 200);
  assert.equal((evB.json.entries as Json[]).length, 0);
});

test('demo seed: today’s started events get the logged people’s check-ins at their recorded times, so punctuality reads as before', () => {
  // The demo works Monday to Saturday, so a Sunday has no shifts and no check-ins: on a Sunday the demo is seeded as of
  // the Saturday before (15:00, like every other day), so the test means the same thing on every day of the week.
  const day = new Date(`${TODAY}T12:00:00`).getDay() === 0 ? addDays(TODAY, -1) : TODAY;
  setBusinessClock(new Date(`${day}T15:00:00`));
  const db = openDb(':memory:');
  try {
    createSchema(db);
    seed(db, day);
    const rows = all<{ date: string; checkedInAt: string; createdAt: string; source: string; gaugeAt: string | null; hasGauge: number; status: string; role: string; sameTeam: number }>(
      db,
      `SELECT ci.date, ci.checked_in_at AS checkedInAt, ci.created_at AS createdAt, ci.source, g.checked_in_at AS gaugeAt, g.id IS NOT NULL AS hasGauge,
              e.status, u.role, u.team_id = e.team_id AS sameTeam
       FROM check_ins ci JOIN events e ON e.id = ci.event_id JOIN users u ON u.id = ci.user_id
       LEFT JOIN gauge_entries g ON g.user_id = ci.user_id AND g.event_id = ci.event_id AND g.date = ci.date`,
    );
    assert.ok(rows.length > 0, 'the demo has check-ins for today');
    for (const r of rows) {
      assert.equal(r.date, day);
      assert.ok(r.status === 'live' || r.status === 'completed', 'only started events');
      assert.ok(r.role === 'rep' || r.role === 'leader');
      assert.equal(Number(r.sameTeam), 1);
      assert.ok(r.source === 'button' || r.source === 'quick');
      assert.ok(r.checkedInAt <= `${day}T15:00:00`, 'never in the future');
      assert.equal(Number(r.hasGauge), 1, 'only people who worked today');
      assert.equal(r.checkedInAt, r.gaugeAt, 'a logged day’s tap is its recorded time');
    }
    // punctuality over every gauge row is exactly what the gauge entries alone give
    const all1 = punctualityFor(db, new Where().add('g.date <= ?', day));
    run(db, `DELETE FROM check_ins`);
    assert.equal(punctualityFor(db, new Where().add('g.date <= ?', day)), all1);
  } finally {
    db.close();
    setBusinessClock(new Date(`${TODAY}T15:00:00`));
  }
});
