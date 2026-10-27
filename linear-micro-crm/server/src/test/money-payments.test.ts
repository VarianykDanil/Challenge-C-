/**
 * The money package's payment fixes, end to end with the real bank file and the fake API provider:
 *  - CLM-3 / MONEY-MISSED-1: a bank file connection starts in TEST mode — test files say TEST (file name and every
 *    payment reference) and never mark a week paid; going live needs PAY FOR REAL typed.
 *  - MON-6 / CLM-2: "Make a 1p test file" (one payment of £0.01 to an account the owner chooses) and its result.
 *  - MON-2: a downloaded bank file counts as sent. Freeing its weeks (Cancel the rest, or Mark as paid with some not
 *    paid) needs the typed confirmation and a fresh code; the file is void in the audit trail and on screen; a second
 *    file for the same person-weeks within 7 days is refused unless that confirmation was given.
 *  - MONEY-MISSED-2: "Two people approve each payment"; the approval screen lists bonuses and adjustments added in
 *    the last 7 days and who added them.
 *  - MONEY-MISSED-3: pay resting on subs no client statement confirmed, per person and in total.
 *  - MON-5 / CLM-1: an API connection goes live only after a sandbox payment got an answer.
 * Every route for every role. Bank details are obviously fake (00-00-00 / 0000000x): the repository is public.
 */
import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { PAYMENT_LIVE_CONFIRMATION, paydayForWeek } from '@lm/shared';
import { all, get, run, type Db } from '../db/connection.ts';
import { createSchema } from '../db/schema.ts';
import { encrypt } from '../lib/crypto.ts';
import { addDays, businessNow, mondayOf } from '../lib/dates.ts';
import { createFakeProvider, type FakeProvider } from '../lib/payments/fake.ts';
import { registerPaymentProvider, unregisterPaymentProvider } from '../lib/payments/registry.ts';
import { addHistory, currentCode, startTestServer, type Json, type TestClient, type TestServer } from './helpers.ts';
import { recordSandboxRun } from './moneyTestUtils.ts';

let srv: TestServer;
let fx: NonNullable<TestServer['fixture']>;
let admin: TestClient;
let admin2: TestClient;
let admin2Id: number;
let leader: TestClient;
let rep: TestClient;
let client: TestClient;
let week: string;
let fake: FakeProvider;

function addRun(db: Db, userId: number, weekStart: string, gross: number): number {
  return run(
    db,
    `INSERT INTO payroll_runs (user_id, week_start, week_end, days_worked, sales, team_sales, base_pay, commission, bonus, overrides, deductions, gross, due_date, paid_date, status, reference)
     VALUES (?, ?, ?, 1, 0, 0, ?, 0, 0, 0, 0, ?, ?, NULL, 'pending', ?)`,
    [userId, weekStart, addDays(weekStart, 6), gross, gross, paydayForWeek(weekStart), `PAY-M-${userId}-${weekStart}`],
  ).lastInsertRowid;
}

function setBank(db: Db, userId: number, holder: string, account: string): void {
  const at = new Date(businessNow().getTime() - 86_400_000).toISOString();
  run(
    db,
    `INSERT INTO bank_accounts (user_id, holder_name, sort_code_enc, account_number_enc, last4, sort_code_last2, changed_at, changed_by, confirmed_by_admin_at, confirmed_by)
     VALUES (?, ?, ?, ?, ?, '00', ?, ?, ?, ?)`,
    [userId, holder, encrypt('000000'), encrypt(account), account.slice(-4), at, userId, at, fx.users.admin],
  );
}

const code = (userId?: number) => currentCode(srv.db, userId ?? fx.users.admin);
const runStatus = (id: number) => get<{ status: string }>(srv.db, `SELECT status FROM payroll_runs WHERE id = ?`, [id])!.status;

