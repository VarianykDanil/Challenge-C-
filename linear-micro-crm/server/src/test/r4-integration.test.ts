/**
 * Release 1.4 — where package S (two-step verification for everyone, the sign-out 14 hours after sign-in) meets the
 * payments packages (F, P, A). Each rule is checked on purpose here, on the merged code:
 *  - the demo admin, exempt from two-step while Linear Hub is still the demo, can still set it up voluntarily — and must
 *    before approving a payment (every payout needs a fresh code); switching it off again puts the hold back;
 *  - the 14-hour sign-out never interrupts a payment already approved: the 5-minute job checks it server-side, with no
 *    session, and marks the runs paid; a bank file approved before the sign-out is marked paid after signing in again;
 *  - the payments and bank details routes sit behind the two-step setup gate (an account that must use two-step and has
 *    not set it up reaches none of them, so a bank details change by a non-exempt account always needs a code);
 *  - a client (charity) account reaches nothing of payments or bank details, set up or not, demo or invited, and its
 *    portal's answers carry none of it.
 * Sessions run on the real clock: a test moves a session's sign-in time back in the sessions table, as r4-security does.
 */
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { PAYMENT_LIVE_CONFIRMATION, paydayForWeek, sessionMaxAgeMessage } from '@lm/shared';
import { all, get, run, type Db } from '../db/connection.ts';
import { encrypt } from '../lib/crypto.ts';
import { addDays, businessNow, mondayOf, todayISO } from '../lib/dates.ts';
import { refreshWaitingBatches } from '../lib/payments/batches.ts';
import { createFakeProvider, type FakeProvider } from '../lib/payments/fake.ts';
import { registerPaymentProvider, unregisterPaymentProvider } from '../lib/payments/registry.ts';
import { totp } from '../lib/totp.ts';
import { resetCodeFailures } from '../lib/twofactor.ts';
import { purgeExpiredSessions } from '../middleware/auth.ts';
import { DEMO_ACCOUNTS, currentCode, startTestServer, type Json, type TestClient, type TestServer } from './helpers.ts';
import { recordSandboxRun } from './moneyTestUtils.ts';

const HOUR = 3_600_000;
const MIN = 60_000;

let srv: TestServer | null = null;
afterEach(async () => {
  unregisterPaymentProvider('fake');
  resetCodeFailures();
  await srv?.close();
  srv = null;
});

const db = (): Db => srv!.db;
const idOf = (employeeId: string) => get<{ id: number }>(db(), `SELECT id FROM users WHERE lower(employee_id) = lower(?)`, [employeeId])!.id;
const tokenOf = (c: TestClient) => c.cookie.replace(/^lm_session=/, '');

/** Moves this client's session back: signed in `ms` ago, its last request just now (real clock). */
function signedInAgo(c: TestClient, ms: number): void {
  const now = Date.now();
  run(db(), `UPDATE sessions SET created_at = ?, last_seen_at = ? WHERE token = ?`, [new Date(now - ms).toISOString(), new Date(now).toISOString(), tokenOf(c)]);
}

/** An unpaid run for a week long gone (no invoice: the 1.2 rules), unless that week already has one. */
function addRun(userId: number, weekStart: string, gross: number): number {
  return run(
    db(),
    `INSERT INTO payroll_runs (user_id, week_start, week_end, days_worked, sales, team_sales, base_pay, commission, bonus, overrides, deductions, gross, due_date, paid_date, status, reference)
     VALUES (?, ?, ?, 1, 0, 0, ?, 0, 0, 0, 0, ?, ?, NULL, 'pending', ?)`,
    [userId, weekStart, addDays(weekStart, 6), gross, gross, paydayForWeek(weekStart), `PAY-I-${userId}-${weekStart}`],
  ).lastInsertRowid;
}

/** Confirmed bank details straight into the table (sort code 00-00-00: obviously fake). */
function setBank(userId: number, account: string): void {
  // a day before now on the business clock, the clock payments compare bank details changes with (LM_BUSINESS_NOW)
  const at = new Date(businessNow().getTime() - 86_400_000).toISOString();
  run(
    db(),
    `INSERT INTO bank_accounts (user_id, holder_name, sort_code_enc, account_number_enc, last4, sort_code_last2, changed_at, changed_by, confirmed_by_admin_at, confirmed_by)
     VALUES (?, ?, ?, ?, ?, '00', ?, ?, ?, NULL)
     ON CONFLICT(user_id) DO UPDATE SET account_number_enc = excluded.account_number_enc, last4 = excluded.last4, changed_at = excluded.changed_at, confirmed_by_admin_at = excluded.confirmed_by_admin_at`,
    [userId, `Person ${userId} Test`, encrypt('000000'), encrypt(account), account.slice(-4), at, userId, at],
  );
}

