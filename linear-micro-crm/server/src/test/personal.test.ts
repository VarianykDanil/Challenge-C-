/**
 * p2 personal pace and streaks, end to end on the small fixture: /me/insights.personal.{baseline,direction,streaks},
 * boardStreaks scoping and /leaderboard row.streak. The business clock is pinned to a Thursday so the current week
 * (Mon–Wed) is known; every row is written here, so the expected figures are exact.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Db } from '../db/connection.ts';
import { get, run } from '../db/connection.ts';
import { getUser } from '../db/queries.ts';
import { addDays, setBusinessClock } from '../lib/dates.ts';
import { personalPace } from '../lib/smart/baseline.ts';
import { boardStreaks, personalStreaks, streaksForUsers } from '../lib/smart/streaks.ts';
import { addEvent, addGauge, addHistory, startTestServer, withSmart, type Json, type TestClient, type TestServer } from './helpers.ts';

// Thu 15 Oct 2026, noon London time: this week so far is Mon 12 – Wed 14; completed weeks end Sun 11 Oct.
setBusinessClock(new Date('2026-10-15T12:00:00'));
const TODAY = '2026-10-15';
const MON = '2026-10-12';
const TUE = '2026-10-13';
const WED = '2026-10-14';

let srv: TestServer;
let admin: TestClient;
let leader: TestClient;
let recruiter: TestClient;
let rep: TestClient;
let repA2: TestClient;
let repB: TestClient;

const fx = () => srv.fixture!;

/** One gauge row for `userId` on `date`, on that team's first event that day with `status` (created when missing). */
function logDay(db: Db, userId: number, teamId: number, date: string, stops: number, sales: number, status: 'completed' | 'live' | 'cancelled' = 'completed'): number {
  const existing = get<{ id: number }>(db, `SELECT id FROM events WHERE team_id = ? AND date = ? AND status = ? ORDER BY id LIMIT 1`, [teamId, date, status]);
  const eventId = existing?.id ?? addEvent(db, { campaignId: fx().campaignId, teamId, date, status });
  return addGauge(db, { eventId, userId, date, stops, sales });
}

/** Count every SQL statement prepared or executed on `db` while `fn` runs (as in lib/history.test.ts). */
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

before(async () => {
  srv = await startTestServer({ today: TODAY });
  const { db } = srv;
  const { teams, users, campaignId } = fx();
  // rep (team A): 8 completed weeks, 4 days each, alternating 55 / 65 stops a day (μ 60, σ ≈ 5.3), 2 sales a day.
  addHistory(db, { userId: users.rep, teamId: teams.a, campaignId, weeks: 8, today: TODAY, stops: (w) => (w % 2 ? 65 : 55), sales: 2 });
  // …and this week a slow 40 stops a day with 1 sale a day, Mon–Wed.
  for (const date of [MON, TUE, WED]) logDay(db, users.rep, teams.a, date, 40, 1);
  // repA2 (team A): a new starter with 2 weeks.
  addHistory(db, { userId: users.repA2, teamId: teams.a, campaignId, weeks: 2, today: TODAY, stops: 60, sales: 2 });
  // repB (team B): 16 weeks, 60 stops a day; 1 sale a day for the oldest 8 weeks, then 3 a day; this week 5 a day.
  addHistory(db, { userId: users.repB, teamId: teams.b, campaignId, weeks: 16, today: TODAY, stops: 60, sales: (w) => (w < 8 ? 1 : 3) });
  for (const date of [MON, TUE, WED]) logDay(db, users.repB, teams.b, date, 60, 5);
  srv.resetCache();
  [admin, leader, recruiter, rep, repA2, repB] = await Promise.all([srv.login('admin'), srv.login('leader'), srv.login('recruiter'), srv.login('rep'), srv.login('repA2'), srv.login('repB')]);
});

after(async () => {
  await srv.close();
  setBusinessClock(null);
});

