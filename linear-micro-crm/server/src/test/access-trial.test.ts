/**
 * Trial mode (findings SEC-1, CLM-8, CLAIMS-MISSED-1, SECURITY-MISSED-5, CODE-MISSED-2). The demo company and its
 * one-tap demo accounts exist only while the database is in trial mode. Admins see it plainly (a banner and a
 * Needs-attention item), demo sessions last the normal 14 hours, and a one-tap demo account can never reach real
 * people's bank details, make or promote an admin, reset anyone's sign-in, hand out setup codes, switch a payment
 * connection to live or approve a payment.
 */
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { ACCESS_MESSAGES, PAYMENT_LIVE_CONFIRMATION, paydayForWeek } from '@lm/shared';
import { get, run, type Db } from '../db/connection.ts';
import { addDays, mondayOf, todayISO } from '../lib/dates.ts';
import { createFakeProvider } from '../lib/payments/fake.ts';
import { registerPaymentProvider, unregisterPaymentProvider } from '../lib/payments/registry.ts';
import { isTrialMode, trialStatus } from '../lib/trial.ts';
import { totp } from '../lib/totp.ts';
import { DEMO_ACCOUNTS, currentCode, enrolTwoFactor, startTestServer, type Json, type TestClient, type TestServer } from './helpers.ts';

let srv: TestServer | null = null;
afterEach(async () => {
  unregisterPaymentProvider('fake');
  await srv?.close();
  srv = null;
});

const db = (): Db => srv!.db;
const idOf = (employeeId: string) => get<{ id: number }>(db(), `SELECT id FROM users WHERE lower(employee_id) = lower(?)`, [employeeId])!.id;
const maxAgeOf = (headers: Headers) => Number(/Max-Age=(\d+)/i.exec(headers.get('set-cookie') ?? '')?.[1] ?? Number.NaN);
const isDemoRefusal = (r: { status: number; json: Json }) => r.status === 403 && r.json?.details?.code === 'demo_account';

/** A real (non-demo) person added to the demo database by hand, as Matt does during his trial. */
function addRealPerson(email = 'real.person@example.test', employeeId = 'LM-0600'): number {
  const plan = get<{ id: number }>(db(), `SELECT id FROM pay_plans WHERE position = 'field_rep' ORDER BY id LIMIT 1`)!.id;
  return run(
    db(),
    `INSERT INTO users (employee_id, email, first_name, last_name, role, position, team_id, pay_plan_id, start_date, status, phone, avatar_color, city)
     VALUES (?, ?, 'Real', 'Person', 'rep', 'field_rep', NULL, ?, ?, 'active', NULL, '#4F46E5', 'Manchester')`,
    [employeeId, email, plan, todayISO()],
  ).lastInsertRowid;
}

test('the demo seed puts the database in trial mode; the route-test fixture is not in trial mode', async () => {
  srv = await startTestServer({ seed: true });
  assert.equal(isTrialMode(db()), true);
  assert.deepEqual(trialStatus(db()), { trialMode: true, demoSignIns: true });
  await srv.close();
  srv = await startTestServer();
  assert.equal(isTrialMode(db()), false);
});

test('admins see trial mode: GET /auth/me carries it and the Needs-attention feed leads with it (SECURITY-MISSED-5)', async () => {
  srv = await startTestServer({ seed: true });
  const admin = await srv.login('admin');
  const me = await admin.get('/auth/me');
  assert.deepEqual(me.json.trial, { trialMode: true, demoSignIns: true });
  // the sign-in answer carries it too, so the banner is there from the first page
  const signIn = await srv.anon().post('/auth/login', DEMO_ACCOUNTS.admin);
  assert.deepEqual(signIn.json.trial, { trialMode: true, demoSignIns: true });
  const feed = await admin.get('/me/attention');
  const item = feed.json.items.find((i: Json) => i.key.startsWith('security:trial'));
  assert.ok(item, JSON.stringify(feed.json.items.map((i: Json) => i.key)));
  assert.equal(item.title, ACCESS_MESSAGES.trialTitle);
  assert.equal(item.body, ACCESS_MESSAGES.trialBody);
  assert.equal(item.severity, 'danger');
  // a rep sees neither
  const rep = await srv.login('rep');
  assert.equal((await rep.get('/auth/me')).json.trial, undefined);
  assert.ok(!(await rep.get('/me/attention')).json.items.some((i: Json) => i.key.startsWith('security:trial')));
  // LM_DEMO_ACCOUNTS=0: still trial mode (the demo company is there), but the sign-ins are off
  const prev = process.env.LM_DEMO_ACCOUNTS;
  process.env.LM_DEMO_ACCOUNTS = '0';
  try {
    srv.resetCache();
    assert.deepEqual(trialStatus(db()), { trialMode: true, demoSignIns: false });
    assert.deepEqual((await srv.anon().get('/auth/demo-accounts')).json, { accounts: [] });
  } finally {
    if (prev === undefined) delete process.env.LM_DEMO_ACCOUNTS;
    else process.env.LM_DEMO_ACCOUNTS = prev;
  }
});