const runStatus = (id: number) => get<{ status: string; paidDate: string | null }>(db(), `SELECT status, paid_date AS paidDate FROM payroll_runs WHERE id = ?`, [id])!;
const PAID = ['paid', 'late'];

/** A fake connection through the admin's own routes: API (tested, then live) or a bank file. */
async function connect(admin: TestClient, kind: 'api' | 'file', fakeOpts: Parameters<typeof createFakeProvider>[0] = {}): Promise<{ id: number; fake: FakeProvider }> {
  const fake = createFakeProvider({ kind, ...fakeOpts });
  registerPaymentProvider(fake);
  const made = await admin.post('/payments/connections', { provider: 'fake', name: kind === 'file' ? 'File' : 'Fake' });
  assert.equal(made.status, 201, JSON.stringify(made.json));
  const id = made.json.id as number;
  if (kind === 'api') {
    assert.equal((await admin.post(`/payments/connections/${id}/test`)).json.ok, true);
    recordSandboxRun(db(), id);
    assert.equal((await admin.patch(`/payments/connections/${id}`, { mode: 'live', confirm: PAYMENT_LIVE_CONFIRMATION })).status, 200);
    assert.equal((await admin.post(`/payments/connections/${id}/test`)).json.ok, true);
  } else {
    // a file connection starts in test mode too; these tests are about real files
    assert.equal((await admin.patch(`/payments/connections/${id}`, { mode: 'live', confirm: PAYMENT_LIVE_CONFIRMATION })).status, 200);
  }
  return { id, fake };
}

/** Every payments route and every bank details route (relative to /api), with a body for the writes. */
function paymentRoutes(someUserId: number): [string, string][] {
  return [
    ['GET', '/payments/providers'],
    ['GET', '/payments/connections'],
    ['POST', '/payments/connections'],
    ['PATCH', '/payments/connections/1'],
    ['DELETE', '/payments/connections/1'],
    ['POST', '/payments/connections/1/test'],
    ['GET', '/payments/batches'],
    ['POST', '/payments/batches'],
    ['GET', '/payments/batches/1'],
    ['POST', '/payments/batches/1/approve'],
    ['POST', '/payments/batches/1/refresh'],
    ['POST', '/payments/batches/1/cancel'],
    ['GET', '/payments/batches/1/file'],
    ['POST', '/payments/batches/1/mark-paid'],
    ['POST', '/payments/connections/1/test-file'],
    ['POST', '/payments/connections/1/test-file-result'],
    ['GET', '/payments/settings'],
    ['PUT', '/payments/settings'],
    ['GET', '/me/bank-details'],
    ['PUT', '/me/bank-details'],
    ['GET', `/users/${someUserId}/bank-details`],
    ['PUT', `/users/${someUserId}/bank-details`],
    ['POST', `/users/${someUserId}/bank-details/confirm`],
  ];
}

const WRITE_BODY = { provider: 'fake', name: 'x', holderName: 'Someone Test', sortCode: '000000', accountNumber: '00000001', code: '123456', runIds: [1], connectionId: 1 };

// ───────────────────────────── the demo admin ─────────────────────────────

