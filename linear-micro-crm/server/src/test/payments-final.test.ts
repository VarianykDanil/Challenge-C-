/**
 * Release 1.4 — the last review round on paying people (findings cross:X-2..X-4, ui-docs:UI-1, UI-2, UI-4, UI-7, UI-9,
 * UI-10; TrueLayer's age guard, cross:X-1, is in payments-api.test.ts next to the adapter):
 *
 *  - Confirm pins the bank details the admin checked: changed again since → 409, the newer details stay held.
 *  - The test providers (LM_PAYMENTS_FAKE=1) never pay anyone: their connections stay in test mode, the test bank
 *    file's Mark as paid marks no run paid, and neither can be switched to live.
 *  - A bank file with a refused line: the download's audit row and the Needs-attention item give what is IN the file.
 *  - A failed payment's Needs-attention item has one full stop.
 *  - A payment whose items never reached the provider says so (queuedCount); a draft that cannot be approved says why;
 *    Cancel the rest and Mark paid by hand say plainly why they wait while Linear Hub does not know.
 *  - A network failure reads in plain words, never "fetch failed".
 * The review after that (SD-1, SD-2, money:3, the LM_PAYMENTS_FAKE start-up path): "press Check now first" only when
 * the provider can stop a payment; a test-mode payment never claims to hold the week; the test bank file says TEST
 * FILE, masks the bank details and is never in Needs attention; a server started with the variable registers
 * test-only providers.
 * Bank details are obviously fake (00-00-00 / 0000000x): the repository is public.
 */
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { PAYMENT_LIVE_CONFIRMATION, paydayForWeek } from '@lm/shared';
import { all, get, run, type Db } from '../db/connection.ts';
import { encrypt } from '../lib/crypto.ts';
import { addDays, businessNow, mondayOf } from '../lib/dates.ts';
import { createFakeProvider, type FakeProvider } from '../lib/payments/fake.ts';
import { providerFetch } from '../lib/payments/http.ts';
import { demoFakeProviders, registerPaymentProvider, unregisterPaymentProvider } from '../lib/payments/registry.ts';
import { currentCode, startTestServer, type Json, type TestClient, type TestServer } from './helpers.ts';
import { recordSandboxRun } from './moneyTestUtils.ts';

function addRun(db: Db, p: { userId: number; weekStart: string; gross: number }): number {
  return run(
    db,
    `INSERT INTO payroll_runs (user_id, week_start, week_end, days_worked, sales, team_sales, base_pay, commission, bonus, overrides, deductions, gross, due_date, paid_date, status, reference)
     VALUES (?, ?, ?, 1, 0, 0, ?, 0, 0, 0, 0, ?, ?, NULL, 'pending', ?)`,
    [p.userId, p.weekStart, addDays(p.weekStart, 6), p.gross, p.gross, paydayForWeek(p.weekStart), `PAY-Z-${p.userId}-${p.weekStart}`],
  ).lastInsertRowid;
}

function setBank(db: Db, userId: number, holder: string, account: string): void {
  // a day before now on the business clock, the clock payments compare bank details changes with (LM_BUSINESS_NOW)
  const at = new Date(businessNow().getTime() - 86_400_000).toISOString();
  run(
    db,
    `INSERT INTO bank_accounts (user_id, holder_name, sort_code_enc, account_number_enc, last4, sort_code_last2, changed_at, changed_by, confirmed_by_admin_at, confirmed_by)
     VALUES (?, ?, ?, ?, ?, '00', ?, ?, ?, NULL)
     ON CONFLICT(user_id) DO UPDATE SET holder_name = excluded.holder_name, account_number_enc = excluded.account_number_enc, last4 = excluded.last4`,
    [userId, holder, encrypt('000000'), encrypt(account), account.slice(-4), at, userId, at],
  );
}

const runStatus = (db: Db, id: number) => get<{ status: string }>(db, `SELECT status FROM payroll_runs WHERE id = ?`, [id])!.status;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let srv: TestServer;
let fx: NonNullable<TestServer['fixture']>;
let admin: TestClient;
let rep: TestClient;
let week: string;

