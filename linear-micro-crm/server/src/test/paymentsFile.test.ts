/**
 * Release 1.4 — package P (bank payment file): the real `bank_file` provider end to end, for every format it makes —
 * connect (format picker), approve with a fresh two-step code → the file (exact bytes, per format), the download
 * (admin only, recorded, never cached), "Mark as paid" for all or some (the rest failed with a reason, their runs on
 * Runs to pay), rows a bank would refuse (left out of the file with a plain reason), the formula guard, and account
 * numbers never leaving the server except inside the file. Every route for admin, leader, recruiter, rep, client and
 * signed out. Bank details are obviously fake (00-00-00 / 0000000x): the repository is public.
 */
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { BANK_FILE_FORMAT_IDS, defaultPaymentReference, paydayForWeek } from '@lm/shared';
import { all, get, run, type Db } from '../db/connection.ts';
import { encrypt } from '../lib/crypto.ts';
import { addDays, mondayOf } from '../lib/dates.ts';
import { paymentProvider } from '../lib/payments/registry.ts';
import { currentCode, startTestServer, type Json, type TestClient, type TestServer } from './helpers.ts';

// ───────────────────────────── helpers ─────────────────────────────

function addRun(db: Db, p: { userId: number; weekStart: string; gross: number }): number {
  return run(
    db,
    `INSERT INTO payroll_runs (user_id, week_start, week_end, days_worked, sales, team_sales, base_pay, commission, bonus, overrides, deductions, gross, due_date, paid_date, status, reference)
     VALUES (?, ?, ?, 1, 0, 0, ?, 0, 0, 0, 0, ?, ?, NULL, 'pending', ?)`,
    [p.userId, p.weekStart, addDays(p.weekStart, 6), p.gross, p.gross, paydayForWeek(p.weekStart), `PAY-T-${p.userId}-${p.weekStart}`],
  ).lastInsertRowid;
}

/** Confirmed bank details straight into the table: sort code 00-00-00, account 0000000<n> (obviously fake). */
function setBank(db: Db, userId: number, holder: string, account: string): void {
  const at = new Date(Date.now() - 86_400_000).toISOString();
  run(
    db,
    `INSERT INTO bank_accounts (user_id, holder_name, sort_code_enc, account_number_enc, last4, sort_code_last2, changed_at, changed_by, confirmed_by_admin_at, confirmed_by)
     VALUES (?, ?, ?, ?, ?, '00', ?, ?, ?, NULL)
     ON CONFLICT(user_id) DO UPDATE SET holder_name = excluded.holder_name, account_number_enc = excluded.account_number_enc, last4 = excluded.last4`,
    [userId, holder, encrypt('000000'), encrypt(account), account.slice(-4), at, userId, at],
  );
}

const runRow = (db: Db, id: number) => get<{ status: string; paidDate: string | null }>(db, `SELECT status, paid_date AS paidDate FROM payroll_runs WHERE id = ?`, [id])!;

let srv: TestServer;
let fx: NonNullable<TestServer['fixture']>;
let admin: TestClient;
let leader: TestClient;
let recruiter: TestClient;
let rep: TestClient;
let client: TestClient;
let anon: TestClient;
let week: string;

async function setup(): Promise<void> {
  srv = await startTestServer();
  fx = srv.fixture!;
  [admin, leader, recruiter, rep, client] = await Promise.all((['admin', 'leader', 'recruiter', 'rep', 'client'] as const).map((r) => srv.login(r)));
  anon = srv.anon();
  // Release 1.4 (S): the fixture admin signed in with two-step on (helpers.ts); approvals take a code from it
  week = addDays(mondayOf(fx.today), -21);
  setBank(srv.db, fx.users.rep, 'Remy Rep', '00000001');
  setBank(srv.db, fx.users.repA2, 'Rita Rep', '00000002');
}

async function teardown(): Promise<void> {
  await srv.close();
}

async function fileConnection(format: string): Promise<number> {
  const made = await admin.post('/payments/connections', { provider: 'bank_file', settings: { format } });
  assert.equal(made.status, 201, JSON.stringify(made.json));
  return made.json.id as number;
}

