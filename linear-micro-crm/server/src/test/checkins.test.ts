/**
 * p4 — the private "Check in with…" list (GET /me/insights team / company) on a fixture with known patterns, plus
 * shape, scoping and speed on the full demo seed (whose outcomes shift with the date, so only shapes are asserted).
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { CHECK_IN_RULES } from '@lm/shared';
import { all, run, type Db } from '../db/connection.ts';
import { addDays, mondayOf, todayISO } from '../lib/dates.ts';
import { checkInList } from '../lib/smart/checkIns.ts';
import { addHistory, startTestServer, withSmart, type Json, type TestClient, type TestServer } from './helpers.ts';

let srv: TestServer;
let admin: TestClient;
let leader: TestClient;
let recruiter: TestClient;
let rep: TestClient;
const extra: { onLeave: number; left: number } = { onLeave: 0, left: 0 };

const fx = () => srv.fixture!;

function addUser(db: Db, first: string, status: 'active' | 'on_leave' | 'left', teamId: number, role = 'rep', position = 'field_rep'): number {
  const plan = position === 'team_leader' ? fx().plans.leader : position === 'trainee' ? fx().plans.trainee : fx().plans.rep;
  const n = Number(all<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM users')[0]!.n) + 100;
  return run(
    db,
    `INSERT INTO users (employee_id, email, first_name, last_name, role, position, team_id, pay_plan_id, start_date, status, phone, avatar_color, city)
     VALUES (?, ?, ?, 'Fixture', ?, ?, ?, ?, ?, ?, NULL, '#0EA5E9', 'Manchester')`,
    [`FX-${n}`, `${first.toLowerCase()}.${n}@fixture.test`, first, role, position, teamId, plan, addDays(mondayOf(todayISO()), -52 * 7), status],
  ).lastInsertRowid;
}

/** 16 weeks × 4 days at 60 stops a day: 3 sales a day for 8 weeks, then 1 a day (5% → 1.7%: a sustained decline). */
function decline(db: Db, userId: number, teamId: number): string[] {
  return addHistory(db, { userId, teamId, campaignId: fx().campaignId, weeks: 16, stops: 60, sales: (w) => (w < 8 ? 3 : 1) });
}

/** 16 steady weeks at 60 stops and 3 sales a day. */
function steady(db: Db, userId: number, teamId: number, today = todayISO()): string[] {
  return addHistory(db, { userId, teamId, campaignId: fx().campaignId, weeks: today === todayISO() ? 16 : 15, stops: 60, sales: 3, today });
}

/** Paid runs for consecutive weeks, the newest `weeksBeforeLast` weeks before last week (0 = last week itself). */
function addRuns(db: Db, userId: number, grossByWeek: number[], weeksBeforeLast = 0): void {
  const first = addDays(mondayOf(todayISO()), -7 * (grossByWeek.length + weeksBeforeLast));
  grossByWeek.forEach((gross, i) => {
    const weekStart = addDays(first, 7 * i);
    run(
      db,
      `INSERT INTO payroll_runs (user_id, week_start, week_end, days_worked, sales, team_sales, base_pay, commission, bonus, overrides, deductions, gross, due_date, paid_date, status, reference)
       VALUES (?, ?, ?, 4, 0, 0, ?, 0, 0, 0, 0, ?, ?, NULL, 'paid', ?)`,
      [userId, weekStart, addDays(weekStart, 6), gross, gross, addDays(weekStart, 11), `FX-PAY-${userId}-${weekStart}`],
    );
  });
}

before(async () => {
  srv = await startTestServer();
  const db = srv.db;
  const { teams, users } = fx();
  // Team A: Remy declines and is often late lately; Rita is steady but logged nothing last week; the leader declines
  // too (but is never on their own list). Ola (on leave) and Lou (left) collapse completely and must never appear.
  const remyDates = decline(db, users.rep, teams.a);
  run(db, `UPDATE gauge_entries SET checked_in_at = date || 'T09:20:00' WHERE user_id = ? AND date IN (${remyDates.slice(-10).map(() => '?').join(', ')})`, [users.rep, ...remyDates.slice(-10)]);
  const ritaDates = steady(db, users.repA2, teams.a, addDays(todayISO(), -7)); // 15 weeks: nothing last week
  run(db, `UPDATE gauge_entries SET checked_in_at = date || 'T08:50:00' WHERE user_id = ? AND date IN (${ritaDates.map(() => '?').join(', ')})`, [users.repA2, ...ritaDates]);
  decline(db, users.leader, teams.a);
  extra.onLeave = addUser(db, 'Ola', 'on_leave', teams.a);
  extra.left = addUser(db, 'Lou', 'left', teams.a);
  for (const id of [extra.onLeave, extra.left]) {
    decline(db, id, teams.a);
    addRuns(db, id, [900, 900, 900, 900, 0, 0, 0, 0]);
  }
  // Team B: Bo is steady at work, but earned far less over the last four weeks.
  steady(db, users.repB, teams.b);
  addRuns(db, users.repB, [500, 500, 500, 500, 120, 120, 120, 120]);
  srv.resetCache();
  [admin, leader, recruiter, rep] = await Promise.all([srv.login('admin'), srv.login('leader'), srv.login('recruiter'), srv.login('rep')]);
});
after(async () => {
  await srv.close();
});