async function setup(): Promise<void> {
  srv = await startTestServer();
  fx = srv.fixture!;
  [admin, rep] = await Promise.all((['admin', 'rep'] as const).map((r) => srv.login(r)));
  week = addDays(mondayOf(fx.today), -21);
}

async function teardown(): Promise<void> {
  for (const id of ['fake', 'fake_file']) unregisterPaymentProvider(id);
  await srv.close();
}

const code = () => currentCode(srv.db, fx.users.admin);

/** A live fake API connection (the test suite's stand-in for a real provider). */
async function liveFake(fake: FakeProvider): Promise<number> {
  registerPaymentProvider(fake);
  const made = await admin.post('/payments/connections', { provider: 'fake', name: 'Fake' });
  assert.equal(made.status, 201, JSON.stringify(made.json));
  const id = made.json.id as number;
  assert.equal((await admin.post(`/payments/connections/${id}/test`)).json.ok, true);
  recordSandboxRun(srv.db, id, fx.users.admin);
  assert.equal((await admin.patch(`/payments/connections/${id}`, { mode: 'live', confirm: PAYMENT_LIVE_CONFIRMATION })).status, 200);
  assert.equal((await admin.post(`/payments/connections/${id}/test`)).json.ok, true);
  return id;
}

describe('cross:X-2 — Confirm pins the bank details the admin checked', () => {
  beforeEach(setup);
  afterEach(teardown);

  test('changed again between the look and the press: 409, and the newer details stay held', async () => {
    const put = (account: string) => rep.put('/me/bank-details', { holderName: 'Remy Rep', sortCode: '000000', accountNumber: account, code: currentCode(srv.db, fx.users.rep) });
    assert.equal((await put('00001111')).status, 200);
    const seen = (await admin.get(`/users/${fx.users.rep}/bank-details`)).json.details;
    assert.equal(seen.last4, '1111');
    assert.equal(seen.needsConfirmation, true);
    await sleep(5);
    assert.equal((await put('00009999')).status, 200);
    // an administrator's confirmation always takes a fresh two-step code
    const stale = await admin.post(`/users/${fx.users.rep}/bank-details/confirm`, { changedAt: seen.changedAt, code: currentCode(srv.db, fx.users.admin) });
    assert.equal(stale.status, 409, JSON.stringify(stale.json));
    assert.match(stale.json.error, /changed their bank details again since you looked: check the new ones before confirming/);
    const still = (await admin.get(`/users/${fx.users.rep}/bank-details`)).json.details;
    assert.equal(still.needsConfirmation, true, 'the unchecked details are not confirmed');
    assert.equal(still.last4, '9999');
    assert.equal(all(srv.db, `SELECT 1 FROM audit_log WHERE action = 'POST /users/:id/bank-details/confirm'`).length, 0, 'nothing confirmed, nothing recorded');
    // the details on screen now: confirmed
    const ok = await admin.post(`/users/${fx.users.rep}/bank-details/confirm`, { changedAt: still.changedAt, code: currentCode(srv.db, fx.users.admin) });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.equal(ok.json.details.needsConfirmation, false);
    assert.equal(ok.json.details.last4, '9999');
  });

  test('an older client that sends no changedAt still confirms what is stored (additive API)', async () => {
    assert.equal((await rep.put('/me/bank-details', { holderName: 'Remy Rep', sortCode: '000000', accountNumber: '00002222', code: currentCode(srv.db, fx.users.rep) })).status, 200);
    // (MON-3: with the administrator's fresh code)
    const ok = await admin.post(`/users/${fx.users.rep}/bank-details/confirm`, { code: currentCode(srv.db, fx.users.admin) });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.details.needsConfirmation, false);
    const bad = await admin.post(`/users/${fx.users.rep}/bank-details/confirm`, { changedAt: 42, code: currentCode(srv.db, fx.users.admin) });
    assert.equal(bad.status, 400);
  });
});

