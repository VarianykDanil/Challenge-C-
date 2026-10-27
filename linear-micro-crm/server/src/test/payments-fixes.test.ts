/**
 * Release 1.4 — review fixes for paying people from Linear Hub (packages F, P and A), each reproduced first:
 *  - PM-1: a payment never goes to the other environment when its connection changes mode (test → live, live → test);
 *    the switch waits while a payment through the connection is on its way;
 *  - PM-2: a payment resent after a timeout goes to the account it was approved with, with the same key, even when the
 *    person changed their bank details meanwhile; the run is never freed to be paid twice;
 *  - PM-3: a run's figures stay as approved while its payment is on its way (flagged when they would change; the
 *    difference is for a later week), and are brought up to date when the payment fails;
 *  - PM-4: Wise "Cancel the rest" is refused while Linear Hub does not know whether a transfer exists, and works once
 *    Check now has found it;
 *  - PAYUI-1: a connection's balance and last test belong to the mode and keys they were made with;
 *  - PAYUI-8: a bank file's items carry the paid date chosen in Mark as paid;
 *  - the upgrade of a database made before these fixes.
 */
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { PAYMENT_LIVE_CONFIRMATION, paydayForWeek } from '@lm/shared';
import { all, get, run, type Db } from '../db/connection.ts';
import { extension as paymentsExtension } from '../db/extensions/payments.ts';
import { syncPayrollForEntry } from '../db/maintenance.ts';
import { encrypt } from '../lib/crypto.ts';
import { addDays, businessNow, mondayOf } from '../lib/dates.ts';
import { refreshWaitingBatches } from '../lib/payments/batches.ts';
import { createFakeProvider } from '../lib/payments/fake.ts';
import type { PaymentProviderAdapter } from '../lib/payments/provider.ts';
import { registerPaymentProvider, unregisterPaymentProvider } from '../lib/payments/registry.ts';
import { createTrueLayerProvider } from '../lib/payments/truelayer.ts';
import { createWiseProvider } from '../lib/payments/wise.ts';
import { nextUnpaidWeek } from '../lib/payRule.ts';
import { startTrueLayerFake, startWiseFake, type TrueLayerFake, type WiseFake } from './paymentApiFakes.ts';
import { addEvent, addGauge, currentCode, startTestServer, type Json, type TestClient, type TestServer } from './helpers.ts';
import { recordSandboxRun } from './moneyTestUtils.ts';

const ec = generateKeyPairSync('ec', { namedCurve: 'secp521r1' });
const EC_PEM = ec.privateKey.export({ type: 'sec1', format: 'pem' }).toString();

function addRun(db: Db, p: { userId: number; weekStart: string; gross: number }): number {
  return run(
    db,
    `INSERT INTO payroll_runs (user_id, week_start, week_end, days_worked, sales, team_sales, base_pay, commission, bonus, overrides, deductions, gross, due_date, paid_date, status, reference)
     VALUES (?, ?, ?, 1, 0, 0, ?, 0, 0, 0, 0, ?, ?, NULL, 'pending', ?)`,
    [p.userId, p.weekStart, addDays(p.weekStart, 6), p.gross, p.gross, paydayForWeek(p.weekStart), `PAY-X-${p.userId}-${p.weekStart}`],
  ).lastInsertRowid;
}

/** Confirmed bank details (sort code 00-00-00: obviously fake). */
function setBank(db: Db, userId: number, account: string, holder = `Person ${userId} Test`): void {
  // a day before now on the business clock, the clock payments compare bank details changes with (LM_BUSINESS_NOW)
  const at = new Date(businessNow().getTime() - 86_400_000).toISOString();
  run(
    db,
    `INSERT INTO bank_accounts (user_id, holder_name, sort_code_enc, account_number_enc, last4, sort_code_last2, changed_at, changed_by, confirmed_by_admin_at, confirmed_by)
     VALUES (?, ?, ?, ?, ?, '00', ?, ?, ?, NULL)`,
    [userId, holder, encrypt('000000'), encrypt(account), account.slice(-4), at, userId, at],
  );
}