/** A draft for Remy (£945.50) and Rita (£63.50) through `conn`, approved: the file is ready. */
async function approvedBatch(conn: number): Promise<{ batch: Json; runA: number; runB: number }> {
  const runA = addRun(srv.db, { userId: fx.users.rep, weekStart: week, gross: 945.5 });
  const runB = addRun(srv.db, { userId: fx.users.repA2, weekStart: week, gross: 63.5 });
  const draft = await admin.post('/payments/batches', { connectionId: conn, runIds: [runA, runB] });
  assert.equal(draft.status, 201, JSON.stringify(draft.json));
  assert.equal(draft.json.actions.approve, true, 'the bank file can be approved');
  const sent = await admin.post(`/payments/batches/${draft.json.id}/approve`, { code: currentCode(srv.db, fx.users.admin) });
  assert.equal(sent.status, 200, JSON.stringify(sent.json));
  return { batch: sent.json, runA, runB };
}

const itemFor = (batch: Json, runId: number) => (batch.items as Json[]).find((i) => i.payrollRunId === runId);

// ───────────────────────────── the provider ─────────────────────────────

describe('bank payment file: the way to pay and its formats', () => {
  beforeEach(setup);
  afterEach(teardown);

  test('available now, with the format picker (bank logos) and plain abilities', async () => {
    const r = await admin.get('/payments/providers');
    const file = (r.json as Json[]).find((p) => p.id === 'bank_file');
    assert.equal(file.available, true);
    assert.equal(file.kind, 'file');
    const format = file.configFields.find((f: Json) => f.name === 'format');
    assert.equal(format.type, 'select');
    assert.equal(format.required, true);
    assert.deepEqual(format.options.map((o: Json) => o.value), [...BANK_FILE_FORMAT_IDS]);
    assert.deepEqual(format.options.map((o: Json) => o.iconKey), ['bank', 'starling', 'revolut']);
    for (const o of format.options) assert.ok(o.label && o.hint, o.value);
    assert.equal(file.abilities.paysFromApp, false, 'you upload the file');
    assert.equal(file.abilities.confirmsAutomatically, false, 'you mark it paid');
    assert.equal(file.abilities.needsBankApproval, true);
    assert.equal(file.abilities.testMode, false);
    assert.equal(file.abilities.anyUkBank, true, 'works with any UK business bank');
    assert.match(file.abilities.fees, /No fees from Linear Hub/);
    assert.equal(paymentProvider('bank_file')?.ready, true);
  });

  test('connect: the format is required and must be one of the list; changing it keeps the connection ready', async () => {
    const missing = await admin.post('/payments/connections', { provider: 'bank_file', settings: {} });
    assert.equal(missing.status, 400);
    assert.ok(missing.json.details.some((d: Json) => d.path === 'format'));
    const wrong = await admin.post('/payments/connections', { provider: 'bank_file', settings: { format: 'natwest' } });
    assert.equal(wrong.status, 400, 'only the formats we could check against the bank');
    const id = await fileConnection('starling');
    const c = (await admin.get('/payments/connections')).json.find((x: Json) => x.id === id);
    assert.equal(c.status, 'connected');
    assert.equal(c.mode, 'live');
    assert.deepEqual(c.settings, { format: 'starling' });
    assert.deepEqual(c.secretsSet, [], 'nothing secret is stored for a bank file');
    const changed = await admin.patch(`/payments/connections/${id}`, { settings: { format: 'revolut' } });
    assert.equal(changed.status, 200);
    assert.equal(changed.json.settings.format, 'revolut');
    assert.equal(changed.json.status, 'connected', 'a file needs no new test');
    const t = await admin.post(`/payments/connections/${id}/test`);
    assert.equal(t.status, 200);
    assert.equal(t.json.ok, true);
    assert.match(t.json.message, /Revolut Business/);
    assert.match(t.json.message, /nothing to connect to/i);
  });
});

// ───────────────────────────── the files, byte for byte ─────────────────────────────