async function setup(opts: { secondAdmin?: boolean } = {}): Promise<void> {
  srv = await startTestServer();
  fx = srv.fixture!;
  if (opts.secondAdmin) {
    admin2Id = run(
      srv.db,
      `INSERT INTO users (employee_id, email, first_name, last_name, role, position, team_id, pay_plan_id, start_date, status, phone, avatar_color, city)
       VALUES ('FX-0009', 'abe.admin@fixture.test', 'Abe', 'Admin', 'admin', 'assistant_owner', NULL, ?, ?, 'active', NULL, '#4F46E5', 'Manchester')`,
      [fx.plans.owner, addDays(fx.today, -365)],
    ).lastInsertRowid;
  }
  [admin, leader, rep, client] = await Promise.all((['admin', 'leader', 'rep', 'client'] as const).map((r) => srv.login(r)));
  if (opts.secondAdmin) admin2 = await srv.login({ email: 'abe.admin@fixture.test', employeeId: 'FX-0009' });
  week = addDays(mondayOf(fx.today), -21);
  setBank(srv.db, fx.users.rep, 'Remy Rep', '00000001');
  setBank(srv.db, fx.users.repA2, 'Rita Rep', '00000002');
  fake = createFakeProvider();
  registerPaymentProvider(fake);
}

async function teardown(): Promise<void> {
  unregisterPaymentProvider('fake');
  await srv.close();
}

async function fileConnection(live: boolean): Promise<number> {
  const made = await admin.post('/payments/connections', { provider: 'bank_file', settings: { format: 'starling' } });
  assert.equal(made.status, 201, JSON.stringify(made.json));
  if (live) assert.equal((await admin.patch(`/payments/connections/${made.json.id}`, { mode: 'live', confirm: PAYMENT_LIVE_CONFIRMATION })).status, 200);
  return made.json.id as number;
}

async function approvedFile(conn: number, runIds: number[]): Promise<Json> {
  const draft = await admin.post('/payments/batches', { connectionId: conn, runIds });
  assert.equal(draft.status, 201, JSON.stringify(draft.json));
  const sent = await admin.post(`/payments/batches/${draft.json.id}/approve`, { code: code() });
  assert.equal(sent.status, 200, JSON.stringify(sent.json));
  return sent.json;
}

// ───────────────────────────── CLM-3: bank files start in test mode ─────────────────────────────

describe('CLM-3: a bank file connection starts in test mode', () => {
  beforeEach(() => setup());
  afterEach(teardown);

  test('test files say TEST, pay nobody and mark no week paid; live needs PAY FOR REAL', async () => {
    const made = await admin.post('/payments/connections', { provider: 'bank_file', settings: { format: 'starling' } });
    assert.equal(made.status, 201);
    assert.equal(made.json.mode, 'test', 'every connection starts in test mode');
    assert.equal(made.json.status, 'connected', 'a file needs no connection test');
    const runA = addRun(srv.db, fx.users.rep, week, 120.5);
    const sent = await approvedFile(made.json.id, [runA]);
    assert.equal(sent.mode, 'test');
    assert.match(sent.fileName, /^TEST-linear-hub-payment-/);
    assert.match(sent.items[0].providerRef, /^TEST /);
    const file = await admin.get(`/payments/batches/${sent.id}/file`);
    assert.equal(file.status, 200);
    assert.match(String(file.json), /TEST /);
    const marked = await admin.post(`/payments/batches/${sent.id}/mark-paid`, {});
    assert.equal(marked.status, 200);
    assert.equal(runStatus(runA), 'pending', 'a test file marks no week paid');
    // going live: the typed words, exactly
    assert.equal((await admin.patch(`/payments/connections/${made.json.id}`, { mode: 'live' })).status, 400);
    assert.equal((await admin.patch(`/payments/connections/${made.json.id}`, { mode: 'live', confirm: 'pay for real' })).status, 400);
    const live = await admin.patch(`/payments/connections/${made.json.id}`, { mode: 'live', confirm: PAYMENT_LIVE_CONFIRMATION });
    assert.equal(live.status, 200, JSON.stringify(live.json));
    assert.equal(live.json.mode, 'live');
    assert.equal(live.json.status, 'connected');
    assert.ok(live.json.liveConfirmedAt);
    const providers = (await admin.get('/payments/providers')).json as Json[];
    assert.equal(providers.find((p) => p.id === 'bank_file').abilities.testMode, true);
  });

  test('upgrading: a 1.4.0 bank file connection that was live stays live', async () => {
    const id = run(srv.db, `INSERT INTO payment_connections (provider, name, mode, settings_json, status, created_at) VALUES ('bank_file', 'Old file', 'live', '{"format":"generic"}', 'connected', ?)`, [new Date().toISOString()]).lastInsertRowid;
    createSchema(srv.db);
    assert.equal(get<{ mode: string }>(srv.db, `SELECT mode FROM payment_connections WHERE id = ?`, [id])!.mode, 'live');
  });
});

