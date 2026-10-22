/**
 * Release 1.3 — P3 statements: which days a statement speaks for, by hand-computed figures. A sign-up dated outside the
 * statement's period counts on its own day, in place of what that person logged that day (never on top of it), and says
 * nothing about anyone else's sales that day; a row's own period works the same way; another applied statement for any
 * of the same days blocks Apply; weeks where a statement has nothing for a person are not sent to pay; a statement for
 * exactly the same period replaces the applied one (every week it sent is sent again, people only it listed go back to
 * their logged subs). P1's applyConfirmedSales is called with exactly these figures (its own maths is P1's tests).
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { StatementDetail } from '@lm/shared';
import { all, run } from '../db/connection.ts';
import { addDays, mondayOf, todayISO } from '../lib/dates.ts';
import { configureStatementsDir } from '../lib/statements/files.ts';
import { renderStatementPdf, type StatementPdfSpec } from '../lib/statements/render.ts';
import { campaignFromText } from '../lib/statements/store.ts';
import { addEvent, addGauge, startTestServer, type TestClient, type TestServer } from './helpers.ts';

let dir: string;
let srv: TestServer;
let admin: TestClient;
const fx = () => srv.fixture!;
const dmy = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
/** Pay weeks (Mondays) the tests use, all complete: A last week, B the week before, C1–C3 three earlier weeks. */
const A = addDays(mondayOf(todayISO()), -7);
const B = addDays(A, -7);
const C1 = addDays(A, -35);
const C2 = addDays(C1, 7);
const C3 = addDays(C1, 14);

before(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'lm-statement-periods-'));
  configureStatementsDir(dir);
  srv = await startTestServer();
  admin = await srv.login('admin');
  const { teams, campaignId, users } = fx();
  const gauge = (userId: number, teamId: number, date: string, sales: number) =>
    addGauge(srv.db, { eventId: addEvent(srv.db, { campaignId, teamId, date }), userId, date, stops: 10 * sales + 20, sales });
  // week A: Remy 4 on Monday and 3 on Wednesday; Rita 2 on Monday
  gauge(users.rep, teams.a, A, 4);
  gauge(users.rep, teams.a, addDays(A, 2), 3);
  gauge(users.repA2, teams.a, A, 2);
  // week B: Remy 2 on Monday and 5 on Thursday
  gauge(users.rep, teams.a, B, 2);
  gauge(users.rep, teams.a, addDays(B, 3), 5);
  // weeks C: Remy 2 on C2's Tuesday only; Rita 3 on C1's Friday
  gauge(users.rep, teams.a, addDays(C2, 1), 2);
  gauge(users.repA2, teams.a, addDays(C1, 4), 3);
  // the per-sign-up columns, saved for the fixture campaign
  assert.equal((await admin.put(`/statements/templates/${campaignId}`, { name: 'Fundraiser', date: 'Sign-up date', status: 'Status' })).status, 200);
});

after(async () => {
  await srv.close();
  configureStatementsDir(null);
  rmSync(dir, { recursive: true, force: true });
});

/** A per-sign-up statement of the fixture charity for `from`–`to`: [date, fundraiser, status] rows. */
function perSub(from: string, to: string, rows: [string, string, 'Active' | 'Cancelled'][], subtitle: string): StatementPdfSpec {
  return {
    title: 'Fixture Charity',
    subtitle,
    lines: [`Period: ${dmy(from)} to ${dmy(to)}`],
    headers: ['Sign-up date', 'Fundraiser', 'Status'],
    rows: rows.map(([d, who, st]) => [dmy(d), who, st]),
    totals: null,
    widths: [100, 170, 100],
    createdAt: `${addDays(to, 2)}T08:00:00.000Z`,
    color: '#DB2777',
  };
}