describe('bank payment file: approve makes the file, exactly as the bank takes it', () => {
  beforeEach(setup);
  afterEach(teardown);

  const refs = () => ({ remy: defaultPaymentReference(week, 'Remy Rep'), rita: defaultPaymentReference(week, 'Rita Rep') });

  const EXPECTED: Record<string, (r: { remy: string; rita: string }) => string> = {
    generic: (r) => `Payee name,Sort code,Account number,Amount,Reference\r\nRemy Rep,000000,00000001,945.50,${r.remy}\r\nRita Rep,000000,00000002,63.50,${r.rita}\r\n`,
    starling: (r) => `Payee Sort Code,Payee Account Number,Payee Name,Payment Reference,Amount\r\n000000,00000001,Remy Rep,${r.remy},945.50\r\n000000,00000002,Rita Rep,${r.rita},63.50\r\n`,
    revolut: (r) => `Name,Recipient type,Account number,Sort code,Recipient bank country,Currency,Amount,Payment reference\r\nRemy Rep,INDIVIDUAL,00000001,000000,GB,GBP,945.50,${r.remy}\r\nRita Rep,INDIVIDUAL,00000002,000000,GB,GBP,63.50,${r.rita}\r\n`,
  };

  for (const format of BANK_FILE_FORMAT_IDS) {
    test(`${format}: the file, its name, the download (admin only, recorded, never cached)`, async () => {
      const conn = await fileConnection(format);
      const { batch } = await approvedBatch(conn);
      assert.equal(batch.status, 'submitted');
      assert.equal(batch.kind, 'file');
      assert.deepEqual(batch.actions, { approve: false, cancel: true, refresh: false, download: true, markPaid: true });
      assert.equal(batch.items.every((i: Json) => i.status === 'submitted'), true);
      assert.match(batch.fileName, new RegExp(`^linear-hub-payment-${batch.id}-\\d{4}-\\d{2}-\\d{2}-${format === 'generic' ? 'faster-payments' : format}\\.csv$`));
      // the reference written in the file is kept on each line (to find it on the bank statement)
      assert.equal(itemFor(batch, batch.items[0].payrollRunId).providerRef, refs().remy);
      for (const r of [refs().remy, refs().rita]) assert.ok(r.length <= 18, r);
      const file = await admin.get(`/payments/batches/${batch.id}/file`);
      assert.equal(file.status, 200);
      assert.equal(file.json, EXPECTED[format]!(refs()));
      assert.equal(file.headers.get('content-type'), 'text/csv; charset=utf-8');
      assert.equal(file.headers.get('content-disposition'), `attachment; filename="${batch.fileName}"`);
      assert.equal(file.headers.get('cache-control'), 'no-store');
      const audit = all<{ kind: string; summary: string; after: string }>(srv.db, `SELECT kind, summary, after_json AS after FROM audit_log WHERE action = 'GET /payments/batches/:id/file'`);
      assert.equal(audit.length, 1);
      assert.equal(audit[0]!.kind, 'export');
      assert.match(audit[0]!.summary, /2 people, £1,009\.00/);
      // every other role: no file, no marking
      for (const [who, c] of [['leader', leader], ['recruiter', recruiter], ['rep', rep], ['client', client]] as const) {
        assert.equal((await c.get(`/payments/batches/${batch.id}/file`)).status, 403, who);
        assert.equal((await c.post(`/payments/batches/${batch.id}/mark-paid`, {})).status, 403, who);
      }
      assert.equal((await anon.get(`/payments/batches/${batch.id}/file`)).status, 401);
      assert.equal((await anon.post(`/payments/batches/${batch.id}/mark-paid`, {})).status, 401);
    });
  }

  test('the account numbers stay on the server: not in the payment, the list, the audit trail or the stored file', async () => {
    const conn = await fileConnection('generic');
    const { batch } = await approvedBatch(conn);
    const answers = JSON.stringify([batch, (await admin.get(`/payments/batches/${batch.id}`)).json, (await admin.get('/payments/batches')).json, (await admin.get('/finance/payroll?limit=500')).json]);
    assert.ok(!answers.includes('00000001') && !answers.includes('00000002'), 'only the last four digits');
    await admin.get(`/payments/batches/${batch.id}/file`);
    const audit = JSON.stringify(all(srv.db, `SELECT summary, before_json, after_json FROM audit_log`));
    assert.ok(!audit.includes('00000001') && !audit.includes('00000002'), 'no account number in the audit trail');
    const stored = get<{ f: string }>(srv.db, `SELECT file_enc AS f FROM payment_batches WHERE id = ?`, [batch.id])!.f;
    assert.match(stored, /^v1:/);
    assert.ok(!stored.includes('00000001') && !stored.includes('Remy'), 'the file is stored encrypted');
  });

  test('a second approval, a check-now or a file before approval are refused plainly', async () => {
    const conn = await fileConnection('starling');
    const runA = addRun(srv.db, { userId: fx.users.rep, weekStart: week, gross: 10 });
    const draft = (await admin.post('/payments/batches', { connectionId: conn, runIds: [runA] })).json;
    assert.equal((await admin.get(`/payments/batches/${draft.id}/file`)).status, 404, 'no file before approval');
    assert.equal((await admin.post(`/payments/batches/${draft.id}/approve`, { code: '000000' })).status, 400, 'a wrong code makes no file');
    assert.equal((await admin.get(`/payments/batches/${draft.id}/file`)).status, 404);
    const ok = await admin.post(`/payments/batches/${draft.id}/approve`, { code: currentCode(srv.db, fx.users.admin) });
    assert.equal(ok.status, 200);
    const again = await admin.post(`/payments/batches/${draft.id}/approve`, { code: currentCode(srv.db, fx.users.admin) });
    assert.equal(again.status, 409);
    const check = await admin.post(`/payments/batches/${draft.id}/refresh`);
    assert.equal(check.status, 409);
    assert.match(check.json.error, /mark it paid once your bank has paid it/);
  });
});