test('demo sign-ins get the normal 14-hour session, not 14 days (SEC-1)', async () => {
  srv = await startTestServer({ seed: true });
  const r = await srv.anon().post('/auth/login', DEMO_ACCOUNTS.admin);
  assert.equal(r.status, 200);
  assert.equal(r.json.requiresTwoFactor, undefined, 'still one tap during the trial');
  assert.equal(maxAgeOf(r.headers), 14 * 3600, 'cookie lasts 14 hours');
  assert.equal(r.json.session.maxHours, 14);
});

test('a demo admin cannot see or change a real person’s bank details (CLAIMS-MISSED-1)', async () => {
  srv = await startTestServer({ seed: true });
  const realId = addRealPerson();
  const admin = await srv.login('admin');
  const body = { holderName: 'Someone Else', sortCode: '040004', accountNumber: '12345678' };
  const put = await admin.put(`/users/${realId}/bank-details`, body);
  assert.ok(isDemoRefusal(put), JSON.stringify(put));
  assert.match(put.json.error, /^Demo accounts cannot /);
  assert.ok(isDemoRefusal(await admin.get(`/users/${realId}/bank-details`)));
  assert.ok(isDemoRefusal(await admin.post(`/users/${realId}/bank-details/confirm`, {})));
  assert.equal(get(db(), `SELECT 1 FROM bank_accounts WHERE user_id = ?`, [realId]), undefined, 'nothing stored');
  // the demo people's own (invented) details still work for the demo
  const jordan = idOf(DEMO_ACCOUNTS.rep.employeeId);
  assert.equal((await admin.get(`/users/${jordan}/bank-details`)).status, 200);
});

