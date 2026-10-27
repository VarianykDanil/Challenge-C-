/**
 * MON-8: office staff (recruiters on a day rate) are not paid for days they were away or after their leaving date.
 * Routes: GET /pay/staff/:userId, PUT …/leaving-date, POST …/absences, DELETE …/absences/:id — every role.
 */
import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { all, get, run, type Db } from '../db/connection.ts';
import { addDays, mondayOf } from '../lib/dates.ts';
import { addEvent, addGauge, startTestServer, type Json, type TestClient, type TestServer } from './helpers.ts';

let srv: TestServer;
let fx: NonNullable<TestServer['fixture']>;
let admin: TestClient;
let leader: TestClient;
let recruiter: TestClient;
let rep: TestClient;
let client: TestClient;
let lastWeek: string;

const runOf = (db: Db, userId: number, week: string) =>
  get<{ id: number; daysWorked: number; gross: number; status: string }>(db, `SELECT id, days_worked AS daysWorked, gross, status FROM payroll_runs WHERE user_id = ? AND week_start = ?`, [userId, week]);

describe('MON-8: office staff days off and leaving date', () => {
  beforeEach(async () => {
    srv = await startTestServer();
    fx = srv.fixture!;
    [admin, leader, recruiter, rep, client] = await Promise.all((['admin', 'leader', 'recruiter', 'rep', 'client'] as const).map((r) => srv.login(r)));
    lastWeek = addDays(mondayOf(fx.today), -7);
    // some gauges so last week is materialised
    const ev = addEvent(srv.db, { campaignId: fx.campaignId, teamId: fx.teams.a, date: lastWeek });
    addGauge(srv.db, { eventId: ev, userId: fx.users.rep, date: lastWeek, stops: 20, sales: 1 });
    assert.equal((await admin.get('/finance/payroll')).status, 200);
  });
  afterEach(() => srv.close());

  test('a day off takes a day off the recruiter\'s pay; removing it puts it back', async () => {
    const before = runOf(srv.db, fx.users.recruiter, lastWeek)!;
    assert.equal(before.daysWorked, 5);
    const add = await admin.post(`/pay/staff/${fx.users.recruiter}/absences`, { date: addDays(lastWeek, 1), kind: 'sick', note: 'Flu' });
    assert.equal(add.status, 201, JSON.stringify(add.json));
    assert.equal(add.json.absences.length, 1);
    assert.equal(add.json.absences[0].kind, 'sick');
    const after = runOf(srv.db, fx.users.recruiter, lastWeek)!;
    assert.equal(after.daysWorked, 4);
    assert.ok(after.gross < before.gross);
    // a range (a weekend inside it is skipped)
    const range = await admin.post(`/pay/staff/${fx.users.recruiter}/absences`, { date: addDays(lastWeek, 3), to: addDays(lastWeek, 6), kind: 'holiday' });
    assert.equal(range.status, 201);
    assert.equal(range.json.absences.length, 3, 'Thu and Fri only');
    assert.equal(runOf(srv.db, fx.users.recruiter, lastWeek)!.daysWorked, 2);
    const del = await admin.del(`/pay/staff/${fx.users.recruiter}/absences/${add.json.absences.find((a: Json) => a.kind === 'sick').id}`);
    assert.equal(del.status, 200);
    assert.equal(runOf(srv.db, fx.users.recruiter, lastWeek)!.daysWorked, 3);
    const audit = all<{ summary: string }>(srv.db, `SELECT summary FROM audit_log WHERE action LIKE '% /pay/staff/:userId/absences%' AND entity = 'user' ORDER BY id`);
    assert.equal(audit.length, 3);
    assert.match(audit[0]!.summary, /Added a day off .*Rae Recruiter/);
  });

  test('a leaving date stops the pay after the last working day, and a leaver\'s last week is still paid', async () => {
    const set = await admin.put(`/pay/staff/${fx.users.recruiter}/leaving-date`, { leavingDate: addDays(lastWeek, 2) });
    assert.equal(set.status, 200, JSON.stringify(set.json));
    assert.equal(set.json.leavingDate, addDays(lastWeek, 2));
    assert.equal(runOf(srv.db, fx.users.recruiter, lastWeek)!.daysWorked, 3, 'Mon to Wed');
    // marked as left: the last week keeps its run (it used to vanish with no gauges)
    run(srv.db, `UPDATE users SET status = 'left' WHERE id = ?`, [fx.users.recruiter]);
    run(srv.db, `DELETE FROM payroll_runs WHERE user_id = ? AND week_start = ?`, [fx.users.recruiter, lastWeek]);
    run(srv.db, `DELETE FROM payroll_runs WHERE week_start >= ?`, [lastWeek]);
    assert.equal((await admin.get('/finance/payroll')).status, 200);
    assert.equal(runOf(srv.db, fx.users.recruiter, lastWeek)?.daysWorked, 3, 'the leaver is paid for their last days');
    // cleared again
    run(srv.db, `UPDATE users SET status = 'active' WHERE id = ?`, [fx.users.recruiter]);
    const clear = await admin.put(`/pay/staff/${fx.users.recruiter}/leaving-date`, { leavingDate: null });
    assert.equal(clear.status, 200);
    assert.equal(clear.json.leavingDate, null);
    assert.equal(runOf(srv.db, fx.users.recruiter, lastWeek)!.daysWorked, 5);
  });

  test('a field person\'s gauges after their leaving date are not paid days', async () => {
    const ev2 = addEvent(srv.db, { campaignId: fx.campaignId, teamId: fx.teams.a, date: addDays(lastWeek, 2) });
    addGauge(srv.db, { eventId: ev2, userId: fx.users.rep, date: addDays(lastWeek, 2), stops: 20, sales: 0 });
    run(srv.db, `INSERT INTO pay_day_checks (user_id, date, decision, source, decided_by, decided_at) VALUES (?, ?, 'confirmed', 'leader', ?, ?)`, [fx.users.rep, addDays(lastWeek, 2), fx.users.leader, new Date().toISOString()]);
    assert.equal((await admin.put(`/pay/staff/${fx.users.rep}/leaving-date`, { leavingDate: lastWeek })).status, 200);
    assert.equal(runOf(srv.db, fx.users.rep, lastWeek)!.daysWorked, 1, 'only the Monday');
  });

  test('a paid week cannot change: add an adjustment instead', async () => {
    run(srv.db, `UPDATE payroll_runs SET status = 'paid', paid_date = ? WHERE user_id = ? AND week_start = ?`, [addDays(lastWeek, 7), fx.users.recruiter, lastWeek]);
    const add = await admin.post(`/pay/staff/${fx.users.recruiter}/absences`, { date: addDays(lastWeek, 1), kind: 'holiday' });
    assert.equal(add.status, 409);
    assert.match(add.json.error, /already paid/);
    const leave = await admin.put(`/pay/staff/${fx.users.recruiter}/leaving-date`, { leavingDate: lastWeek });
    assert.equal(leave.status, 409);
    assert.equal(runOf(srv.db, fx.users.recruiter, lastWeek)!.daysWorked, 5);
  });

  test('bad input', async () => {
    assert.equal((await admin.post(`/pay/staff/${fx.users.recruiter}/absences`, { date: 'soon', kind: 'holiday' })).status, 400);
    assert.equal((await admin.post(`/pay/staff/${fx.users.recruiter}/absences`, { date: addDays(lastWeek, 1), kind: 'party' })).status, 400);
    assert.equal((await admin.post(`/pay/staff/${fx.users.recruiter}/absences`, { date: addDays(lastWeek, 5), kind: 'holiday' })).status, 400, 'a Saturday');
    assert.equal((await admin.put(`/pay/staff/${fx.users.recruiter}/leaving-date`, { leavingDate: '2000-01-01' })).status, 400, 'before the start date');
    assert.equal((await admin.put(`/pay/staff/${fx.users.recruiter}/leaving-date`, {})).status, 400);
    assert.equal((await admin.get('/pay/staff/987654')).status, 404);
  });

  test('every role: only the office changes days off; the person can read their own', async () => {
    const path = `/pay/staff/${fx.users.recruiter}`;
    assert.equal((await admin.get(path)).status, 200);
    assert.equal((await recruiter.get(path)).status, 200, 'their own');
    for (const who of [leader, rep, client]) {
      assert.equal((await who.get(path)).status, 403);
      assert.equal((await who.post(`${path}/absences`, { date: addDays(lastWeek, 1), kind: 'holiday' })).status, 403);
      assert.equal((await who.put(`${path}/leaving-date`, { leavingDate: null })).status, 403);
    }
    assert.equal((await recruiter.post(`${path}/absences`, { date: addDays(lastWeek, 1), kind: 'holiday' })).status, 403, 'not even their own');
    assert.equal((await srv.anon().get(path)).status, 401);
  });
});