test('a rep with 8 weeks gets a baseline (weeks 8, finite μ and σ) and a slow-week pace alert with one lever', async () => {
  const r = await rep.get('/me/insights');
  assert.equal(r.status, 200);
  assert.equal(r.json.generatedFor, TODAY);
  const b = r.json.personal.baseline;
  assert.ok(b, 'baseline present');
  assert.equal(b.weeks, 8);
  assert.ok(Number.isFinite(b.stopsPerDayMean) && Number.isFinite(b.stopsPerDaySd));
  assert.equal(b.stopsPerDayMean, 60);
  assert.ok(b.stopsPerDaySd > 5 && b.stopsPerDaySd < 6);
  assert.equal(b.conversion, 64 / 1920);
  assert.deepEqual(b.current, { days: 3, stops: 120, sales: 3, stopsPerDay: 40, conversion: 3 / 120 });
  assert.equal(b.alerts.length, 1);
  assert.equal(b.alerts[0].metric, 'stopsPerDay');
  assert.equal(b.alerts[0].tone, 'warning');
  // 2.5% on 120 stops against a usual 3.3% is no conversion warning (z ≈ −0.5), but it is under 90% of the usual rate,
  // so the note does not call it "holding" and gives no per-sale figure
  assert.equal(
    b.alerts[0].body,
    'You are averaging 40 stops a day this week against your usual 60 — a slow site or a short day? More stops mean more chances to sell, so volume is the lever.',
  );
  // only 8 of the 16 weeks have stops, so the older half is empty: no direction yet
  assert.equal(r.json.personal.direction, null);
  // streaks: 32 history days + Mon–Wed, every one with a sale
  assert.deepEqual(r.json.personal.streaks, { current: 35, best: 35, personalBestWeek: false, weekSales: 3, bestPreviousWeekSales: 8 });
  // reps never get anyone else's check-ins
  assert.equal(r.json.team, null);
  assert.equal(r.json.company, null);
});

test('a new starter with 2 weeks gets baseline: null (streaks still count)', async () => {
  const r = await repA2.get('/me/insights');
  assert.equal(r.status, 200);
  assert.equal(r.json.personal.baseline, null);
  assert.equal(r.json.personal.direction, null);
  assert.equal(r.json.personal.streaks.current, 8);
  assert.equal(r.json.personal.streaks.personalBestWeek, false, 'fewer than 4 full weeks: no personal best yet');
  assert.equal(r.json.team, null);
  assert.equal(r.json.company, null);
});

test('16 weeks: conversion direction, a positive conversion alert and a personal-best week', async () => {
  const r = await repB.get('/me/insights');
  const { baseline: b, direction: d, streaks: s } = r.json.personal;
  assert.equal(d.label, 'improving');
  assert.ok(d.z >= 2);
  assert.equal(d.earlierConversion, 1 / 60);
  assert.equal(d.recentConversion, 3 / 60);
  assert.equal(d.earlierStops, 1920);
  assert.equal(d.recentStops, 1920);
  // baseline: the newest 8 weeks only (flat 60 stops a day at 5%), so σ = 0 and no stops alert
  assert.equal(b.weeks, 8);
  assert.equal(b.conversion, 0.05);
  assert.equal(b.stopsPerDaySd, 0);
  assert.deepEqual(b.alerts.map((a: Json) => [a.metric, a.tone]), [['conversion', 'positive']]);
  assert.equal(b.alerts[0].body, 'Your conversion is 8.3% this week against your usual 5.0% (180 stops). Lovely work — whatever you are doing, keep doing it.');
  assert.deepEqual(s, { current: 64 + 3, best: 67, personalBestWeek: true, weekSales: 15, bestPreviousWeekSales: 12 });
});

test('rows dated today and rows on live events never change this week', async () => {
  const before = (await rep.get('/me/insights')).json.personal;
  const { db } = srv;
  const { teams, users, events } = fx();
  addGauge(db, { eventId: events.todayA, userId: users.rep, date: TODAY, stops: 90, sales: 0 }); // live event today
  logDay(db, users.rep, teams.a, TUE, 5, 0, 'live'); // an event still marked live from Tuesday
  logDay(db, users.rep, teams.a, TODAY, 80, 0, 'completed'); // closed early, but today is not over
  srv.resetCache();
  const now = (await rep.get('/me/insights')).json.personal;
  assert.deepEqual(now.baseline.current, before.baseline.current);
  assert.deepEqual(now.baseline, before.baseline);
  assert.deepEqual(now.streaks, before.streaks, 'a zero-sale day today does not reset the streak');
  // a cancelled event's rows still count (the work was done): a Sunday with no sale splits the run into 32 and 3
  const sunday = logDay(db, users.rep, teams.a, addDays(MON, -1), 50, 0, 'cancelled'); // Sun 11 Oct, last completed week
  srv.resetCache();
  const later = (await rep.get('/me/insights')).json.personal;
  assert.deepEqual([later.streaks.current, later.streaks.best], [3, 32]);
  assert.equal(later.baseline.weeks, 8);
  assert.notDeepEqual(later.baseline.stopsPerDayMean, before.baseline.stopsPerDayMean, 'the cancelled day counts in its week');
  run(db, 'DELETE FROM gauge_entries WHERE id = ?', [sunday]);
  srv.resetCache();
  assert.deepEqual((await rep.get('/me/insights')).json.personal.streaks, before.streaks);
});