// ───────────────────────────── MON-6: the 1p test file ─────────────────────────────

describe('MON-6: Make a 1p test file', () => {
  beforeEach(() => setup());
  afterEach(teardown);

  test('one payment of £0.01 to the account the owner chooses, in the connection\'s layout; then its result', async () => {
    const conn = await fileConnection(false);
    const body = { holderName: 'Ada Admin', sortCode: '00-00-00', accountNumber: '00000099' };
    assert.equal((await admin.post(`/payments/connections/${conn}/test-file`, body)).status, 400, 'a fresh code is needed');
    const r = await admin.post(`/payments/connections/${conn}/test-file`, { ...body, code: code() });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.match(r.json.fileName, /1p-test/);
    const lines = String(r.json.body).trim().split('\r\n');
    assert.equal(lines.length, 2, 'the header and one payment');
    assert.equal(lines[0], 'Payee Sort Code,Payee Account Number,Payee Name,Payment Reference,Amount');
    assert.equal(lines[1], '000000,00000099,Ada Admin,LINEAR 1P TEST,0.01');
    const audit = all<{ summary: string; a: string | null }>(srv.db, `SELECT summary, after_json AS a FROM audit_log WHERE action = 'POST /payments/connections/:id/test-file'`);
    assert.equal(audit.length, 1);
    assert.match(audit[0]!.summary, /1p test file/);
    assert.ok(!JSON.stringify(audit).includes('00000099'), 'never the account number');
    const conns = (await admin.get('/payments/connections')).json as Json[];
    assert.ok(conns.find((c) => c.id === conn).testFileAt);
    const res = await admin.post(`/payments/connections/${conn}/test-file-result`, { result: 'accepted' });
    assert.equal(res.status, 200);
    assert.equal(res.json.testFileResult, 'accepted');
    assert.equal((await admin.post(`/payments/connections/${conn}/test-file-result`, { result: 'maybe' })).status, 400);
    // only for bank files, and only administrators
    const api = (await admin.post('/payments/connections', { provider: 'fake' })).json.id;
    assert.equal((await admin.post(`/payments/connections/${api}/test-file`, { ...body, code: code() })).status, 409);
    for (const who of [leader, rep, client]) assert.equal((await who.post(`/payments/connections/${conn}/test-file`, body)).status, 403);
    assert.equal((await srv.anon().post(`/payments/connections/${conn}/test-file`, body)).status, 401);
  });
});

// ───────────────────────────── MON-2: a downloaded file counts as sent ─────────────────────────────