/** The real TrueLayer adapter with the host chosen by the connection's mode, as in production (two local fakes). */
function trueLayerByMode(sandboxUrl: string, liveUrl: string): PaymentProviderAdapter {
  const sandbox = createTrueLayerProvider({ baseUrl: sandboxUrl, timeoutMs: 300 });
  const live = createTrueLayerProvider({ baseUrl: liveUrl, timeoutMs: 300 });
  const pick = (mode: string) => (mode === 'live' ? live : sandbox);
  return {
    info: sandbox.info,
    configFields: sandbox.configFields,
    ready: true,
    validateConfig: (i, e) => sandbox.validateConfig(i, e),
    testConnection: (c, ctx) => pick(c.mode).testConnection(c, ctx),
    submit: (c, b, items, ctx) => pick(c.mode).submit(c, b, items, ctx),
    refresh: (c, items, ctx) => pick(c.mode).refresh(c, items, ctx),
  };
}

const accountOf = (p: { beneficiary: unknown }) => (p.beneficiary as { account_identifier?: { account_number?: string } }).account_identifier?.account_number;
const PAID = ['paid', 'late'];

let srv: TestServer;
let db: Db;
let fx: NonNullable<TestServer['fixture']>;
let admin: TestClient;
let rep: TestClient;
let weekStart: string;

async function setup(): Promise<void> {
  srv = await startTestServer();
  db = srv.db;
  fx = srv.fixture!;
  admin = await srv.login('admin');
  rep = await srv.login('rep');
  weekStart = addDays(mondayOf(fx.today), -21);
}

// Release 1.4 (S, two-step for everyone): the fixture's admin and rep signed in with two-step on (helpers.ts set it up),
// so approving a payment and changing bank details both take a current code from that secret.
const code = () => currentCode(db, fx.users.admin);
const repCode = () => currentCode(db, fx.users.rep);
const runRow = (id: number) => get<{ status: string; gross: number; adjustedAt: string | null; paidDate: string | null }>(db, `SELECT status, gross, adjusted_at AS adjustedAt, paid_date AS paidDate FROM payroll_runs WHERE id = ?`, [id])!;

