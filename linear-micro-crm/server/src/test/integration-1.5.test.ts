/**
 * Release 1.5: where the packages meet. Each package was built on its own; these pin the rules that only hold once they
 * are together:
 *  - access's demo allowlist and secure-only routes cover money's new routes (the 1p test file, the two-approvals
 *    setting, VAT confirmation, day checks, office staff days, the person's answer about their bank details, and freeing
 *    the weeks of a downloaded bank file);
 *  - a one-tap demo administrator with two-step on never counts as one of the "two people" who approve a payment.
 */
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { ACCESS_MESSAGES, type UserWithTeam } from '@lm/shared';
import { createApp } from '../app.ts';
import { get, run, type Db } from '../db/connection.ts';
import { addDays, todayISO } from '../lib/dates.ts';
import { TWO_APPROVALS_KEY, adminsWithTwoStep, paymentsSettings } from '../lib/payments/settings.ts';
import { setTrialMode } from '../lib/trialMode.ts';
import { getUser } from '../db/queries.ts';
import { attentionNow, buildAttentionFeed } from '../routes/attention.ts';
import { DEMO_ACCOUNTS, FIXTURE_ACCOUNTS, enrolTwoFactor, signInWith, startTestServer, TestClient, type Json, type TestServer } from './helpers.ts';

let srv: TestServer | null = null;
const extra: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const e of extra.splice(0)) await e.close();
  await srv?.close();
  srv = null;
});

const db = (): Db => srv!.db;
const idOf = (employeeId: string) => get<{ id: number }>(db(), `SELECT id FROM users WHERE lower(employee_id) = lower(?)`, [employeeId])!.id;

/** A person of the office's own (not the demo company), added straight to the database. */
function addPerson(employeeId: string, email: string, role = 'rep', first = 'Kit'): number {
  const plan = get<{ id: number }>(db(), `SELECT id FROM pay_plans ORDER BY id LIMIT 1`)!.id;
  return run(
    db(),
    `INSERT INTO users (employee_id, email, first_name, last_name, role, position, team_id, pay_plan_id, start_date, status, phone, avatar_color, city)
     VALUES (?, ?, ?, 'Lane', ?, ?, 1, ?, ?, 'active', NULL, '#4F46E5', 'Manchester')`,
    [employeeId, email, first, role, role === 'admin' ? 'assistant_owner' : 'field_rep', plan, addDays(todayISO(), -30)],
  ).lastInsertRowid;
}

test('a one-tap demo administrator cannot use money’s new routes on a person of the office’s own, or change payment settings', async () => {
  srv = await startTestServer({ seed: true });
  const kit = addPerson('LM-0600', 'kit.lane@office.example');
  const connection = run(
    db(),
    `INSERT INTO payment_connections (provider, name, mode, settings_json, status, created_at) VALUES ('bank_file', 'Office bank', 'test', '{}', 'connected', ?)`,
    [new Date().toISOString()],
  ).lastInsertRowid;
  srv.resetCache();
  const demo = await srv.login('admin');
  const attempts: [string, Promise<{ status: number; json: Json }>][] = [
    ['confirm Kit’s VAT number', demo.post(`/invoices/profile/${kit}/vat/confirm`, { vatNumber: 'GB999999973', code: '123456' })],
    ['check a day of Kit’s', demo.post('/pay/day-checks', { userId: kit, date: todayISO(), decision: 'confirmed' })],
    ['Kit’s leaving date', demo.put(`/pay/staff/${kit}/leaving-date`, { leavingDate: todayISO() })],
    ['a day off for Kit', demo.post(`/pay/staff/${kit}/absences`, { from: todayISO(), to: todayISO(), kind: 'holiday' })],
    ['remove a day off of Kit’s', demo.del(`/pay/staff/${kit}/absences/1`)],
    ['the 1p test file', demo.post(`/payments/connections/${connection}/test-file`, { holderName: 'Kit Lane', sortCode: '000000', accountNumber: '00000001', code: '123456' })],
    ['the test file’s result', demo.post(`/payments/connections/${connection}/test-file-result`, { result: 'paid' })],
    ['two approvals off', demo.put('/payments/settings', { twoApprovals: false, code: '123456' })],
  ];
  for (const [what, p] of attempts) {
    const r = await p;
    assert.equal(r.status, 403, `${what}: ${r.status} ${JSON.stringify(r.json)}`);
    assert.equal(r.json?.details?.code, 'demo_account', `${what}: ${JSON.stringify(r.json)}`);
    assert.match(r.json.error, /^Demo accounts cannot /);
  }
  assert.equal(get(db(), `SELECT 1 FROM meta WHERE key = ?`, [TWO_APPROVALS_KEY + '_off_request']), undefined, 'no request to turn it off');
  assert.equal(get<{ d: string | null }>(db(), `SELECT leaving_date AS d FROM users WHERE id = ?`, [kit])!.d, null, 'no leaving date');
  // the demo company's own people stay the demo's to play with: a day off for the demo rep passes the demo guard
  const jordan = idOf(DEMO_ACCOUNTS.rep.employeeId);
  const own = await demo.put(`/pay/staff/${jordan}/leaving-date`, { leavingDate: null });
  assert.notEqual(own.json?.details?.code, 'demo_account', JSON.stringify(own.json));
});