describe('cross:X-3 — the test providers never pay anyone', () => {
  beforeEach(setup);
  afterEach(teardown);

  test('LM_PAYMENTS_FAKE=1 registers test-only providers', () => {
    const fakes = demoFakeProviders();
    assert.deepEqual(fakes.map((f) => f.info.id).sort(), ['fake', 'fake_file']);
    assert.ok(fakes.every((f) => f.info.testOnly === true));
    assert.equal(createFakeProvider().info.testOnly, undefined, 'the test suite’s fake stands in for a real provider');
  });

  test('a server started with LM_PAYMENTS_FAKE=1 really registers the test-only ones (start-up path)', () => {
    // a fresh process, as at start-up: registry.ts reads the variable once, when it is first imported
    const registry = JSON.stringify(new URL('../lib/payments/registry.ts', import.meta.url).href);
    const probe = `const r = await import(${registry}); console.log(JSON.stringify(['fake', 'fake_file'].map((id) => r.paymentProvider(id)?.info.testOnly ?? null)));`;
    const startWith = (flag: string | undefined) => {
      const env: NodeJS.ProcessEnv = { ...process.env, NODE_NO_WARNINGS: '1' };
      if (flag === undefined) delete env.LM_PAYMENTS_FAKE;
      else env.LM_PAYMENTS_FAKE = flag;
      return execFileSync(process.execPath, ['--input-type=module', '-e', probe], { env, encoding: 'utf8' }).trim().split('\n').at(-1);
    };
    assert.equal(startWith('1'), '[true,true]', 'both test providers are test-only');
    assert.equal(startWith(undefined), '[null,null]', 'without the variable there are none');
  });

  test('the test bank file starts in test mode; Mark as paid marks no run paid; neither test provider goes live', async () => {
    const [api, file] = demoFakeProviders();
    registerPaymentProvider(api!);
    registerPaymentProvider(file!);
    const made = await admin.post('/payments/connections', { provider: 'fake_file' });
    assert.equal(made.status, 201, JSON.stringify(made.json));
    assert.equal(made.json.mode, 'test');
    assert.equal(made.json.status, 'connected', 'a file needs no test');
    const live = await admin.patch(`/payments/connections/${made.json.id}`, { mode: 'live', confirm: PAYMENT_LIVE_CONFIRMATION });
    assert.equal(live.status, 400);
    assert.match(live.json.error, /The test providers never pay anyone: they have no live mode/);
    setBank(srv.db, fx.users.rep, 'Remy Rep', '00000001');
    const runId = addRun(srv.db, { userId: fx.users.rep, weekStart: week, gross: 475 });
    const draft = (await admin.post('/payments/batches', { connectionId: made.json.id, runIds: [runId] })).json;
    assert.equal(draft.mode, 'test');
    const approved = await admin.post(`/payments/batches/${draft.id}/approve`, { code: code() });
    assert.equal(approved.status, 200, JSON.stringify(approved.json));
    // review fix (money:3): nothing tells Matt to upload a test file to his bank, and the file could not be used there
    srv.resetCache();
    const attention = (await admin.get('/me/attention')).json.items as Json[];
    assert.ok(!attention.some((i) => i.key === `payments:file:${draft.id}`), JSON.stringify(attention.map((i) => i.title)));
    const download = await admin.get(`/payments/batches/${draft.id}/file`);
    assert.equal(download.status, 200);
    const body = String(download.json);
    assert.match(body, /^TEST FILE: for looking at only\. Do not upload it to a bank\.\r\n/);
    assert.ok(!body.includes('00000001'), 'no full account number in a test file');
    assert.match(body, /"Remy Rep",\*\*-\*\*-00,\*\*\*\*0001,475\.00,/);
    const marked = await admin.post(`/payments/batches/${draft.id}/mark-paid`, {});
    assert.equal(marked.status, 200, JSON.stringify(marked.json));
    assert.match(marked.json.items[0].note ?? '', /Test mode: nobody was paid/);
    assert.equal(runStatus(srv.db, runId), 'pending', 'the week stays on Runs to pay');
    // the test API provider: its test works, live is refused
    const conn = await admin.post('/payments/connections', { provider: 'fake' });
    assert.equal((await admin.post(`/payments/connections/${conn.json.id}/test`)).json.ok, true);
    const apiLive = await admin.patch(`/payments/connections/${conn.json.id}`, { mode: 'live', confirm: PAYMENT_LIVE_CONFIRMATION });
    assert.equal(apiLive.status, 400);
    const listed = (await admin.get('/payments/providers')).json as Json[];
    assert.equal(listed.find((p) => p.id === 'fake_file').testOnly, true, 'the screens know (no Switch to live)');
  });
});