describe('API providers: mode switches, resends after a timeout, Wise cancel', () => {
  let sandboxTl: TrueLayerFake;
  let liveTl: TrueLayerFake;
  let wiseFake: WiseFake;
  before(async () => {
    [sandboxTl, liveTl, wiseFake] = await Promise.all([startTrueLayerFake({ publicKey: ec.publicKey }), startTrueLayerFake({ publicKey: ec.publicKey }), startWiseFake()]);
  });
  after(async () => {
    await Promise.all([sandboxTl.close(), liveTl.close(), wiseFake.close()]);
  });
  beforeEach(async () => {
    await setup();
    sandboxTl.script({ payoutFail: 0, payoutSlow: 0 });
    liveTl.script({ payoutFail: 0, payoutSlow: 0 });
    sandboxTl.payouts.clear();
    liveTl.payouts.clear();
  });
  afterEach(async () => {
    for (const id of ['truelayer', 'wise']) unregisterPaymentProvider(id);
    await srv.close();
  });

  async function connectTrueLayer(live: boolean): Promise<number> {
    registerPaymentProvider(trueLayerByMode(sandboxTl.url, liveTl.url));
    const made = await admin.post('/payments/connections', { provider: 'truelayer', settings: { clientId: sandboxTl.clientId, signingKeyId: sandboxTl.kid }, secrets: { clientSecret: sandboxTl.clientSecret, privateKey: EC_PEM } });
    assert.equal(made.status, 201, JSON.stringify(made.json));
    const id = made.json.id as number;
    assert.equal((await admin.post(`/payments/connections/${id}/test`)).json.ok, true);
    if (live) {
      recordSandboxRun(db, id, fx.users.admin);
      assert.equal((await admin.patch(`/payments/connections/${id}`, { mode: 'live', confirm: PAYMENT_LIVE_CONFIRMATION })).status, 200);
      assert.equal((await admin.post(`/payments/connections/${id}/test`)).json.ok, true);
    }
    return id;
  }

  test('PM-1: a test payment left waiting is never sent through the live service; the switch to live waits for it', async () => {
    const id = await connectTrueLayer(false);
    setBank(db, fx.users.rep, '00000077');
    const runId = addRun(db, { userId: fx.users.rep, weekStart, gross: 63.5 });
    const draft = (await admin.post('/payments/batches', { connectionId: id, runIds: [runId] })).json;
    assert.equal(draft.mode, 'test');
    sandboxTl.script({ payoutFail: 99 }); // the sandbox is down: the item stays queued
    const approved = await admin.post(`/payments/batches/${draft.id}/approve`, { code: code() });
    assert.equal(approved.status, 200, JSON.stringify(approved.json));
    assert.equal(approved.json.items[0].status, 'queued');
    // the switch waits until the test payment has finished
    const sw = await admin.patch(`/payments/connections/${id}`, { mode: 'live', confirm: PAYMENT_LIVE_CONFIRMATION });
    assert.equal(sw.status, 409, JSON.stringify(sw.json));
    assert.match(sw.json.error, new RegExp(`Payment #${draft.id} through this connection is still on its way`));
    assert.equal((await admin.get('/payments/connections')).json.find((c: Json) => c.id === id).mode, 'test');
    // a connection switched anyway (a database from before this check): Linear Hub sends and checks nothing
    run(db, `UPDATE payment_connections SET mode = 'live', status = 'connected' WHERE id = ?`, [id]);
    sandboxTl.script({ payoutFail: 0 });
    const r = await admin.post(`/payments/batches/${draft.id}/refresh`);
    assert.equal(r.status, 409, JSON.stringify(r.json));
    assert.match(r.json.error, /made in test mode, but the connection is now live/);
    await refreshWaitingBatches(db);
    assert.equal(liveTl.payouts.size, 0, 'nothing through the live service');
    assert.equal(sandboxTl.payouts.size, 0);
    const detail = (await admin.get(`/payments/batches/${draft.id}`)).json;
    assert.equal(detail.items[0].status, 'queued');
    assert.equal(detail.actions.refresh, false);
    assert.match(detail.lastError, /made in test mode/);
    assert.equal(runRow(runId).status, 'pending');
    // back in test mode, Check now finishes it in the sandbox
    run(db, `UPDATE payment_connections SET mode = 'test' WHERE id = ?`, [id]);
    const again = await admin.post(`/payments/batches/${draft.id}/refresh`);
    assert.equal(again.status, 200, JSON.stringify(again.json));
    assert.equal(again.json.items[0].status, 'processing');
    assert.equal(again.json.lastError ?? null, null);
    assert.equal(sandboxTl.payouts.size, 1);
    assert.equal(liveTl.payouts.size, 0);
  });

  test('PM-1: a live payment left waiting is never sent to the sandbox, and its run is never marked paid by it', async () => {
    const id = await connectTrueLayer(true);
    setBank(db, fx.users.rep, '00000055');
    const runId = addRun(db, { userId: fx.users.rep, weekStart, gross: 63.5 });
    const draft = (await admin.post('/payments/batches', { connectionId: id, runIds: [runId] })).json;
    assert.equal(draft.mode, 'live');
    liveTl.script({ payoutFail: 99 });
    const approved = await admin.post(`/payments/batches/${draft.id}/approve`, { code: code() });
    assert.equal(approved.json.items[0].status, 'queued');
    const sw = await admin.patch(`/payments/connections/${id}`, { mode: 'test' });
    assert.equal(sw.status, 409, JSON.stringify(sw.json));
    assert.match(sw.json.error, /still on its way/);
    run(db, `UPDATE payment_connections SET mode = 'test', status = 'connected' WHERE id = ?`, [id]);
    liveTl.script({ payoutFail: 0 });
    const r = await admin.post(`/payments/batches/${draft.id}/refresh`);
    assert.equal(r.status, 409);
    assert.match(r.json.error, /made live, but the connection is now in test mode/);
    await refreshWaitingBatches(db);
    for (const p of sandboxTl.payouts.values()) sandboxTl.setStatus(p.id, 'executed');
    await refreshWaitingBatches(db);
    assert.equal(sandboxTl.payouts.size, 0, 'nothing to the sandbox');
    assert.equal(liveTl.payouts.size, 0);
    assert.equal(runRow(runId).status, 'pending', 'not marked paid');
    const c = await admin.post(`/payments/batches/${draft.id}/cancel`);
    assert.equal(c.status, 409, 'the payment may exist at TrueLayer: it cannot be cancelled blind');
  });

  test('PM-2: a timed-out payment resent after the person changed their bank details goes to the approved account, once; the run is never freed', async () => {
    const id = await connectTrueLayer(true);
    setBank(db, fx.users.rep, '00000088');
    const runId = addRun(db, { userId: fx.users.rep, weekStart, gross: 120.25 });
    const draft = (await admin.post('/payments/batches', { connectionId: id, runIds: [runId] })).json;
    liveTl.script({ payoutSlow: 3 }); // TrueLayer makes the payout but answers after Linear Hub gave up
    const approved = await admin.post(`/payments/batches/${draft.id}/approve`, { code: code() });
    assert.equal(approved.json.items[0].status, 'queued');
    assert.equal(liveTl.payouts.size, 1);
    assert.equal(approved.json.actions.cancel, false, 'Linear Hub does not know yet whether it was paid');
    // the payee's details are kept encrypted with the item
    const stored = get<{ enc: string | null }>(db, `SELECT payee_enc AS enc FROM payment_items WHERE batch_id = ?`, [draft.id])!.enc;
    assert.ok(stored && !stored.includes('00000088'));
    // the rep changes their bank details and the admin confirms them
    const put = await rep.put('/me/bank-details', { holderName: 'Person Test', sortCode: '000000', accountNumber: '00000099', code: repCode() });
    assert.equal(put.status, 200, JSON.stringify(put.json));
    // an administrator's confirmation takes a fresh two-step code
    assert.equal((await admin.post(`/users/${fx.users.rep}/bank-details/confirm`, { code: code() })).status, 200);
    const checked = await admin.post(`/payments/batches/${draft.id}/refresh`);
    assert.equal(checked.status, 200, JSON.stringify(checked.json));
    assert.equal(checked.json.items[0].status, 'processing', JSON.stringify(checked.json.items[0]));
    assert.equal(checked.json.items[0].failureReason, null);
    assert.equal(runRow(runId).status, 'pending', 'held, never freed');
    const again = await admin.post('/payments/batches', { connectionId: id, runIds: [runId] });
    assert.equal(again.status, 400);
    assert.equal(again.json.details.skipped[0].code, 'in_payment');
    assert.deepEqual([...liveTl.payouts.values()].map((p) => [accountOf(p), p.amount_in_minor]), [['00000088', 12025]], 'one payout, to the approved account');
    for (const p of liveTl.payouts.values()) liveTl.setStatus(p.id, 'executed');
    const done = await admin.post(`/payments/batches/${draft.id}/refresh`);
    assert.equal(done.json.items[0].status, 'paid');
    assert.ok(PAID.includes(runRow(runId).status));
    assert.equal(liveTl.payouts.size, 1);
  });

  test('PM-4: Wise "Cancel the rest" waits while a transfer may exist; after Check now finds it, cancel stops it in Wise', async () => {
    registerPaymentProvider(createWiseProvider({ baseUrl: wiseFake.url, timeoutMs: 300 }));
    const made = await admin.post('/payments/connections', { provider: 'wise', secrets: { apiToken: wiseFake.token } });
    const id = made.json.id as number;
    assert.equal((await admin.post(`/payments/connections/${id}/test`)).json.ok, true);
    recordSandboxRun(db, id, fx.users.admin);
    assert.equal((await admin.patch(`/payments/connections/${id}`, { mode: 'live', confirm: PAYMENT_LIVE_CONFIRMATION })).status, 200);
    assert.equal((await admin.post(`/payments/connections/${id}/test`)).json.ok, true);
    setBank(db, fx.users.rep, '00000066');
    const runId = addRun(db, { userId: fx.users.rep, weekStart, gross: 40 });
    const draft = (await admin.post('/payments/batches', { connectionId: id, runIds: [runId] })).json;
    const before = wiseFake.transfers.size;
    wiseFake.script({ transferSlow: 3 });
    const approved = await admin.post(`/payments/batches/${draft.id}/approve`, { code: code() });
    assert.equal(approved.json.items[0].status, 'queued');
    assert.equal(wiseFake.transfers.size - before, 1, 'Wise made the transfer');
    assert.equal(approved.json.actions.cancel, false);
    const c = await admin.post(`/payments/batches/${draft.id}/cancel`);
    assert.equal(c.status, 409, JSON.stringify(c.json));
    assert.match(c.json.error, /still finding out whether Wise Business made the transfer for Remy Rep: press Check now, then cancel/);
    assert.equal(get<{ at: string | null }>(db, `SELECT cancelled_at AS at FROM payment_batches WHERE id = ?`, [draft.id])!.at, null);
    // Check now finds the transfer (the same one: same customerTransactionId)
    const checked = await admin.post(`/payments/batches/${draft.id}/refresh`);
    assert.equal(checked.json.items[0].status, 'processing');
    assert.ok(checked.json.items[0].providerRef);
    assert.equal(checked.json.actions.cancel, true);
    assert.equal(wiseFake.transfers.size - before, 1);
    const stopped = await admin.post(`/payments/batches/${draft.id}/cancel`);
    assert.equal(stopped.status, 200, JSON.stringify(stopped.json));
    assert.equal(stopped.json.items[0].status, 'failed');
    assert.equal([...wiseFake.transfers.values()].at(-1)!.status, 'cancelled');
    assert.equal(runRow(runId).status, 'failed', 'back on Runs to pay');
    await refreshWaitingBatches(db);
    assert.equal(wiseFake.transfers.size - before, 1, 'never sent again');
  });
});