test('the demo admin is exempt from two-step, yet must set it up before approving a payment — and can, voluntarily', async () => {
  srv = await startTestServer({ seed: true });
  const adminId = idOf(DEMO_ACCOUNTS.admin.employeeId);
  const jordanId = idOf(DEMO_ACCOUNTS.rep.employeeId);
  // one-tap demo sign-in: no code step, nothing held
  const signIn = await srv.anon().post('/auth/login', DEMO_ACCOUNTS.admin);
  assert.equal(signIn.status, 200);
  assert.equal(signIn.json.requiresTwoFactor, undefined);
  const admin = await srv.login('admin');
  const me = (await admin.get('/auth/me')).json.user;
  assert.equal(me.twoFactorEnabled, false);
  assert.equal(me.twoFactorSetupRequired, false, 'exempt: never held at the setup gate');
  assert.equal((await admin.get('/auth/2fa')).json.required, false);
  assert.equal((await admin.get('/me/bank-details')).json.codeRequired, false, 'no code to ask for yet');

  const { id: conn, fake } = await connect(admin, 'api', { submitStatus: 'paid' });
  const weekStart = addDays(mondayOf(todayISO()), -7 * 150); // years back: no seeded run that week
  assert.equal(get(db(), `SELECT 1 FROM payroll_runs WHERE user_id = ? AND week_start = ?`, [jordanId, weekStart]), undefined);
  const runId = addRun(jordanId, weekStart, 63.5);
  const draft = await admin.post('/payments/batches', { connectionId: conn, runIds: [runId] });
  assert.equal(draft.status, 201, JSON.stringify(draft.json));
  assert.equal(draft.json.count, 1, 'Jordan’s seeded bank details are confirmed');

  // no two-step yet: no payout, whatever code is typed
  const held = await admin.post(`/payments/batches/${draft.json.id}/approve`, { code: '123456' });
  assert.equal(held.status, 403);
  assert.equal(held.json.details.twoFactorRequired, true);
  assert.match(held.json.error, /Set up two-step verification in Settings → Security first: every payment needs a code from your authenticator app/);
  assert.equal(fake.calls.submit, 0, 'nothing sent');
  assert.equal(runStatus(runId).status, 'pending');

  // set up voluntarily, through the same routes as everyone
  const setup = await admin.post('/auth/2fa/setup');
  assert.equal(setup.status, 201, JSON.stringify(setup.json));
  const on = await admin.post('/auth/2fa/enable', { code: totp(setup.json.secret) });
  assert.equal(on.status, 200, JSON.stringify(on.json));
  assert.equal(on.json.recoveryCodes.length, 10);
  const after = (await admin.get('/auth/me')).json;
  assert.equal(after.user.twoFactorEnabled, true);
  assert.equal(after.session.maxHours, null, 'still the demo: the 14-day session, not the 14 hours');
  assert.equal((await admin.get('/auth/2fa')).json.required, false, 'still not required of the demo admin');
  assert.equal((await admin.get('/me/bank-details')).json.codeRequired, true, 'with two-step on, a bank details change asks for the code');

  // now a fresh code approves it; a wrong one never pays
  const wrongCode = currentCode(db(), adminId) === '000000' ? '111111' : '000000';
  const wrong = await admin.post(`/payments/batches/${draft.json.id}/approve`, { code: wrongCode });
  assert.equal(wrong.status, 400);
  assert.equal(fake.calls.submit, 0);
  const ok = await admin.post(`/payments/batches/${draft.json.id}/approve`, { code: currentCode(db(), adminId) });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(ok.json.status, 'completed');
  assert.ok(PAID.includes(runStatus(runId).status));
  assert.equal(fake.paymentsMade(), 1);

  // the next sign-in asks for the code (no remember-this-device), exempt or not
  const again = await srv.anon().post('/auth/login', DEMO_ACCOUNTS.admin);
  assert.equal(again.json.requiresTwoFactor, true);

  // the demo admin may switch it off again (exempt) — and then payments are held again
  assert.equal((await admin.post('/auth/2fa/disable', { code: currentCode(db(), adminId) })).status, 204);
  const second = addRun(jordanId, addDays(weekStart, 7), 63.5);
  const draft2 = await admin.post('/payments/batches', { connectionId: conn, runIds: [second] });
  assert.equal(draft2.status, 201, JSON.stringify(draft2.json));
  assert.equal((await admin.post(`/payments/batches/${draft2.json.id}/approve`, { code: '123456' })).json.details.twoFactorRequired, true);
  assert.equal(fake.paymentsMade(), 1);
});

test('LM_DEMO_ACCOUNTS=0: the demo admin is held at the setup gate before any payments page', async () => {
  srv = await startTestServer({ seed: true });
  const prev = process.env.LM_DEMO_ACCOUNTS;
  process.env.LM_DEMO_ACCOUNTS = '0';
  try {
    srv.resetCache();
    const admin = await srv.login('admin', undefined, { twoFactor: false });
    for (const [m, p] of paymentRoutes(idOf(DEMO_ACCOUNTS.rep.employeeId))) {
      const r = await admin.req(m, p, m === 'GET' ? undefined : WRITE_BODY);
      assert.equal(r.status, 403, `${m} ${p}`);
      assert.equal(r.json.twoFactorSetupRequired, true, `${m} ${p}`);
    }
  } finally {
    if (prev === undefined) delete process.env.LM_DEMO_ACCOUNTS;
    else process.env.LM_DEMO_ACCOUNTS = prev;
  }
});

// ───────────────────────────── the 14 hours ─────────────────────────────