describe('MON-2: once a bank file has been downloaded, its weeks count as sent', () => {
  beforeEach(() => setup());
  afterEach(teardown);

  test('the review probe: Cancel the rest after a download needs NOT UPLOADED and a fresh code; the file is void', async () => {
    const conn = await fileConnection(true);
    const runA = addRun(srv.db, fx.users.rep, week, 120.5);
    const runB = addRun(srv.db, fx.users.repA2, week, 80);
    const sent = await approvedFile(conn, [runA, runB]);
    // before a download, cancelling needs nothing more (the file never left Linear Hub) — shown as such
    assert.equal(sent.downloadedAt, null);
    assert.equal((await admin.get(`/payments/batches/${sent.id}/file`)).status, 200);
    const after = (await admin.get(`/payments/batches/${sent.id}`)).json;
    assert.ok(after.downloadedAt, 'the download is recorded');
    assert.equal(after.downloadedByName, 'Ada Admin');
    assert.equal(after.actions.cancelNeedsConfirmation, true);
    const plain = await admin.post(`/payments/batches/${sent.id}/cancel`, {});
    assert.equal(plain.status, 400, JSON.stringify(plain.json));
    assert.match(plain.json.error, /NOT UPLOADED/);
    const wrong = await admin.post(`/payments/batches/${sent.id}/cancel`, { confirm: 'NOT PAID', code: code() });
    assert.equal(wrong.status, 400);
    const noCode = await admin.post(`/payments/batches/${sent.id}/cancel`, { confirm: 'NOT UPLOADED' });
    assert.equal(noCode.status, 400);
    const ok = await admin.post(`/payments/batches/${sent.id}/cancel`, { confirm: 'NOT UPLOADED', code: code() });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.ok(ok.json.voidedAt);
    assert.equal(ok.json.voidedByName, 'Ada Admin');
    assert.match(ok.json.voidReason, /not uploaded/i);
    assert.equal(ok.json.actions.download, false, 'a void file cannot be downloaded again');
    const audit = all<{ summary: string }>(srv.db, `SELECT summary FROM audit_log WHERE action = 'POST /payments/batches/:id/cancel'`);
    assert.match(audit.at(-1)!.summary, /void.*not uploaded/i);
    // with the confirmation given, the weeks can go in a new file
    const again = await admin.post('/payments/batches', { connectionId: conn, runIds: [runA, runB] });
    assert.equal(again.status, 201, JSON.stringify(again.json));
    assert.equal(again.json.count, 2);
  });

  test('a second file for the same person-weeks within 7 days is refused when the first was freed without the confirmation', async () => {
    const conn = await fileConnection(true);
    const runA = addRun(srv.db, fx.users.rep, week, 120.5);
    const sent = await approvedFile(conn, [runA]);
    await admin.get(`/payments/batches/${sent.id}/file`);
    // a 1.4.0 database: the file was cancelled after its download, with no confirmation
    run(srv.db, `UPDATE payment_items SET status = 'cancelled' WHERE batch_id = ?`, [sent.id]);
    run(srv.db, `UPDATE payment_batches SET status = 'cancelled', cancelled_at = ? WHERE id = ?`, [new Date().toISOString(), sent.id]);
    const blocked = await admin.post('/payments/batches', { connectionId: conn, runIds: [runA] });
    assert.equal(blocked.status, 400, JSON.stringify(blocked.json));
    const skip = blocked.json.details.skipped[0];
    assert.equal(skip.code, 'recent_file');
    assert.match(skip.reason, new RegExp(`payment #${sent.id}`));
    // confirming now that it was not uploaded frees it
    const voided = await admin.post(`/payments/batches/${sent.id}/cancel`, { confirm: 'NOT UPLOADED', code: code() });
    assert.equal(voided.status, 200, JSON.stringify(voided.json));
    assert.ok(voided.json.voidedAt);
    assert.equal((await admin.post('/payments/batches', { connectionId: conn, runIds: [runA] })).status, 201);
  });

  test('Mark as paid with some not paid, after a download, needs NOT PAID and a fresh code', async () => {
    const conn = await fileConnection(true);
    const runA = addRun(srv.db, fx.users.rep, week, 120.5);
    const runB = addRun(srv.db, fx.users.repA2, week, 80);
    const sent = await approvedFile(conn, [runA, runB]);
    await admin.get(`/payments/batches/${sent.id}/file`);
    const [a, b] = sent.items as Json[];
    const plain = await admin.post(`/payments/batches/${sent.id}/mark-paid`, { paid: [a.id], failed: [b.id], reason: 'Rejected' });
    assert.equal(plain.status, 400);
    assert.match(plain.json.error, /NOT PAID/);
    const ok = await admin.post(`/payments/batches/${sent.id}/mark-paid`, { paid: [a.id], failed: [b.id], reason: 'Rejected', confirm: 'NOT PAID', code: code() });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    // all paid needs nothing more
    assert.equal(runStatus(b.payrollRunId), 'failed');
    assert.equal((await admin.post('/payments/batches', { connectionId: conn, runIds: [runB] })).status, 201, 'confirmed: payable again');
  });

  test('upgrading: a 1.4.0 download in the audit trail counts as the download', async () => {
    const conn = await fileConnection(true);
    const runA = addRun(srv.db, fx.users.rep, week, 120.5);
    const sent = await approvedFile(conn, [runA]);
    run(srv.db, `INSERT INTO audit_log (at, user_id, action, entity, entity_id, summary, kind) VALUES (?, ?, 'GET /payments/batches/:id/file', 'payment_batch', ?, 'Downloaded the bank file', 'export')`, [new Date().toISOString(), fx.users.admin, sent.id]);
    run(srv.db, `UPDATE payment_batches SET downloaded_at = NULL, downloaded_by = NULL WHERE id = ?`, [sent.id]);
    run(srv.db, `DELETE FROM meta WHERE key = 'ext:payments:downloads'`);
    createSchema(srv.db);
    assert.ok(get<{ d: string | null }>(srv.db, `SELECT downloaded_at AS d FROM payment_batches WHERE id = ?`, [sent.id])!.d);
  });
});