/** A second app on the test database that trusts a proxy on this machine, so a request can come "from 192.168.1.20". */
async function proxiedApp(): Promise<string> {
  const server = http.createServer(createApp(db(), { trustProxy: 'loopback' }));
  server.keepAliveTimeout = 0;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  extra.push({ close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }) });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
}

async function fromPhone(base: string, cookie: string, method: string, url: string, body?: unknown): Promise<{ status: number; json: Json }> {
  const res = await fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', cookie, 'x-forwarded-for': '192.168.1.20', 'x-forwarded-proto': 'http' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

test('over plain http from another device: money’s new routes are refused like the other money actions', async () => {
  srv = await startTestServer();
  const base = await proxiedApp();
  const admin = new TestClient(base);
  assert.equal((await signInWith(db(), admin, FIXTURE_ACCOUNTS.admin)).status, 200);
  const rep = srv.fixture!.users.rep;
  const insecure = (r: { status: number; json: Json }) => r.status === 403 && r.json?.details?.code === 'insecure_connection';
  const refused: [string, string, unknown?][] = [
    ['POST', '/me/bank-details/confirm', { code: '123456' }],
    ['POST', '/me/bank-details/report', { note: 'Not mine' }],
    ['POST', `/invoices/profile/${rep}/vat/confirm`, { vatNumber: 'GB999999973', code: '123456' }],
    ['PUT', '/payments/settings', { twoApprovals: false, code: '123456' }],
    ['POST', '/payments/connections/1/test-file', { holderName: 'Ada Admin', sortCode: '000000', accountNumber: '00000001', code: '123456' }],
    ['POST', '/payments/connections/1/test-file-result', { result: 'paid' }],
    // after a bank file's download: "it was not uploaded" / "the bank did not pay them" free those weeks to be paid again
    ['POST', '/payments/batches/1/cancel', { confirm: 'typed words', code: '123456' }],
    ['POST', '/payments/batches/1/mark-paid', { paidUserIds: [], failedUserIds: [rep], confirm: 'typed words', code: '123456' }],
  ];
  for (const [m, p, b] of refused) {
    const r = await fromPhone(base, admin.cookie, m, p, b);
    assert.ok(insecure(r), `${m} ${p}: ${r.status} ${JSON.stringify(r.json)}`);
    assert.equal(r.json.error, ACCESS_MESSAGES.insecure);
  }
  // cancelling or marking paid with no confirmation carries no code: it reaches the route (here, a payment that is not there)
  for (const p of ['/payments/batches/999/cancel', '/payments/batches/999/mark-paid']) {
    const r = await fromPhone(base, admin.cookie, 'POST', p, {});
    assert.ok(!insecure(r), `${p}: ${JSON.stringify(r.json)}`);
  }
});

test('two approvals: during the trial a demo administrator with two-step on is not one of the two people', async () => {
  srv = await startTestServer({ seed: true });
  const demoAdmin = idOf(DEMO_ACCOUNTS.admin.employeeId);
  const sam = addPerson('LM-0700', 'sam.owner@office.example', 'admin', 'Sam');
  enrolTwoFactor(db(), sam);
  enrolTwoFactor(db(), demoAdmin); // a demo account may turn two-step on for itself
  run(db(), `INSERT INTO payment_connections (provider, name, mode, settings_json, status, created_at) VALUES ('bank_file', 'Office bank', 'live', '{}', 'connected', ?)`, [new Date().toISOString()]);
  srv.resetCache();

  assert.equal(adminsWithTwoStep(db()), 1, 'only Sam can approve');
  const settings = paymentsSettings(db());
  assert.equal(settings.twoApprovals, false, 'not switched on for good by the demo administrator');
  assert.equal(get(db(), `SELECT 1 FROM meta WHERE key = ?`, [TWO_APPROVALS_KEY]), undefined);

  // switched on by Sam, the office is told no second person can approve (the demo administrator does not count)
  run(db(), `INSERT INTO meta (key, value) VALUES (?, 'on')`, [TWO_APPROVALS_KEY]);
  srv.resetCache();
  assert.equal(paymentsSettings(db()).stuck, true);
  const me: UserWithTeam = { ...getUser(db(), sam)!, twoFactorEnabled: true };
  const keys = buildAttentionFeed(db(), me, attentionNow()).items.map((i) => i.key);
  assert.ok(keys.includes('payments:two-approvals-stuck'), keys.join(', '));

  // once the trial is over (golive removes the demo company; here only the switch), everyone with two-step counts
  setTrialMode(db(), false);
  srv.resetCache();
  assert.equal(adminsWithTwoStep(db()), 2);
  assert.equal(paymentsSettings(db()).stuck, false);
});