test('the sign-out 14 hours after sign-in never interrupts a payment already approved: the job finishes it server-side', async () => {
  srv = await startTestServer();
  const fx = srv.fixture!;
  const admin = await srv.login('admin');
  const { id: conn, fake } = await connect(admin, 'api', { submitStatus: 'processing' });
  const weekStart = addDays(mondayOf(fx.today), -21);
  setBank(fx.users.rep, '00000011');
  setBank(fx.users.repB, '00000012');
  const a = addRun(fx.users.rep, weekStart, 120.5);
  const b = addRun(fx.users.repB, weekStart, 63.5);
  const draft = (await admin.post('/payments/batches', { connectionId: conn, runIds: [a, b] })).json;
  const approved = await admin.post(`/payments/batches/${draft.id}/approve`, { code: currentCode(db(), fx.users.admin) });
  assert.equal(approved.status, 200, JSON.stringify(approved.json));
  assert.equal(approved.json.status, 'processing');
  assert.deepEqual(approved.json.items.map((i: Json) => i.status), ['processing', 'processing']);

  // 14 hours and a minute after signing in: Matt is signed out, with the reason
  signedInAgo(admin, 14 * HOUR + MIN);
  const ended = await admin.get(`/payments/batches/${draft.id}`);
  assert.equal(ended.status, 401);
  assert.equal(ended.json.error, sessionMaxAgeMessage(14));
  assert.deepEqual(ended.json.details, { sessionEnded: 'max_age', maxHours: 14 });
  purgeExpiredSessions(db()); // the sweep of ended sessions touches no payment
  const batch = get<{ status: string; cancelledAt: string | null }>(db(), `SELECT status, cancelled_at AS cancelledAt FROM payment_batches WHERE id = ?`, [draft.id])!;
  assert.deepEqual({ ...batch }, { status: 'processing', cancelledAt: null }, 'the payment carries on');

  // the 5-minute job (lib/payments/job.ts) needs no session: the provider says paid, the runs are marked paid
  fake.script({ refreshStatus: 'paid' });
  assert.equal(await refreshWaitingBatches(db()), 1);
  for (const id of [a, b]) assert.ok(PAID.includes(runStatus(id).status), `run ${id} paid`);
  assert.equal(fake.paymentsMade(), 2);
  assert.ok(all(db(), `SELECT 1 FROM audit_log WHERE entity = 'payroll_run' AND summary LIKE 'Marked paid by payment%'`).length >= 2, 'recorded in the audit trail');

  // signing in again (with the code) shows it finished; nothing is paid twice
  const back = await srv.login('admin');
  const done = await back.get(`/payments/batches/${draft.id}`);
  assert.equal(done.status, 200);
  assert.equal(done.json.status, 'completed');
  assert.equal(done.json.paidCount, 2);
  assert.equal((await back.post(`/payments/batches/${draft.id}/refresh`)).status, 200);
  assert.equal(fake.paymentsMade(), 2);
});

test('a bank file approved before the 14-hour sign-out is marked paid after signing in again', async () => {
  srv = await startTestServer();
  const fx = srv.fixture!;
  const admin = await srv.login('admin');
  const { id: conn } = await connect(admin, 'file');
  setBank(fx.users.rep, '00000021');
  const runId = addRun(fx.users.rep, addDays(mondayOf(fx.today), -21), 200);
  const draft = (await admin.post('/payments/batches', { connectionId: conn, runIds: [runId] })).json;
  const approved = await admin.post(`/payments/batches/${draft.id}/approve`, { code: currentCode(db(), fx.users.admin) });
  assert.equal(approved.status, 200, JSON.stringify(approved.json));
  assert.equal(approved.json.status, 'submitted');
  signedInAgo(admin, 14 * HOUR + MIN);
  assert.equal((await admin.get(`/payments/batches/${draft.id}/file`)).status, 401);
  const back = await srv.login('admin');
  assert.equal((await back.get(`/payments/batches/${draft.id}/file`)).status, 200, 'the file is still there');
  const itemId = approved.json.items[0].id as number;
  const marked = await back.post(`/payments/batches/${draft.id}/mark-paid`, { paid: [itemId] });
  assert.equal(marked.status, 200, JSON.stringify(marked.json));
  assert.ok(PAID.includes(runStatus(runId).status));
});

// ───────────────────────────── the setup gate ─────────────────────────────

