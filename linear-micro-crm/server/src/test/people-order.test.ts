/**
 * Release 1.3.1: lists of people sort by surname, and someone without a surname (the Sapiens demo accounts, until Matt
 * adds one) sorts by their first name in its place — Theo among the T surnames, not at the top. GET /users had this
 * from the start; these are the other lists that name people: Finance's payroll runs, the pay export, invoices, a
 * campaign's client accounts and "Read by" on announcements (server lib/people.ts personOrderSql, the shared
 * personSortKey rule).
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { paydayForWeek } from '@lm/shared';
import { run } from '../db/connection.ts';
import { listPayroll } from '../db/queries.ts';
import { listClientAccounts } from '../lib/clientPortal.ts';
import { addDays, mondayOf } from '../lib/dates.ts';
import { issueInvoiceForRun } from '../lib/invoices.ts';
import { payExportRuns } from '../routes/payExport.ts';
import { addClientUser, startTestServer, type Json, type TestClient, type TestServer } from './helpers.ts';

let srv: TestServer;
let admin: TestClient;
let week = '';
let theo = 0;
let bea = 0;
const runIds: number[] = [];
const fx = () => srv.fixture!;

/** Fixture people (Lee Leader, Remy, Rita and Bo Rep) plus Bea and Theo without a surname, in the order they belong. */
const EXPECTED = ['Bea', 'Lee Leader', 'Bo Rep', 'Remy Rep', 'Rita Rep', 'Theo'];

before(async () => {
  srv = await startTestServer();
  admin = await srv.login('admin');
  const person = (first: string, teamId: number, employeeId: string) =>
    run(
      srv.db,
      `INSERT INTO users (employee_id, email, first_name, last_name, role, position, team_id, pay_plan_id, start_date, status, phone, avatar_color, city)
       VALUES (?, ?, ?, '', 'rep', 'trainee', ?, ?, ?, 'active', NULL, '#4F46E5', 'Manchester')`,
      [employeeId, `${first.toLowerCase()}@order.test`, first, teamId, fx().plans.trainee, addDays(fx().today, -60)],
    ).lastInsertRowid;
  // inserted first and with the lowest ids of the new people, so nothing but the name puts them in their place
  theo = person('Theo', fx().teams.a, 'LM-0901');
  bea = person('Bea', fx().teams.b, 'LM-0902');
  week = addDays(mondayOf(fx().today), -21);
  for (const userId of [theo, bea, fx().users.rep, fx().users.repA2, fx().users.repB, fx().users.leader]) {
    runIds.push(run(
      srv.db,
      `INSERT INTO payroll_runs (user_id, week_start, week_end, days_worked, sales, team_sales, base_pay, commission, bonus, overrides, deductions, gross, due_date, paid_date, status, reference)
       VALUES (?, ?, ?, 1, 0, 0, 50, 0, 0, 0, 0, 50, ?, NULL, 'pending', ?)`,
      [userId, week, addDays(week, 6), paydayForWeek(week), `ORDER-${userId}`],
    ).lastInsertRowid);
  }
});
after(async () => {
  await srv.close();
});

test('Finance: payroll runs of a week list by surname, a first name standing in for a missing one', () => {
  const runs = listPayroll(srv.db, 'WHERE p.week_start = ?', [week]);
  assert.deepEqual(runs.map((r) => r.userName), EXPECTED);
});

test('the pay export lists the week’s runs in the same order', () => {
  assert.deepEqual(payExportRuns(srv.db, week, 'all').map((r) => r.userName), EXPECTED);
  assert.deepEqual(payExportRuns(srv.db, week, 'unpaid').map((r) => r.userName), EXPECTED);
});

test('GET /finance/payroll/export: the CSV rows in that order too', async () => {
  const r = await admin.get(`/finance/payroll/export?weekStart=${week}&format=xero&runs=all`);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const names = String(r.json).trim().split(/\r?\n/).slice(1).map((line) => line.split(',')[0]!.replace(/^"|"$/g, ''));
  assert.deepEqual(names, EXPECTED);
});

test('GET /invoices: a week’s invoices in that order', async () => {
  for (const id of runIds) assert.ok(issueInvoiceForRun(srv.db, id), `invoice for run ${id}`);
  const r = await admin.get(`/invoices?from=${week}&to=${addDays(week, 6)}`);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual((r.json as Json[]).map((i) => i.userName), EXPECTED);
});

test('a campaign’s client accounts: active first, then by surname or first name', () => {
  addClientUser(srv.db, { campaignId: fx().campaignId, email: 'zoe@order.test', firstName: 'Zoe', lastName: '' });
  addClientUser(srv.db, { campaignId: fx().campaignId, email: 'cleo@order.test', firstName: 'Cleo', lastName: 'Client' });
  addClientUser(srv.db, { campaignId: fx().campaignId, email: 'ann@order.test', firstName: 'Ann', lastName: 'Bloggs' });
  addClientUser(srv.db, { campaignId: fx().campaignId, email: 'abe@order.test', firstName: 'Abe', lastName: '', status: 'left' });
  const names = listClientAccounts(srv.db, fx().campaignId).map((a) => [a.firstName, a.lastName].join(' ').trim());
  assert.deepEqual(names, ['Ann Bloggs', 'Cleo Client', 'Zoe', 'Abe']);
});

test('GET /announcements/reads: readers at the same moment are listed by name', async () => {
  const id = run(srv.db, `INSERT INTO announcements (title, body, author_id, pinned, created_at) VALUES ('Order', 'Body', ?, 0, ?)`, [fx().users.admin, new Date().toISOString()]).lastInsertRowid;
  const at = new Date().toISOString();
  for (const userId of [theo, bea, fx().users.rep, fx().users.repA2, fx().users.repB, fx().users.leader]) {
    run(srv.db, `INSERT INTO announcement_reads (announcement_id, user_id, read_at) VALUES (?, ?, ?)`, [id, userId, at]);
  }
  const r = await admin.get(`/announcements/reads?ids=${id}`);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(((r.json as Json[])[0]!.readers as Json[]).map((x) => x.name), EXPECTED);
});