describe('cross:X-4, UI-1, UI-4 — a bank file with a refused line', () => {
  beforeEach(setup);
  afterEach(teardown);

  test('the download’s audit row, the Needs-attention item and the failed item all give what is in the file', async () => {
    setBank(srv.db, fx.users.rep, 'Remy Rep', '00000001');
    setBank(srv.db, fx.users.repA2, 'Rita', '00000002'); // Revolut needs a first and last name: refused
    const made = await admin.post('/payments/connections', { provider: 'bank_file', settings: { format: 'revolut' } });
    assert.equal((await admin.patch(`/payments/connections/${made.json.id}`, { mode: 'live', confirm: PAYMENT_LIVE_CONFIRMATION })).status, 200);
    const runA = addRun(srv.db, { userId: fx.users.rep, weekStart: week, gross: 945.5 });
    const runB = addRun(srv.db, { userId: fx.users.repA2, weekStart: week, gross: 63.5 });
    const draft = (await admin.post('/payments/batches', { connectionId: made.json.id, runIds: [runA, runB] })).json;
    const approved = await admin.post(`/payments/batches/${draft.id}/approve`, { code: code() });
    assert.equal(approved.status, 200, JSON.stringify(approved.json));
    assert.equal(approved.json.totalPence, 100_900, 'the approved total is unchanged');
    assert.equal((await admin.get(`/payments/batches/${draft.id}/file`)).status, 200);
    const row = get<{ summary: string; after: string }>(srv.db, `SELECT summary, after_json AS after FROM audit_log WHERE action = 'GET /payments/batches/:id/file'`)!;
    assert.match(row.summary, /Downloaded the bank file for payment #\d+: 1 person, £945\.50$/);
    assert.deepEqual({ count: JSON.parse(row.after).count, totalPence: JSON.parse(row.after).totalPence }, { count: 1, totalPence: 94_550 });
    srv.resetCache();
    const items = (await admin.get('/me/attention')).json.items as Json[];
    const file = items.find((i) => i.key === `payments:file:${draft.id}`);
    assert.ok(file, JSON.stringify(items.map((i) => i.key)));
    assert.match(file.body, /\(1 person, £945\.50\)/);
    const failed = items.find((i) => i.kind === 'payments' && /A payment to Rita Rep failed/.test(i.title));
    assert.ok(failed, JSON.stringify(items.map((i) => i.title)));
    assert.match(failed.body, /pay this week again\. Their week stays on Runs to pay\.$/);
    assert.ok(!failed.body.includes('..'), failed.body);
  });
});

describe('UI-2, UI-7, UI-9 — saying plainly what is waiting and why', () => {
  beforeEach(setup);
  afterEach(teardown);

  test('nothing reached the provider: queuedCount says so; Cancel and Mark paid by hand say why they wait', async () => {
    const id = await liveFake(createFakeProvider({ throwSubmit: 1 }));
    setBank(srv.db, fx.users.rep, 'Remy Rep', '00000001');
    const runId = addRun(srv.db, { userId: fx.users.rep, weekStart: week, gross: 300 });
    const draft = (await admin.post('/payments/batches', { connectionId: id, runIds: [runId] })).json;
    assert.equal(draft.queuedCount, 1, 'a draft’s items are all waiting to send too');
    const approved = await admin.post(`/payments/batches/${draft.id}/approve`, { code: code() });
    assert.equal(approved.json.items[0].status, 'queued');
    assert.equal(approved.json.queuedCount, 1);
    const listed = ((await admin.get('/payments/batches')).json as Json[]).find((b) => b.id === draft.id);
    assert.equal(listed.queuedCount, 1);
    assert.equal(listed.status, 'submitted');
    // Linear Hub does not know whether the provider made it: Cancel waits, and says why (this fake cannot stop a
    // payment, like Revolut and TrueLayer: Check now never brings Cancel back, so it is not offered — review fix SD-1)
    assert.equal(approved.json.actions.cancel, false);
    assert.match(approved.json.actions.cancelBlocked ?? '', /^Linear Hub is still finding out whether Fake made it\. Payments sent to Fake cannot be stopped from Linear Hub\. If Fake cannot be reached, the week stays held until Fake answers\.$/);
    assert.doesNotMatch(approved.json.actions.cancelBlocked, /press Check now/);
    assert.equal(approved.json.actions.cancelWaits ?? false, false, 'no greyed Cancel the rest: it never comes back');
    const cancel = await admin.post(`/payments/batches/${draft.id}/cancel`);
    assert.equal(cancel.status, 409);
    assert.match(cancel.json.error, /Payments sent to Fake cannot be stopped from Linear Hub\. If Fake cannot be reached, the week stays held until Fake answers\.$/);
    assert.doesNotMatch(cancel.json.error, /then cancel/);
    const byHand = await admin.post(`/finance/payroll/${runId}/pay`, {});
    assert.equal(byHand.status, 409);
    assert.match(byHand.json.error, /Wait until Linear Hub hears back from Fake \(Check now on the payment\) before marking the week paid by hand/);
    assert.doesNotMatch(byHand.json.error, /or cancel it/);
    // once it answers: sent, nothing blocked
    const checked = await admin.post(`/payments/batches/${draft.id}/refresh`);
    assert.equal(checked.json.queuedCount, 0);
    assert.equal(checked.json.actions.cancelBlocked ?? null, null);
  });

  test('SD-1: a provider that can stop payments (Wise): Cancel waits greyed out, “press Check now first”, and comes back after', async () => {
    const fake = createFakeProvider({ throwSubmit: 1, cancellable: true, refreshStatus: 'processing' });
    const id = await liveFake(fake);
    setBank(srv.db, fx.users.rep, 'Remy Rep', '00000001');
    const runId = addRun(srv.db, { userId: fx.users.rep, weekStart: week, gross: 300 });
    const draft = (await admin.post('/payments/batches', { connectionId: id, runIds: [runId] })).json;
    const approved = (await admin.post(`/payments/batches/${draft.id}/approve`, { code: code() })).json;
    assert.equal(approved.actions.cancel, false);
    assert.equal(approved.actions.cancelWaits, true, 'shown greyed out: it comes back once Linear Hub knows');
    assert.match(approved.actions.cancelBlocked, /^Linear Hub is still finding out whether Fake made it: press Check now first\. If Fake cannot be reached, the week stays held until Fake answers\.$/);
    const cancel = await admin.post(`/payments/batches/${draft.id}/cancel`);
    assert.equal(cancel.status, 409);
    assert.match(cancel.json.error, /: press Check now, then cancel\. If Fake cannot be reached, the week stays held until Fake answers\.$/);
    const checked = (await admin.post(`/payments/batches/${draft.id}/refresh`)).json;
    assert.equal(checked.items[0].status, 'processing');
    assert.equal(checked.actions.cancel, true, 'Cancel the rest is back');
    assert.equal(checked.actions.cancelBlocked ?? null, null);
    assert.equal(checked.actions.cancelWaits ?? false, false);
  });

  test('SD-2: a test-mode payment never claims to hold the week (it does not)', async () => {
    registerPaymentProvider(createFakeProvider({ throwSubmit: 1 }));
    const made = await admin.post('/payments/connections', { provider: 'fake', name: 'Fake' });
    const id = made.json.id as number;
    assert.equal((await admin.post(`/payments/connections/${id}/test`)).json.ok, true);
    setBank(srv.db, fx.users.rep, 'Remy Rep', '00000001');
    const runId = addRun(srv.db, { userId: fx.users.rep, weekStart: week, gross: 300 });
    const draft = (await admin.post('/payments/batches', { connectionId: id, runIds: [runId] })).json;
    assert.equal(draft.mode, 'test');
    const approved = (await admin.post(`/payments/batches/${draft.id}/approve`, { code: code() })).json;
    assert.equal(approved.items[0].status, 'queued');
    assert.match(approved.actions.cancelBlocked, /Test mode: nobody is paid, so the week is not held\.$/);
    assert.doesNotMatch(approved.actions.cancelBlocked, /stays held/);
    const cancel = await admin.post(`/payments/batches/${draft.id}/cancel`);
    assert.equal(cancel.status, 409);
    assert.match(cancel.json.error, /Test mode: nobody is paid, so the week is not held\.$/);
    assert.doesNotMatch(cancel.json.error, /stays held/);
    // and it is not: the week can be marked paid by hand straight away
    assert.equal((await admin.post(`/finance/payroll/${runId}/pay`, {})).status, 200);
  });

  test('a draft that cannot be approved says why: made in test mode but the connection is live now; or not tested', async () => {
    const fake = createFakeProvider();
    registerPaymentProvider(fake);
    const made = await admin.post('/payments/connections', { provider: 'fake', name: 'Fake' });
    const id = made.json.id as number;
    assert.equal((await admin.post(`/payments/connections/${id}/test`)).json.ok, true);
    setBank(srv.db, fx.users.rep, 'Remy Rep', '00000001');
    const runId = addRun(srv.db, { userId: fx.users.rep, weekStart: week, gross: 120 });
    const draft = (await admin.post('/payments/batches', { connectionId: id, runIds: [runId] })).json;
    assert.equal(draft.actions.approve, true);
    assert.equal(draft.actions.approveBlocked ?? null, null);
    recordSandboxRun(srv.db, id, fx.users.admin);
    assert.equal((await admin.patch(`/payments/connections/${id}`, { mode: 'live', confirm: PAYMENT_LIVE_CONFIRMATION })).status, 200);
    assert.equal((await admin.post(`/payments/connections/${id}/test`)).json.ok, true);
    const blocked = (await admin.get(`/payments/batches/${draft.id}`)).json;
    assert.equal(blocked.actions.approve, false);
    assert.match(blocked.actions.approveBlocked, /made in test mode, but the connection is now live: cancel it and make a new payment/);
    const refused = await admin.post(`/payments/batches/${draft.id}/approve`, { code: code() });
    assert.equal(refused.status, 409);
    assert.match(refused.json.error, /made in test mode, but the connection is now live: cancel it and make a new payment/);
    // a new draft in live mode, then the connection's details change: it needs a new test first
    const second = addRun(srv.db, { userId: fx.users.rep, weekStart: addDays(week, -7), gross: 80 });
    const d2 = (await admin.post('/payments/batches', { connectionId: id, runIds: [second] })).json;
    assert.equal((await admin.patch(`/payments/connections/${id}`, { settings: { label: 'changed' } })).status, 200);
    const untested = (await admin.get(`/payments/batches/${d2.id}`)).json;
    assert.equal(untested.actions.approve, false);
    assert.match(untested.actions.approveBlocked, /Test the Fake connection in Settings → Payments first/);
  });
});

describe('UI-10 — a network failure in plain words', () => {
  test('“fetch failed” (and its codes) become plain words; nothing claims it was not sent', async () => {
    const offline: typeof fetch = async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('getaddrinfo ENOTFOUND api.wise.com'), { code: 'ENOTFOUND' }) });
    };
    await assert.rejects(providerFetch('http://127.0.0.1:1/x', { method: 'GET' }, { provider: 'Wise', fetchImpl: offline }), (e: Error) => {
      assert.equal(e.message, 'Linear Hub could not reach Wise: check this computer’s internet connection, or Wise may be down.');
      return true;
    });
    const reset: typeof fetch = async () => {
      throw Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    };
    await assert.rejects(providerFetch('http://127.0.0.1:1/pay', { method: 'POST' }, { provider: 'Revolut', fetchImpl: reset }), (e: Error) => {
      assert.match(e.message, /^Linear Hub could not reach Revolut: check this computer’s internet connection/);
      assert.doesNotMatch(e.message, /fetch failed|Nothing was sent/);
      return true;
    });
  });
});