describe('fake provider: connections, cancelling what was never sent, bank file dates, frozen runs', () => {
  beforeEach(async () => {
    await setup();
  });
  afterEach(async () => {
    unregisterPaymentProvider('fake');
    await srv.close();
  });

  test('PAYUI-1: switching mode or changing keys forgets the last test and its balance', async () => {
    registerPaymentProvider(createFakeProvider());
    const made = await admin.post('/payments/connections', { provider: 'fake', name: 'Fake', secrets: { token: 'tok-1' } });
    const id = made.json.id as number;
    const t = await admin.post(`/payments/connections/${id}/test`);
    assert.equal(t.json.connection.balancePence, 1_000_000);
    assert.ok(t.json.connection.lastCheckedAt);
    recordSandboxRun(db, id, fx.users.admin);
    const live = await admin.patch(`/payments/connections/${id}`, { mode: 'live', confirm: PAYMENT_LIVE_CONFIRMATION });
    assert.equal(live.status, 200);
    assert.equal(live.json.status, 'not_connected');
    assert.equal(live.json.balancePence, null, 'the sandbox balance is not the live one');
    assert.equal(live.json.lastCheckedAt, null);
    await admin.post(`/payments/connections/${id}/test`);
    const keys = await admin.patch(`/payments/connections/${id}`, { secrets: { token: 'tok-2' } });
    assert.equal(keys.json.balancePence, null);
    assert.equal(keys.json.lastCheckedAt, null);
    await admin.post(`/payments/connections/${id}/test`);
    const renamed = await admin.patch(`/payments/connections/${id}`, { name: 'Fake 2' });
    assert.equal(renamed.json.balancePence, 1_000_000, 'a new name changes nothing else');
  });

  test('PM-4: queued items Linear Hub never sent are cancelled here, even through a provider that cannot cancel', async () => {
    const fake = createFakeProvider();
    registerPaymentProvider(fake);
    const made = await admin.post('/payments/connections', { provider: 'fake', name: 'Fake' });
    const id = made.json.id as number;
    await admin.post(`/payments/connections/${id}/test`);
    recordSandboxRun(db, id, fx.users.admin);
    await admin.patch(`/payments/connections/${id}`, { mode: 'live', confirm: PAYMENT_LIVE_CONFIRMATION });
    await admin.post(`/payments/connections/${id}/test`);
    setBank(db, fx.users.rep, '00000031');
    const runId = addRun(db, { userId: fx.users.rep, weekStart, gross: 30 });
    const draft = (await admin.post('/payments/batches', { connectionId: id, runIds: [runId] })).json;
    // approved, then nothing sent (as when the connection's mode no longer matches)
    run(db, `UPDATE payment_batches SET status = 'submitted', approved_at = ?, approved_by = ? WHERE id = ?`, [new Date().toISOString(), fx.users.admin, draft.id]);
    const detail = (await admin.get(`/payments/batches/${draft.id}`)).json;
    assert.equal(detail.actions.cancel, true);
    const c = await admin.post(`/payments/batches/${draft.id}/cancel`);
    assert.equal(c.status, 200, JSON.stringify(c.json));
    assert.equal(c.json.items[0].status, 'cancelled');
    assert.equal(c.json.status, 'cancelled');
    assert.equal(fake.calls.submit, 0);
    assert.equal(runRow(runId).status, 'pending');
    assert.equal((await admin.post('/payments/batches', { connectionId: id, runIds: [runId] })).status, 201, 'free for a new payment');
  });

  test('PM-2: a payment approved before payees were kept resends only to unchanged details, else waits (never failed here)', async () => {
    const fake = createFakeProvider({ throwSubmit: 1, submitStatus: 'processing' });
    registerPaymentProvider(fake);
    const made = await admin.post('/payments/connections', { provider: 'fake', name: 'Fake' });
    const id = made.json.id as number;
    await admin.post(`/payments/connections/${id}/test`);
    recordSandboxRun(db, id, fx.users.admin);
    await admin.patch(`/payments/connections/${id}`, { mode: 'live', confirm: PAYMENT_LIVE_CONFIRMATION });
    await admin.post(`/payments/connections/${id}/test`);
    setBank(db, fx.users.rep, '00000033');
    setBank(db, fx.users.repA2, '00000034');
    const a = addRun(db, { userId: fx.users.rep, weekStart, gross: 30 });
    const b = addRun(db, { userId: fx.users.repA2, weekStart, gross: 31 });
    const draft = (await admin.post('/payments/batches', { connectionId: id, runIds: [a, b] })).json;
    const approved = await admin.post(`/payments/batches/${draft.id}/approve`, { code: code() });
    assert.deepEqual(approved.json.items.map((i: Json) => i.status), ['queued', 'queued']);
    assert.equal(fake.calls.submit, 1);
    // as older data: no payee kept; Remy changes their details, Rita does not
    run(db, `UPDATE payment_items SET payee_enc = NULL WHERE batch_id = ?`, [draft.id]);
    assert.equal((await rep.put('/me/bank-details', { holderName: 'Remy Rep', sortCode: '000000', accountNumber: '00000035', code: repCode() })).status, 200);
    fake.script({ refreshStatus: 'processing' });
    const r = await admin.post(`/payments/batches/${draft.id}/refresh`);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const byRun = new Map((r.json.items as Json[]).map((i) => [i.payrollRunId, i]));
    assert.equal(byRun.get(a).status, 'queued', 'not sent to the new account, and not failed');
    assert.equal(byRun.get(b).status, 'processing');
    assert.match(r.json.lastError, /did not send Remy Rep's payment again: it no longer has the bank details you approved it with/);
    assert.deepEqual([...fake.payments.values()].map((p) => p.accountNumber).sort(), ['00000033', '00000034'], 'the first (timed-out) submit only');
    assert.equal(runRow(a).status, 'pending');
  });

  test('PAYUI-8: a bank file item shows the paid date chosen in Mark as paid', async () => {
    registerPaymentProvider(createFakeProvider({ kind: 'file' }));
    const made = await admin.post('/payments/connections', { provider: 'fake', name: 'File' });
    assert.equal((await admin.patch(`/payments/connections/${made.json.id}`, { mode: 'live', confirm: PAYMENT_LIVE_CONFIRMATION })).status, 200);
    setBank(db, fx.users.rep, '00000032');
    const runId = addRun(db, { userId: fx.users.rep, weekStart, gross: 25 });
    const draft = (await admin.post('/payments/batches', { connectionId: made.json.id, runIds: [runId] })).json;
    await admin.post(`/payments/batches/${draft.id}/approve`, { code: code() });
    const paidDate = addDays(weekStart, 9);
    const m = await admin.post(`/payments/batches/${draft.id}/mark-paid`, { paidDate });
    assert.equal(m.status, 200, JSON.stringify(m.json));
    assert.equal(m.json.items[0].runPaidDate, runRow(runId).paidDate);
    assert.equal(m.json.items[0].runPaidDate, paidDate);
  });

  test('PM-3: a run stays at its approved figures while its bank file is with the bank; the change is flagged for a later week', async () => {
    const monday = weekStart;
    const date = addDays(monday, 2);
    const ev = addEvent(db, { campaignId: fx.campaignId, teamId: fx.teams.a, date });
    const g = addGauge(db, { eventId: ev, userId: fx.users.rep, date, stops: 60, sales: 4 });
    syncPayrollForEntry(db, { userId: fx.users.rep, eventId: ev, date });
    const r = get<{ id: number; gross: number }>(db, `SELECT id, gross FROM payroll_runs WHERE user_id = ? AND week_start = ?`, [fx.users.rep, monday])!;
    setBank(db, fx.users.rep, '00000044', 'Remy Rep');
    const conn = (await admin.post('/payments/connections', { provider: 'bank_file', settings: { format: 'starling' } })).json;
    assert.equal((await admin.patch(`/payments/connections/${conn.id}`, { mode: 'live', confirm: PAYMENT_LIVE_CONFIRMATION })).status, 200);
    const draft = await admin.post('/payments/batches', { connectionId: conn.id, runIds: [r.id] });
    assert.equal(draft.status, 201, JSON.stringify(draft.json));
    const ap = await admin.post(`/payments/batches/${draft.json.id}/approve`, { code: code() });
    assert.equal(ap.status, 200, JSON.stringify(ap.json));
    const sent = draft.json.items[0].amountPence as number;
    // while the file is with the bank, an admin corrects the gauge (two more sales)
    const p = await admin.patch(`/gauges/${g}`, { sales: 6, taps: 6, closes: 6, presentations: 10, table: 21 });
    assert.equal(p.status, 200, JSON.stringify(p.json));
    let now = runRow(r.id);
    assert.equal(Math.round(now.gross * 100), sent, 'the run holds what the file pays');
    assert.equal(now.status, 'pending');
    assert.ok(now.adjustedAt, 'flagged: the gauges now say more');
    // nothing can be added to or taken off the week while its pay is on its way; corrections go to a later week
    const bonus = await admin.post('/pay/bonuses', { userId: fx.users.rep, weekStart: monday, amount: 10, note: 'Top seller' });
    assert.equal(bonus.status, 409, JSON.stringify(bonus.json));
    assert.match(bonus.json.error, /on its way/);
    assert.ok(nextUnpaidWeek(db, fx.users.rep, addDays(monday, -7)) > monday, 'a correction for an earlier week skips the week on its way');
    srv.resetCache();
    const feed = (await admin.get('/me/attention')).json.items as Json[];
    assert.ok(feed.some((i) => i.kind === 'payments' && /pay changed while payment #\d+ was on its way/.test(i.title)), JSON.stringify(feed.map((i) => i.title)));
    const m = await admin.post(`/payments/batches/${draft.json.id}/mark-paid`, {});
    assert.equal(m.status, 200, JSON.stringify(m.json));
    assert.equal(m.json.items[0].amountPence, sent);
    assert.match(m.json.items[0].note ?? '', /changed while the money was on its way/);
    now = runRow(r.id);
    assert.ok(PAID.includes(now.status));
    assert.equal(Math.round(now.gross * 100), sent, 'paid at what was sent');
    assert.ok(now.adjustedAt, 'Adjusted after payment');
    assert.equal(all(db, `SELECT 1 FROM pay_adjustments WHERE user_id = ?`, [fx.users.rep]).length, 0, 'no line made behind the admin’s back');
  });

  test('PM-3: when the bank rejects the file, the freed run picks up the new figures', async () => {
    const monday = weekStart;
    const date = addDays(monday, 2);
    const ev = addEvent(db, { campaignId: fx.campaignId, teamId: fx.teams.a, date });
    const g = addGauge(db, { eventId: ev, userId: fx.users.rep, date, stops: 60, sales: 4 });
    syncPayrollForEntry(db, { userId: fx.users.rep, eventId: ev, date });
    const r = get<{ id: number; gross: number }>(db, `SELECT id, gross FROM payroll_runs WHERE user_id = ? AND week_start = ?`, [fx.users.rep, monday])!;
    setBank(db, fx.users.rep, '00000045', 'Remy Rep');
    const conn = (await admin.post('/payments/connections', { provider: 'bank_file', settings: { format: 'starling' } })).json;
    assert.equal((await admin.patch(`/payments/connections/${conn.id}`, { mode: 'live', confirm: PAYMENT_LIVE_CONFIRMATION })).status, 200);
    const draft = (await admin.post('/payments/batches', { connectionId: conn.id, runIds: [r.id] })).json;
    await admin.post(`/payments/batches/${draft.id}/approve`, { code: code() });
    assert.equal((await admin.patch(`/gauges/${g}`, { sales: 6, taps: 6, closes: 6, presentations: 10, table: 21 })).status, 200);
    assert.equal(runRow(r.id).gross, r.gross);
    const m = await admin.post(`/payments/batches/${draft.id}/mark-paid`, { failed: [draft.items[0].id], reason: 'Rejected by the bank' });
    assert.equal(m.status, 200, JSON.stringify(m.json));
    const now = runRow(r.id);
    assert.equal(now.status, 'failed');
    assert.ok(now.gross > r.gross, `recalculated: ${now.gross} > ${r.gross}`);
    assert.equal(now.adjustedAt, null, 'nothing was paid, so nothing is adjusted after payment');
    srv.resetCache();
    assert.ok(!((await admin.get('/me/attention')).json.items as Json[]).some((i) => /pay changed while/.test(i.title)));
  });
});

test('a database made before these fixes gains payee_enc and attempted_at; items of approved payments count as sent', () => {
  const old = new DatabaseSync(':memory:');
  old.exec(`CREATE TABLE payment_batches (id INTEGER PRIMARY KEY, approved_at TEXT);
            CREATE TABLE payment_items (id INTEGER PRIMARY KEY, batch_id INTEGER NOT NULL, submitted_at TEXT, updated_at TEXT NOT NULL);
            INSERT INTO payment_batches VALUES (1, '2026-10-20T10:00:00.000Z'), (2, NULL);
            INSERT INTO payment_items VALUES (1, 1, NULL, '2026-10-20T10:00:01.000Z'), (2, 1, '2026-10-20T10:00:02.000Z', '2026-10-20T10:05:00.000Z'), (3, 2, NULL, '2026-10-21T09:00:00.000Z');`);
  assert.deepEqual(paymentsExtension.upgrade(old), ['payment_items.payee_enc', 'payment_items.attempted_at']);
  assert.deepEqual(all<{ id: number; a: string | null; p: string | null }>(old, `SELECT id, attempted_at AS a, payee_enc AS p FROM payment_items ORDER BY id`).map((r) => ({ id: r.id, a: r.a, p: r.p })), [
    { id: 1, a: '2026-10-20T10:00:01.000Z', p: null },
    { id: 2, a: '2026-10-20T10:00:02.000Z', p: null },
    { id: 3, a: null, p: null },
  ]);
  assert.deepEqual(paymentsExtension.upgrade(old), [], 'once');
  old.close();
});