test('a one-tap starter or demo account cannot hold bank details of a real person, its own included', async () => {
  srv = await startTestServer({ seed: true });
  const realId = addRealPerson();
  // a real person who still signs in one-tap would be anyone's: mark them as a one-tap starter account
  run(db(), `INSERT INTO meta (key, value) VALUES ('seed_demo_teams', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [
    JSON.stringify([{ teamId: 1, accounts: [{ id: realId, employeeId: 'LM-0600', email: 'real.person@example.test' }] }]),
  ]);
  srv.resetCache();
  const c = await srv.login({ email: 'real.person@example.test', employeeId: 'LM-0600' });
  const r = await c.put('/me/bank-details', { holderName: 'Real Person', sortCode: '040004', accountNumber: '12345678' });
  assert.ok(isDemoRefusal(r), JSON.stringify(r));
});

test('a demo admin cannot create or promote an admin, reset anyone’s sign-in or hand out setup codes, even after setting up two-step', async () => {
  srv = await startTestServer({ seed: true });
  const admin = await srv.login('admin');
  const adminId = idOf(DEMO_ACCOUNTS.admin.employeeId);
  // even a demo admin that set up its own authenticator (anyone could have done so) stays a demo account
  enrolTwoFactor(db(), adminId);
  const code = () => currentCode(db(), adminId);
  const owner = get<{ id: number }>(db(), `SELECT id FROM pay_plans WHERE position = 'owner'`)!.id;
  const made = await admin.post('/users', {
    email: 'shadow@example.test', firstName: 'Shadow', lastName: 'Admin', role: 'admin', position: 'owner', teamId: null, payPlanId: owner,
    startDate: todayISO(), status: 'active', phone: null, city: 'Manchester', code: code(),
  });
  assert.ok(isDemoRefusal(made), JSON.stringify(made));
  assert.equal(get(db(), `SELECT 1 FROM users WHERE email = 'shadow@example.test'`), undefined);
  const jordan = idOf(DEMO_ACCOUNTS.rep.employeeId);
  assert.ok(isDemoRefusal(await admin.patch(`/users/${jordan}`, { role: 'admin', code: code() })));
  assert.ok(isDemoRefusal(await admin.patch(`/users/${jordan}`, { email: 'jordan.new@example.test', code: code() })));
  assert.ok(isDemoRefusal(await admin.post(`/users/${jordan}/2fa/reset`, { code: code() })));
  assert.ok(isDemoRefusal(await admin.post(`/auth/pin/reset/${jordan}`, { code: code() })));
  assert.ok(isDemoRefusal(await admin.post(`/users/${jordan}/setup-code`, { code: code() })));
  const hannah = idOf(DEMO_ACCOUNTS.client.employeeId);
  assert.ok(isDemoRefusal(await admin.post(`/client-accounts/${hannah}/reset-2fa`, { code: code() })));
  assert.ok(isDemoRefusal(await admin.post(`/client-accounts/${hannah}/reset-pin`, { code: code() })));
  // an ordinary edit still works for the demo
  assert.equal((await admin.patch(`/users/${jordan}`, { phone: '07700 900111' })).status, 200);
  // and a non-admin person can still be added (their setup code is shown to whoever added them)
  const rep = await admin.post('/users', {
    email: 'trial.rep@example.test', firstName: 'Trial', lastName: 'Rep', role: 'rep', position: 'field_rep', teamId: null,
    payPlanId: get<{ id: number }>(db(), `SELECT id FROM pay_plans WHERE position = 'field_rep' ORDER BY id LIMIT 1`)!.id,
    startDate: todayISO(), status: 'active', phone: null, city: 'Manchester',
  });
  assert.equal(rep.status, 201, JSON.stringify(rep.json));
});

test('a demo admin cannot switch a payment connection to live or approve a payment', async () => {
  srv = await startTestServer({ seed: true });
  const admin = await srv.login('admin');
  const adminId = idOf(DEMO_ACCOUNTS.admin.employeeId);
  registerPaymentProvider(createFakeProvider({ kind: 'api', submitStatus: 'paid' }));
  const conn = await admin.post('/payments/connections', { provider: 'fake', name: 'Fake' });
  assert.equal(conn.status, 201, JSON.stringify(conn.json));
  assert.equal((await admin.post(`/payments/connections/${conn.json.id}/test`)).json.ok, true);
  const live = await admin.patch(`/payments/connections/${conn.json.id}`, { mode: 'live', confirm: PAYMENT_LIVE_CONFIRMATION });
  assert.ok(isDemoRefusal(live), JSON.stringify(live));
  assert.equal(get<{ mode: string }>(db(), `SELECT mode FROM payment_connections WHERE id = ?`, [conn.json.id])!.mode, 'test');
  // a draft in test mode is fine for the demo; approving it is not, code or no code
  const jordan = idOf(DEMO_ACCOUNTS.rep.employeeId);
  const week = addDays(mondayOf(todayISO()), -7 * 150);
  const runId = run(
    db(),
    `INSERT INTO payroll_runs (user_id, week_start, week_end, days_worked, sales, team_sales, base_pay, commission, bonus, overrides, deductions, gross, due_date, paid_date, status, reference)
     VALUES (?, ?, ?, 1, 0, 0, 63.5, 0, 0, 0, 0, 63.5, ?, NULL, 'pending', 'PAY-T-1')`,
    [jordan, week, addDays(week, 6), paydayForWeek(week)],
  ).lastInsertRowid;
  const draft = await admin.post('/payments/batches', { connectionId: conn.json.id, runIds: [runId] });
  assert.equal(draft.status, 201, JSON.stringify(draft.json));
  const setup = await admin.post('/auth/2fa/setup');
  await admin.post('/auth/2fa/enable', { code: totp(setup.json.secret) });
  const approve = await admin.post(`/payments/batches/${draft.json.id}/approve`, { code: currentCode(db(), adminId) });
  assert.ok(isDemoRefusal(approve), JSON.stringify(approve));
  assert.equal(get<{ status: string }>(db(), `SELECT status FROM payroll_runs WHERE id = ?`, [runId])!.status, 'pending');
});

test('outside trial mode nothing of this applies: the old demo accounts are ordinary accounts that need a setup code', async () => {
  srv = await startTestServer({ seed: true });
  run(db(), `UPDATE meta SET value = '0' WHERE key = 'ext:access:trial-mode'`);
  srv.resetCache();
  assert.deepEqual((await srv.anon().get('/auth/demo-accounts')).json, { accounts: [] });
  assert.deepEqual((await srv.anon().post('/auth/login', DEMO_ACCOUNTS.admin)).json, { requiresSetupCode: true });
});

test('a client account in the demo stays one tap only while in trial mode', async () => {
  srv = await startTestServer({ seed: true });
  const c: TestClient = srv.anon();
  assert.equal((await c.post('/auth/login', DEMO_ACCOUNTS.client)).status, 200);
});