// ───────────────────────────── MONEY-MISSED-2: two people approve ─────────────────────────────

describe('MONEY-MISSED-2: Two people approve each payment', () => {
  beforeEach(() => setup({ secondAdmin: true }));
  afterEach(teardown);

  async function liveFake(): Promise<number> {
    const id = (await admin.post('/payments/connections', { provider: 'fake' })).json.id as number;
    assert.equal((await admin.post(`/payments/connections/${id}/test`)).json.ok, true);
    recordSandboxRun(srv.db, id, fx.users.admin);
    assert.equal((await admin.patch(`/payments/connections/${id}`, { mode: 'live', confirm: PAYMENT_LIVE_CONFIRMATION })).status, 200);
    assert.equal((await admin.post(`/payments/connections/${id}/test`)).json.ok, true);
    return id;
  }

  test('on by default with two administrators who use two-step; the second approval must be someone else\'s', async () => {
    const s = await admin.get('/payments/settings');
    assert.equal(s.status, 200, JSON.stringify(s.json));
    assert.equal(s.json.twoApprovals, true);
    assert.equal(s.json.explicit, false);
    assert.equal(s.json.adminsWithTwoStep, 2);
    const conn = await liveFake();
    const runA = addRun(srv.db, fx.users.rep, week, 120.5);
    const draft = (await admin.post('/payments/batches', { connectionId: conn, runIds: [runA] })).json;
    assert.equal(draft.approvalsNeeded, 2);
    const first = await admin.post(`/payments/batches/${draft.id}/approve`, { code: code() });
    assert.equal(first.status, 200, JSON.stringify(first.json));
    assert.equal(first.json.status, 'draft', 'not sent yet');
    assert.equal(first.json.firstApprovedByName, 'Ada Admin');
    assert.equal(fake.calls.submit, 0, 'nothing sent on the first approval');
    const twice = await admin.post(`/payments/batches/${draft.id}/approve`, { code: code() });
    assert.equal(twice.status, 409);
    assert.match(twice.json.error, /different administrator/);
    const second = await admin2.post(`/payments/batches/${draft.id}/approve`, { code: code(admin2Id) });
    assert.equal(second.status, 200, JSON.stringify(second.json));
    assert.notEqual(second.json.status, 'draft');
    assert.equal(second.json.approvedByName, 'Abe Admin');
    assert.equal(fake.calls.submit, 1);
    const audit = all<{ summary: string }>(srv.db, `SELECT summary FROM audit_log WHERE action = 'POST /payments/batches/:id/approve' ORDER BY id`);
    assert.match(audit[0]!.summary, /First approval/);
    assert.match(audit[1]!.summary, /Approved payment/);
  });

  test('test mode needs one approval; turning the setting off needs a fresh code and is recorded', async () => {
    const id = (await admin.post('/payments/connections', { provider: 'fake' })).json.id as number;
    await admin.post(`/payments/connections/${id}/test`);
    const runA = addRun(srv.db, fx.users.rep, week, 120.5);
    const d = (await admin.post('/payments/batches', { connectionId: id, runIds: [runA] })).json;
    assert.equal(d.approvalsNeeded, 1, 'test mode pays nobody');
    assert.equal((await admin.put('/payments/settings', { twoApprovals: false })).status, 400, 'a fresh code is needed');
    const off = await admin.put('/payments/settings', { twoApprovals: false, code: code() });
    assert.equal(off.status, 200, JSON.stringify(off.json));
    assert.equal(off.json.twoApprovals, false);
    assert.equal(off.json.explicit, true);
    assert.ok(all(srv.db, `SELECT 1 FROM audit_log WHERE action = 'PUT /payments/settings' AND summary LIKE '%off%'`).length === 1);
    for (const who of [leader, rep, client]) assert.equal((await who.get('/payments/settings')).status, 403);
  });

  test('the approval screen lists bonuses and adjustments added in the last 7 days and who added them', async () => {
    const conn = await liveFake();
    const runA = addRun(srv.db, fx.users.rep, week, 120.5);
    const bonus = await admin.post('/pay/bonuses', { userId: fx.users.rep, weekStart: week, amount: 50, note: 'Top seller' });
    assert.equal(bonus.status, 201, JSON.stringify(bonus.json));
    const draft = (await admin.post('/payments/batches', { connectionId: conn, runIds: [runA] })).json;
    assert.equal(draft.recentChanges.length, 1, JSON.stringify(draft.recentChanges));
    const c = draft.recentChanges[0];
    assert.equal(c.kind, 'bonus');
    assert.equal(c.amount, 50);
    assert.equal(c.createdByName, 'Ada Admin');
    assert.equal(c.createdBy, fx.users.admin);
    assert.equal(c.userName, 'Remy Rep');
  });
});