function assertPerson(p: Json): void {
  assert.ok(Number.isInteger(p.userId));
  assert.equal(typeof p.userName, 'string');
  assert.equal(typeof p.position, 'string');
  assert.match(p.avatarColor, /^#/);
  assert.ok(p.teamId === null || Number.isInteger(p.teamId));
  assert.ok(Array.isArray(p.reasons) && p.reasons.length > 0);
  assert.equal(p.score, p.reasons.reduce((s: number, r: Json) => s + r.weight, 0));
  assert.ok(p.score >= CHECK_IN_RULES.minScore);
  for (const r of p.reasons) {
    assert.equal(r.weight, CHECK_IN_RULES.weights[r.code as keyof typeof CHECK_IN_RULES.weights]);
    assert.ok(r.text.length > 10);
    assert.doesNotMatch(r.text, /at risk|underperform|failing|struggling/i);
  }
}

function assertList(list: Json[]): void {
  assert.ok(list.length <= CHECK_IN_RULES.maxPeople);
  list.forEach(assertPerson);
  for (let i = 1; i < list.length; i++) assert.ok(list[i - 1].score >= list[i].score, 'highest score first');
}

test("a leader's list holds only their own team, never the leader, never anyone on leave or gone", async () => {
  const r = await leader.get('/me/insights');
  assert.equal(r.status, 200);
  assert.equal(r.json.company, null);
  const list: Json[] = r.json.team.checkIns;
  assertList(list);
  const teamA = new Set([fx().users.rep, fx().users.repA2]);
  for (const p of list) {
    assert.ok(teamA.has(p.userId), `${p.userName} is on team A and is not the leader`);
    assert.equal(p.teamId, fx().teams.a);
  }
  const byId = new Map(list.map((p) => [p.userId, p]));
  // Remy: the decline (conversion_drop suppressed) and the late check-ins, from history and check-in rows.
  const remy = byId.get(fx().users.rep);
  assert.ok(remy, 'Remy is listed');
  assert.deepEqual(remy.reasons.map((x: Json) => x.code), ['sustained_decline', 'late_often']);
  assert.match(remy.reasons[0].text, /^Conversion 1\.7% over the last 8 weeks, down from 5\.0% in the 8 before$/);
  // The team share leaves Remy's own check-ins out: Rita (the only other one checking in) was always on time.
  assert.equal(remy.reasons[1].text, 'Late for 10 of the last 10 check-ins (team: none)');
  // Rita: nothing logged last week while the team worked, from team event dates and gauge dates.
  const rita = byId.get(fx().users.repA2);
  assert.ok(rita, 'Rita is listed');
  assert.deepEqual(rita.reasons.map((x: Json) => x.code), ['zero_week']);
  assert.match(rita.reasons[0].text, /^No gauges logged last week \(w\/c \d{1,2} [A-Z][a-z]{2}\) while the team worked \d+ event days$/);
  assert.ok(remy.score > rita.score && list.indexOf(remy) < list.indexOf(rita));
});

test("the admin's company list spans teams and never includes the admin, anyone on leave or anyone who left", async () => {
  const r = await admin.get('/me/insights');
  assert.equal(r.status, 200);
  assert.equal(r.json.team, null);
  const list: Json[] = r.json.company.checkIns;
  assertList(list);
  const ids = list.map((p) => p.userId);
  assert.ok(!ids.includes(fx().users.admin));
  assert.ok(!ids.includes(extra.onLeave), 'on leave never appears');
  assert.ok(!ids.includes(extra.left), 'left never appears');
  assert.ok(new Set(list.map((p) => p.teamId)).size >= 2, 'more than one team');
  for (const id of [fx().users.rep, fx().users.repA2, fx().users.leader, fx().users.repB]) assert.ok(ids.includes(id), `user ${id} listed`);
  const bo = list.find((p) => p.userId === fx().users.repB);
  assert.equal(bo.teamName, 'Team B');
  assert.deepEqual(bo.reasons.map((x: Json) => ({ code: x.code, text: x.text })), [{ code: 'earnings_drop', text: 'Earnings £2,000 → £480 over the last four weeks' }]);
});

test('reps and recruiters never receive a check-in list', async () => {
  for (const c of [rep, recruiter]) {
    const r = await c.get('/me/insights');
    assert.equal(r.status, 200);
    assert.equal(r.json.team, null);
    assert.equal(r.json.company, null);
    assert.doesNotMatch(JSON.stringify(r.json), /checkIns|sustained_decline|zero_week|earnings_drop/);
  }
});

test("last week's payroll is created before earnings are compared, so a week not yet materialised never reads as £0", async () => {
  // A server left running over the weekend: on Monday morning the daily job has not created last week's runs yet.
  const fresh = await startTestServer();
  try {
    const f = fresh.fixture!;
    const db = fresh.db;
    const lastMonday = addDays(mondayOf(todayISO()), -7);
    // Bo works a steady 4 days a week (last week included) and was paid £600 then £500 a week; no run for last week.
    addHistory(db, { userId: f.users.repB, teamId: f.teams.b, campaignId: f.campaignId, weeks: 16, stops: 60, sales: 3 });
    addRuns(db, f.users.repB, [600, 600, 600, 600, 500, 500, 500], 1);
    const latest = () => all<{ w: string | null }>(db, 'SELECT MAX(week_start) AS w FROM payroll_runs')[0]!.w;
    assert.equal(latest(), addDays(lastMonday, -7), 'last week has no runs yet');
    fresh.resetCache();
    const r = await (await fresh.login('admin')).get('/me/insights');
    assert.equal(r.status, 200);
    const bo = (r.json.company.checkIns as Json[]).find((p) => p.userId === f.users.repB);
    assert.equal(bo, undefined, `Bo has no earnings drop once last week is paid: ${JSON.stringify(bo?.reasons)}`);
    assert.equal(latest(), lastMonday, 'last week was materialised first');
    const runs = all<{ gross: number }>(db, 'SELECT gross FROM payroll_runs WHERE user_id = ? AND week_start = ?', [f.users.repB, lastMonday]);
    assert.equal(runs.length, 1);
    assert.ok(runs[0]!.gross > 500, `last week's gross £${runs[0]!.gross}`);
  } finally {
    await fresh.close();
  }
});

test('the builder runs exactly 7 statements whatever the size, and none with LM_SMART=0', async () => {
  const db = srv.db as unknown as { prepare: (sql: string) => unknown };
  const original = db.prepare;
  let statements = 0;
  db.prepare = function (this: unknown, sql: string) {
    statements += 1;
    return original.call(srv.db, sql);
  };
  try {
    const count = (fn: () => unknown) => {
      statements = 0;
      fn();
      return statements;
    };
    const today = todayISO();
    assert.equal(count(() => checkInList(srv.db, { teamId: fx().teams.a, excludeUserId: fx().users.leader }, today)), 7);
    assert.equal(count(() => checkInList(srv.db, { teamId: null, excludeUserId: fx().users.admin }, today)), 7);
    await withSmart('0', async () => {
      assert.equal(count(() => assert.deepEqual(checkInList(srv.db, { teamId: null, excludeUserId: fx().users.admin }, today), [])), 0);
    });
    // twelve more people on team B, each with 16 weeks of history: still 7 statements, still at most 5 people
    db.prepare = original;
    for (let i = 0; i < 12; i++) decline(srv.db, addUser(srv.db, `Extra${i}`, 'active', fx().teams.b), fx().teams.b);
    db.prepare = function (this: unknown, sql: string) {
      statements += 1;
      return original.call(srv.db, sql);
    };
    let list: unknown[] = [];
    assert.equal(count(() => (list = checkInList(srv.db, { teamId: null, excludeUserId: fx().users.admin }, today))), 7);
    assert.equal(list.length, CHECK_IN_RULES.maxPeople);
  } finally {
    db.prepare = original;
  }
});

test('on the demo seed: admin MISS under 150 ms, shapes and scoping hold for every role', async () => {
  const seeded = await startTestServer({ seed: true });
  try {
    const [a, l, r, p] = await Promise.all([seeded.login('admin'), seeded.login('leader'), seeded.login('recruiter'), seeded.login('rep')]);
    await l.get('/me/insights'); // warm the statement cache with the leader's (smaller) list
    seeded.resetCache();
    const t0 = performance.now();
    const res = await a.get('/me/insights');
    const ms = performance.now() - t0;
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-cache'), 'MISS');
    assert.ok(ms < 150, `admin /me/insights MISS took ${ms.toFixed(1)} ms`);
    const status = new Map(all<{ id: number; status: string; role: string; teamId: number | null }>(seeded.db, 'SELECT id, status, role, team_id AS teamId FROM users').map((u) => [u.id, u]));
    const adminId = all<{ id: number }>(seeded.db, `SELECT id FROM users WHERE email = 'danil@linear-mcr.co.uk'`)[0]!.id;
    const company: Json[] = res.json.company.checkIns;
    assertList(company);
    for (const c of company) {
      const u = status.get(c.userId)!;
      assert.notEqual(c.userId, adminId);
      assert.equal(u.status, 'active');
      assert.ok(u.role === 'rep' || u.role === 'leader');
    }
    seeded.resetCache();
    const lead = await l.get('/me/insights');
    const leaderRow = all<{ id: number; teamId: number }>(seeded.db, `SELECT id, team_id AS teamId FROM users WHERE email = 'amelia.hart@linear-mcr.co.uk'`)[0]!;
    assertList(lead.json.team.checkIns);
    for (const c of lead.json.team.checkIns) {
      assert.notEqual(c.userId, leaderRow.id);
      assert.equal(status.get(c.userId)!.teamId, leaderRow.teamId);
      assert.equal(status.get(c.userId)!.status, 'active');
    }
    for (const c of [r, p]) {
      const j = (await c.get('/me/insights')).json;
      assert.equal(j.team, null);
      assert.equal(j.company, null);
    }
  } finally {
    await seeded.close();
  }
});