// ───────────────────────────── rows a bank would refuse, and the formula guard ─────────────────────────────

describe('bank payment file: rows a bank would refuse, and the formula guard', () => {
  beforeEach(setup);
  afterEach(teardown);

  test('Revolut needs a first and a last name: that person is left out with the reason, their week stays on Runs to pay', async () => {
    setBank(srv.db, fx.users.repA2, 'Rita', '00000002');
    const conn = await fileConnection('revolut');
    const { batch, runA, runB } = await approvedBatch(conn);
    assert.equal(batch.status, 'processing', 'one in the file, one failed');
    assert.equal(itemFor(batch, runA).status, 'submitted');
    const b = itemFor(batch, runB);
    assert.equal(b.status, 'failed');
    assert.match(b.failureReason, /Revolut Business needs the first and last name on the account/);
    assert.equal(runRow(srv.db, runB).status, 'failed');
    const payroll = (await admin.get('/finance/payroll?limit=500')).json;
    const rows = Array.isArray(payroll) ? payroll : payroll.runs ?? payroll.items;
    const onRunsToPay = (rows as Json[]).find((r) => r.id === runB);
    assert.equal(onRunsToPay.payment.status, 'failed');
    assert.match(onRunsToPay.payment.failureReason, /first and last name/);
    const file = String((await admin.get(`/payments/batches/${batch.id}/file`)).json);
    assert.match(file, /Remy Rep/);
    assert.doesNotMatch(file, /Rita/);
    assert.equal(file.trim().split('\r\n').length, 2, 'header and Remy');
  });

  test('nobody payable through this format: no file is made, the payment fails with the reasons', async () => {
    setBank(srv.db, fx.users.rep, 'Remy', '00000001');
    setBank(srv.db, fx.users.repA2, 'Rita', '00000002');
    const conn = await fileConnection('revolut');
    const { batch } = await approvedBatch(conn);
    assert.equal(batch.status, 'failed');
    assert.equal(batch.actions.download, false);
    assert.equal((await admin.get(`/payments/batches/${batch.id}/file`)).status, 404);
  });

  test('a name a spreadsheet would run is made harmless in the file', async () => {
    // bypassing the form's checks on purpose (the form refuses these characters): the file guards on its own
    setBank(srv.db, fx.users.rep, '=HYPERLINK("http://evil.example","x") Rep', '00000001');
    setBank(srv.db, fx.users.repA2, '-2+3+cmd|" /C calc"!A0 Rep', '00000002');
    for (const format of BANK_FILE_FORMAT_IDS) {
      const conn = await fileConnection(format);
      const runA = addRun(srv.db, { userId: fx.users.rep, weekStart: addDays(week, -7 * (BANK_FILE_FORMAT_IDS.indexOf(format) + 1)), gross: 12 });
      const runB = addRun(srv.db, { userId: fx.users.repA2, weekStart: addDays(week, -7 * (BANK_FILE_FORMAT_IDS.indexOf(format) + 1)), gross: 12 });
      const draft = (await admin.post('/payments/batches', { connectionId: conn, runIds: [runA, runB] })).json;
      const sent = (await admin.post(`/payments/batches/${draft.id}/approve`, { code: currentCode(srv.db, fx.users.admin) })).json;
      assert.equal(sent.items.filter((i: Json) => i.status === 'submitted').length, 2, format);
      const file = String((await admin.get(`/payments/batches/${sent.id}/file`)).json);
      for (const cell of file.trim().split('\r\n').flatMap((l) => l.split(','))) assert.doesNotMatch(cell, /^[=+\-@\t\r]/, `${format}: ${cell}`);
      assert.doesNotMatch(file, /[="|!()]/, format);
    }
  });
});

// ───────────────────────────── Mark as paid ─────────────────────────────

describe('bank payment file: Mark as paid, all or some', () => {
  before(setup);
  after(teardown);

  test('all: every person in the file is paid, their runs marked paid once', async () => {
    const conn = await fileConnection('starling');
    const { batch, runA, runB } = await approvedBatch(conn);
    const marked = await admin.post(`/payments/batches/${batch.id}/mark-paid`, {});
    assert.equal(marked.status, 200, JSON.stringify(marked.json));
    assert.equal(marked.json.status, 'completed');
    assert.equal(marked.json.paidCount, 2);
    assert.equal(marked.json.actions.markPaid, false);
    for (const r of [runA, runB]) assert.match(runRow(srv.db, r).status, /^(paid|late)$/);
    assert.equal((await admin.post(`/payments/batches/${batch.id}/mark-paid`, {})).status, 409, 'nothing left to mark');
    assert.equal((await admin.post(`/finance/payroll/${runA}/pay`, {})).status, 409, 'a paid run is never paid again');
    const rows = all<{ action: string }>(srv.db, `SELECT action FROM audit_log WHERE entity = 'payroll_run' AND entity_id IN (?, ?) AND action = 'POST /payments/batches/:id/mark-paid'`, [runA, runB]);
    assert.equal(rows.length, 2, 'one audit row per run');
  });

  test('some: the unticked ones fail with the reason given and stay on Runs to pay', async () => {
    const conn = await fileConnection('generic');
    week = addDays(week, -7);
    const { batch, runA, runB } = await approvedBatch(conn);
    const a = itemFor(batch, runA).id;
    const b = itemFor(batch, runB).id;
    const marked = await admin.post(`/payments/batches/${batch.id}/mark-paid`, { paid: [a], failed: [b], reason: 'Rejected by the bank: the name does not match the account' });
    assert.equal(marked.status, 200, JSON.stringify(marked.json));
    assert.equal(marked.json.status, 'partly_failed');
    assert.match(runRow(srv.db, runA).status, /^(paid|late)$/);
    assert.equal(runRow(srv.db, runB).status, 'failed');
    assert.equal(itemFor(marked.json, runB).failureReason, 'Rejected by the bank: the name does not match the account');
    // the failed week can go in a new payment (a fixed file)
    const again = await admin.post('/payments/batches', { connectionId: conn, runIds: [runB] });
    assert.equal(again.status, 201, JSON.stringify(again.json));
    assert.equal(again.json.items.length, 1);
  });

  test('none: the bank paid nobody, every person fails with the plain default reason', async () => {
    const conn = await fileConnection('revolut');
    week = addDays(week, -7);
    const { batch, runA, runB } = await approvedBatch(conn);
    const ids = (batch.items as Json[]).map((i) => i.id);
    const marked = await admin.post(`/payments/batches/${batch.id}/mark-paid`, { paid: [], failed: ids });
    assert.equal(marked.status, 200, JSON.stringify(marked.json));
    assert.equal(marked.json.status, 'failed');
    for (const r of [runA, runB]) assert.equal(runRow(srv.db, r).status, 'failed');
    assert.ok((marked.json.items as Json[]).every((i) => i.failureReason === 'The bank did not pay this one'));
  });

  test('cancel after the file was made: the file is gone and the runs stay unpaid', async () => {
    const conn = await fileConnection('generic');
    week = addDays(week, -7);
    const { batch, runA } = await approvedBatch(conn);
    const c = await admin.post(`/payments/batches/${batch.id}/cancel`);
    assert.equal(c.status, 200);
    assert.equal(c.json.status, 'cancelled');
    assert.equal((await admin.get(`/payments/batches/${batch.id}/file`)).status, 404);
    assert.equal(runRow(srv.db, runA).status, 'pending');
  });
});