// ───────────────────────────── MONEY-MISSED-3: pay resting on unconfirmed subs ─────────────────────────────

describe('MONEY-MISSED-3: commission resting on subs no client statement confirmed', () => {
  beforeEach(() => setup());
  afterEach(teardown);

  test('flagged per person on the payment and on Runs to pay, with totals', async () => {
    // Remy sold a lot on the fixture campaign, whose client sends no statements: nothing will ever confirm those subs.
    // The weeks are paid on the base-or-commission rule (it started before them).
    run(srv.db, `INSERT OR REPLACE INTO meta (key, value) VALUES ('ext:pay:rule_from', ?), ('ext:pay:day_rate', '63.5')`, [addDays(mondayOf(fx.today), -35)]);
    addHistory(srv.db, { userId: fx.users.rep, teamId: fx.teams.a, campaignId: fx.campaignId, weeks: 2, stops: 40, sales: 4 });
    srv.resetCache();
    const runs = (await admin.get('/finance/payroll?status=pending')).json as Json[];
    const r = runs.find((x) => x.userId === fx.users.rep);
    assert.ok(r, 'a run');
    assert.ok(r.checks?.unconfirmed?.amount > 0, JSON.stringify(r.checks));
    assert.deepEqual(r.checks.unconfirmed.neverConfirmed, ['FXC']);
    const conn = await fileConnection(false);
    const draft = (await admin.post('/payments/batches', { connectionId: conn, runIds: runs.filter((x) => x.userId === fx.users.rep).map((x) => x.id) })).json;
    const item = (draft.items as Json[])[0];
    assert.ok(item.checks?.unconfirmed?.amount > 0);
    assert.ok(draft.unconfirmedPence > 0);
    assert.equal(draft.unconfirmedPence, (draft.items as Json[]).reduce((s, i) => s + Math.round((i.checks?.unconfirmed?.amount ?? 0) * 100), 0));
  });
});

// ───────────────────────────── MON-5: a sandbox payment before live ─────────────────────────────

describe('MON-5: an API connection goes live only after a sandbox payment got an answer', () => {
  beforeEach(() => setup());
  afterEach(teardown);

  test('a connection test is not enough; a test-mode payment answered by the sandbox is', async () => {
    const id = (await admin.post('/payments/connections', { provider: 'fake' })).json.id as number;
    assert.equal((await admin.post(`/payments/connections/${id}/test`)).json.ok, true);
    const early = await admin.patch(`/payments/connections/${id}`, { mode: 'live', confirm: PAYMENT_LIVE_CONFIRMATION });
    assert.equal(early.status, 409, JSON.stringify(early.json));
    assert.match(early.json.error, /test payment/);
    let conn = ((await admin.get('/payments/connections')).json as Json[]).find((c) => c.id === id);
    assert.equal(conn.firstRun.sandboxPaymentAt, null);
    // the sandbox run: one person, test mode, and the sandbox answers it (a payment still on its way blocks the switch)
    fake.script({ submitStatus: 'paid' });
    const runA = addRun(srv.db, fx.users.rep, week, 1.5);
    const d = (await admin.post('/payments/batches', { connectionId: id, runIds: [runA] })).json;
    assert.equal((await admin.post(`/payments/batches/${d.id}/approve`, { code: code() })).status, 200);
    conn = ((await admin.get('/payments/connections')).json as Json[]).find((c) => c.id === id);
    assert.ok(conn.firstRun.sandboxPaymentAt);
    assert.equal(conn.firstRun.livePaymentAt, null);
    const live = await admin.patch(`/payments/connections/${id}`, { mode: 'live', confirm: PAYMENT_LIVE_CONFIRMATION });
    assert.equal(live.status, 200, JSON.stringify(live.json));
  });
});