test('boardStreaks: own team for reps and leaders, every active rep and leader for admin, none for recruiters', async () => {
  const { users } = fx();
  const [a, l, rc, p] = await Promise.all([admin.get('/me/insights'), leader.get('/me/insights'), recruiter.get('/me/insights'), rep.get('/me/insights')]);
  const ids = (j: Json) => j.boardStreaks.map((s: Json) => s.userId).sort((x: number, y: number) => x - y);
  for (const res of [a, l, p]) for (const s of res.json.boardStreaks) assert.ok(Number.isInteger(s.streak) && s.streak >= 5);
  assert.deepEqual(ids(p.json), [users.rep, users.repA2].sort((x, y) => x - y));
  assert.deepEqual(ids(l.json), [users.rep, users.repA2].sort((x, y) => x - y));
  assert.deepEqual(ids(a.json), [users.rep, users.repA2, users.repB].sort((x, y) => x - y));
  assert.deepEqual(rc.json.boardStreaks, []);
  // sorted longest first
  const streaks = a.json.boardStreaks.map((s: Json) => s.streak);
  assert.deepEqual(streaks, [...streaks].sort((x: number, y: number) => y - x));
  // recruiters: nothing personal either
  for (const k of ['baseline', 'direction', 'streaks']) assert.equal(rc.json.personal[k], null, k);
});

test('/leaderboard rows carry a numeric streak (the same figure as the board streaks)', async () => {
  srv.resetCache();
  const board = await admin.get('/leaderboard?period=quarter');
  assert.equal(board.status, 200);
  assert.ok(board.json.length >= 3);
  for (const row of board.json) assert.equal(typeof row.streak, 'number', `streak on ${row.userName}`);
  const ins = (await admin.get('/me/insights')).json.boardStreaks as Json[];
  for (const s of ins) assert.equal(board.json.find((row: Json) => row.userId === s.userId)?.streak, s.streak);
  const mine = await rep.get('/leaderboard?period=quarter');
  assert.ok(mine.json.every((row: Json) => row.teamId === fx().teams.a && typeof row.streak === 'number'), 'a rep sees their own team only');
});

test('one SQL statement per builder; nothing personal for recruiters; LM_SMART=0 turns it all off', async () => {
  const { db } = srv;
  const { users } = fx();
  const me = getUser(db, users.rep)!;
  const admin0 = getUser(db, users.admin)!;
  assert.equal(countStatements(db, () => personalPace(db, me, TODAY)).statements, 1);
  assert.equal(countStatements(db, () => personalStreaks(db, me, TODAY)).statements, 1);
  assert.equal(countStatements(db, () => streaksForUsers(db, [users.rep, users.repA2, users.repB], TODAY)).statements, 1);
  assert.equal(countStatements(db, () => boardStreaks(db, admin0, TODAY)).statements, 1);
  assert.equal(countStatements(db, () => boardStreaks(db, me, TODAY)).statements, 1);
  const rc = getUser(db, users.recruiter)!;
  assert.equal(countStatements(db, () => personalPace(db, rc, TODAY)).statements, 0);
  assert.deepEqual(boardStreaks(db, rc, TODAY), []);
  assert.deepEqual(streaksForUsers(db, [], TODAY), new Map());
  // someone with no rows at all: present in the Map with 0, and no personal streaks
  assert.equal(streaksForUsers(db, [users.leader], TODAY).get(users.leader), 0);
  assert.equal(personalStreaks(db, getUser(db, users.leader)!, TODAY), null);

  await withSmart('0', async () => {
    srv.resetCache();
    const r = await rep.get('/me/insights');
    assert.deepEqual(r.json.personal, { baseline: null, direction: null, streaks: null, payForecast: null });
    assert.deepEqual(r.json.boardStreaks, []);
    assert.ok((await admin.get('/leaderboard?period=quarter')).json.every((row: Json) => !('streak' in row)));
  });
  srv.resetCache();
});