async function upload(spec: StatementPdfSpec): Promise<StatementDetail> {
  const res = await fetch(`${srv.base}/statements/upload?campaignId=${fx().campaignId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/pdf', cookie: admin.cookie },
    body: new Uint8Array(await renderStatementPdf(spec)),
  });
  const json = await res.json();
  assert.equal(res.status, 201, JSON.stringify(json));
  return (await admin.get(`/statements/${json.id}`)).json;
}

const weeksOf = (d: StatementDetail, userId: number) => d.people!.find((p) => p.userId === userId)?.weeks.map((w) => ({ ...w })) ?? null;

let statementA = 0;

test('a sign-up dated the day before the period counts once, on its own day, in place of what was logged that day', async () => {
  // Tue–Sun of week A; Remy's 4 Monday sign-ups are listed with Monday's date (all paid), and his 3 Wednesday ones (1
  // cancelled). Remy's week A: Mon + Tue–Sun are this statement's days for him → logged 4 + 3 = 7, confirmed 4 + 2 = 6.
  // Before the fix the Monday's 4 counted twice: 6 confirmed + 4 logged on the "outside" Monday = 10.
  const { users } = fx();
  const d = await upload(perSub(addDays(A, 1), addDays(A, 6), [
    [A, 'Remy Rep', 'Active'], [A, 'Remy Rep', 'Active'], [A, 'Remy Rep', 'Active'], [A, 'Remy Rep', 'Active'],
    [addDays(A, 2), 'Remy Rep', 'Active'], [addDays(A, 2), 'Remy Rep', 'Active'], [addDays(A, 2), 'Remy Rep', 'Cancelled'],
  ], 'Week A'));
  statementA = d.id;
  assert.deepEqual(weeksOf(d, users.rep), [{ weekStart: A, logged: 7, confirmed: 6, cancelled: 1, weekConfirmed: 6 }]);
  // Rita's Monday 2 are not this statement's (nobody listed her): no row is sent for her, so her pay is left alone
  assert.equal(weeksOf(d, users.repA2), null);
  assert.deepEqual(d.notListed, [], 'Rita logged nothing in Tue–Sun');
  assert.equal(d.outsidePeriodCount, 4);
  assert.ok(d.warnings!.some((w) => /^4 sign-ups are dated outside the statement's period \(.*\)\. They count on their own days, in place of what those people logged on those days, so it does not apply itself/.test(w)), JSON.stringify(d.warnings));
  assert.equal(d.status, 'needs_review', 'dated outside its period: never ready on its own, even with the columns saved and every row matched');
  assert.deepEqual(d.blockers, []);
  const applied = await admin.post(`/statements/${d.id}/apply`);
  assert.equal(applied.status, 200, JSON.stringify(applied.json));
  assert.deepEqual(
    all<{ weekStart: string; logged: number; confirmed: number; weekConfirmed: number }>(srv.db, `SELECT week_start AS weekStart, logged, confirmed, week_confirmed AS weekConfirmed FROM statement_allocations WHERE statement_id = ?`, [d.id]).map((x) => ({ ...x })),
    [{ weekStart: A, logged: 7, confirmed: 6, weekConfirmed: 6 }],
  );
});

test("a totals row whose own period reaches outside the statement's counts its whole period once", async () => {
  // header period Tue–Sun of week B, but Remy's row says "Mon–Sun": 6 paid of the 7 he logged (2 Mon + 5 Thu)
  const { users } = fx();
  const spec: StatementPdfSpec = {
    title: 'Fixture Charity',
    subtitle: 'Week B',
    lines: [`Period: ${dmy(addDays(B, 1))} to ${dmy(addDays(B, 6))}`],
    headers: ['Fundraiser name', 'Period', 'Paid subs'],
    rows: [['Remy Rep', `${dmy(B)} to ${dmy(addDays(B, 6))}`, '6']],
    totals: null,
    widths: [150, 180, 80],
    right: [false, false, true],
    createdAt: `${addDays(B, 9)}T08:00:00.000Z`,
    color: '#DB2777',
  };
  await admin.put(`/statements/templates/${fx().campaignId}`, { name: 'Fundraiser name', period: 'Period', confirmed: 'Paid subs' });
  const d = await upload(spec);
  assert.deepEqual(weeksOf(d, users.rep), [{ weekStart: B, logged: 7, confirmed: 6, cancelled: 1, weekConfirmed: 6 }], 'not 6 + the Monday 2');
  assert.equal(d.outsidePeriodCount, 1);
  assert.ok(d.warnings!.some((w) => /^1 row covers days outside the statement's period \(.*\)\. They count on their own days/.test(w)), JSON.stringify(d.warnings));
  assert.equal(d.status, 'needs_review');
  await admin.del(`/statements/${d.id}`);
  await admin.put(`/statements/templates/${fx().campaignId}`, { name: 'Fundraiser', date: 'Sign-up date', status: 'Status' });
});

test('another applied statement for any of the same days blocks Apply, even when only a row date meets it', async () => {
  // week B's statement lists a sign-up dated Monday of week A — a day statement A (applied) speaks for
  const d = await upload(perSub(B, addDays(B, 6), [[B, 'Remy Rep', 'Active'], [A, 'Remy Rep', 'Active']], 'Week B with a stray date'));
  assert.ok(d.blockers!.some((b) => /^Some of its dates are already covered by the FXC statement for .*, which is applied, so they would count twice\. Check the dates\.$/.test(b)), JSON.stringify(d.blockers));
  assert.equal((await admin.post(`/statements/${d.id}/apply`)).status, 409);
  await admin.del(`/statements/${d.id}`);
  // a period of just that Monday meets statement A's own days too
  const m = await upload(perSub(A, A, [[A, 'Rita Rep', 'Active']], 'Monday A'));
  assert.ok(m.blockers!.some((b) => /already covered by the FXC statement/.test(b)), JSON.stringify(m.blockers));
  await admin.del(`/statements/${m.id}`);
  void statementA;
});

test('weeks where a statement has nothing for a person are not sent to pay', async () => {
  // C1–C3 (three weeks): Remy's 2 Tuesday sign-ups of C2 (1 cancelled), and Rita's 3 of C1
  const { users } = fx();
  const d = await upload(perSub(C1, addDays(C3, 6), [
    [addDays(C2, 1), 'Remy Rep', 'Active'], [addDays(C2, 1), 'Remy Rep', 'Cancelled'],
    [addDays(C1, 4), 'Rita Rep', 'Active'], [addDays(C1, 4), 'Rita Rep', 'Active'], [addDays(C1, 4), 'Rita Rep', 'Active'],
  ], 'Weeks C'));
  assert.deepEqual(weeksOf(d, users.rep), [{ weekStart: C2, logged: 2, confirmed: 1, cancelled: 1, weekConfirmed: 1 }], 'not C1 and C3 with 0 of 0');
  assert.deepEqual(weeksOf(d, users.repA2), [{ weekStart: C1, logged: 3, confirmed: 3, cancelled: 0, weekConfirmed: 3 }]);
  assert.equal((await admin.post(`/statements/${d.id}/apply`)).status, 200);
});

test('the same period sent again: every week the first one sent is sent again; people only it listed go back to what they logged', async () => {
  // the corrected copy of weeks C: Remy's C2 sign-ups both cancelled now, Rita left off
  const { users } = fx();
  const d = await upload(perSub(C1, addDays(C3, 6), [[addDays(C2, 1), 'Remy Rep', 'Cancelled'], [addDays(C2, 1), 'Remy Rep', 'Cancelled']], 'Weeks C, corrected'));
  assert.equal(d.status, 'needs_review', 'it would replace an applied statement');
  assert.deepEqual(weeksOf(d, users.rep), [{ weekStart: C2, logged: 2, confirmed: 0, cancelled: 2, weekConfirmed: 0 }]);
  assert.deepEqual(d.dropped, [{ userId: users.repA2, userName: 'Rita Rep', logged: 3, confirmedBefore: 3 }]);
  assert.deepEqual(d.notListed, [], 'Rita is listed as dropped, not twice');
  const applied: StatementDetail = (await admin.post(`/statements/${d.id}/apply`)).json;
  assert.equal(applied.status, 'applied');
  assert.ok(applied.replaces?.id, 'the applied statement says which one it replaced');
  // Rita gets no allocation from the new statement (it says nothing about her), the old one is replaced
  assert.deepEqual(all(srv.db, `SELECT user_id FROM statement_allocations WHERE statement_id = ? AND user_id = ?`, [d.id, users.repA2]), []);
});

test('campaignFromText: a campaign code with RegExp characters never throws', () => {
  run(srv.db, `INSERT INTO campaigns (name, code, sector, type, payout_per_sale, rep_commission_per_sale, color, active, start_date) VALUES ('Plus Plus Ltd', 'C++', 'energy', 'b2b', 20, 10, '#000000', 1, ?)`, [todayISO()]);
  const id = all<{ id: number }>(srv.db, `SELECT id FROM campaigns WHERE code = 'C++'`)[0]!.id;
  assert.equal(campaignFromText(srv.db, ['Statement for C++ (commission)']), id);
  assert.equal(campaignFromText(srv.db, ['Statement for C+ (commission)']), null);
});