test('the payments and bank details routes are behind the two-step setup gate; a non-exempt account never changes bank details without a code', async () => {
  srv = await startTestServer();
  const fx = srv.fixture!;
  const admin = await srv.login('admin', undefined, { twoFactor: false });
  assert.equal((await admin.get('/auth/me')).json.user.twoFactorSetupRequired, true);
  for (const [m, p] of paymentRoutes(fx.users.rep)) {
    const r = await admin.req(m, p, m === 'GET' ? undefined : WRITE_BODY);
    assert.equal(r.status, 403, `admin ${m} ${p}`);
    assert.equal(r.json.twoFactorSetupRequired, true, `admin ${m} ${p}`);
  }
  for (const who of ['leader', 'recruiter', 'rep'] as const) {
    const c = await srv.login(who, undefined, { twoFactor: false });
    for (const [m, p] of [['GET', '/me/bank-details'], ['PUT', '/me/bank-details']] as const) {
      const r = await c.req(m, p, m === 'GET' ? undefined : WRITE_BODY);
      assert.equal(r.status, 403, `${who} ${m} ${p}`);
      assert.equal(r.json.twoFactorSetupRequired, true, `${who} ${m} ${p}`);
    }
  }
  assert.equal(all(db(), `SELECT 1 FROM payment_connections`).length, 0, 'nothing written');
  assert.equal(all(db(), `SELECT 1 FROM bank_accounts`).length, 0, 'nothing written');
  assert.equal(all(db(), `SELECT 1 FROM audit_log WHERE entity IN ('payment_connection', 'payment_batch', 'bank_account')`).length, 0);

  // once set up, the admin reaches them
  const setup = await admin.post('/auth/2fa/setup');
  assert.equal((await admin.post('/auth/2fa/enable', { code: totp(setup.json.secret) })).status, 200);
  assert.equal((await admin.get('/payments/providers')).status, 200);
  assert.equal((await admin.get('/me/bank-details')).json.codeRequired, true);

  // an admin whose two-step was reset (lost phone) is held again until it is set up anew
  run(db(), `UPDATE users SET totp_enabled_at = NULL, totp_secret_enc = NULL WHERE id = ?`, [fx.users.admin]);
  srv.resetCache();
  const reset = await admin.post('/payments/connections', { provider: 'fake' });
  assert.equal(reset.status, 403);
  assert.equal(reset.json.twoFactorSetupRequired, true);
});

// ───────────────────────────── the client portal ─────────────────────────────

/** Every key anywhere in a JSON value. */
function keysOf(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) for (const x of v) keysOf(x, out);
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) out.push(k), keysOf(x, out);
  return out;
}

async function assertNoPayments(c: TestClient, label: string, someUserId: number): Promise<void> {
  for (const [m, p] of paymentRoutes(someUserId)) {
    const r = await c.req(m, p, m === 'GET' ? undefined : WRITE_BODY);
    assert.equal(r.status, 403, `${label} ${m} ${p}`);
    assert.equal(r.json.clientPortalOnly, true, `${label} ${m} ${p}`);
  }
  for (const p of ['/finance/payroll', '/me/attention', '/users']) assert.equal((await c.get(p)).status, 403, `${label} ${p}`);
}

test('a client (charity) account reaches nothing of payments or bank details, set up or not', async () => {
  srv = await startTestServer();
  const fx = srv.fixture!;
  setBank(fx.users.rep, '00000031');
  const notSetUp = await srv.login('client', undefined, { twoFactor: false });
  assert.equal((await notSetUp.get('/auth/me')).json.user.twoFactorSetupRequired, true);
  await assertNoPayments(notSetUp, 'client before two-step', fx.users.rep);
  await notSetUp.post('/auth/logout');
  const client = await srv.login('client');
  assert.equal((await client.get('/auth/me')).json.user.twoFactorSetupRequired, false);
  await assertNoPayments(client, 'client', fx.users.rep);
  const portal = await client.get('/client/portal');
  assert.equal(portal.status, 200);
  const text = JSON.stringify(portal.json);
  const leaked = keysOf(portal.json).filter((k) => /bank|payment|payroll|sort.?code|account.?number|last4|payee/i.test(k));
  assert.deepEqual(leaked, [], 'no payments or bank fields in the portal');
  assert.ok(!text.includes('00000031') && !text.includes('••'), 'no bank details, masked or not');
});

test('the demo client (exempt from two-step) reaches nothing of payments or bank details either', async () => {
  srv = await startTestServer({ seed: true });
  const hannah = await srv.login('client');
  assert.equal((await hannah.get('/auth/me')).json.user.twoFactorSetupRequired, false);
  await assertNoPayments(hannah, 'demo client', idOf(DEMO_ACCOUNTS.rep.employeeId));
  const portal = await hannah.get('/client/portal');
  assert.equal(portal.status, 200);
  assert.deepEqual(keysOf(portal.json).filter((k) => /bank|payment|payroll|sort.?code|account.?number|last4|payee/i.test(k)), []);
  assert.ok(!JSON.stringify(portal.json).includes('••'));
});
