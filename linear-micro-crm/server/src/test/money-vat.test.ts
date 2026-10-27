/**
 * MON-7: VAT on self-billed invoices. A supplier with a VAT number is charged VAT at the standard rate on the invoice
 * total (rounded down to the penny), the invoice carries HMRC's sentence for self-billed invoices and the supplier's VAT
 * number, and the payment pays the total with VAT. Registering for VAT (or stopping) reissues the open invoices for the
 * person to accept again; an invoice already accepted, or counting as accepted, keeps what was accepted.
 * VAT numbers here are obviously fake (GB000000000): the repository is public.
 */
import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { PAYMENT_LIVE_CONFIRMATION, SELF_BILLING_VAT_STATEMENT, penceToPounds, poundsToPence, vatPence, type Invoice } from '@lm/shared';
import { all, get, run } from '../db/connection.ts';
import { materialisePayrollRuns } from '../db/maintenance.ts';
import { encrypt } from '../lib/crypto.ts';
import { addDays, businessNow, mondayOf } from '../lib/dates.ts';
import { syncInvoices } from '../lib/invoices.ts';
import { addHistory, currentCode, startTestServer, type Json, type TestClient, type TestServer } from './helpers.ts';

let srv: TestServer;
let fx: NonNullable<TestServer['fixture']>;
let admin: TestClient;
let leader: TestClient;
let rep: TestClient;
let lastWeek: string;

const runIdOf = (userId: number, week: string) => get<{ id: number }>(srv.db, `SELECT id FROM payroll_runs WHERE user_id = ? AND week_start = ?`, [userId, week])!.id;
const invoiceOf = async (c: TestClient, runId: number) => {
  const r = await c.get(`/invoices/by-run/${runId}`);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json as Invoice;
};
const expectedVat = (total: number) => penceToPounds(vatPence(poundsToPence(total), 20));

describe('MON-7: VAT on self-billed invoices', () => {
  beforeEach(async () => {
    srv = await startTestServer();
    fx = srv.fixture!;
    addHistory(srv.db, { userId: fx.users.rep, teamId: fx.teams.a, campaignId: fx.campaignId, weeks: 2, stops: 40, sales: 3 });
    materialisePayrollRuns(srv.db);
    syncInvoices(srv.db);
    [admin, leader, rep] = await Promise.all((['admin', 'leader', 'rep'] as const).map((r) => srv.login(r)));
    lastWeek = addDays(mondayOf(fx.today), -7);
  });
  afterEach(() => srv.close());

  test('not VAT registered: no VAT on the invoice, and the summary says nothing about VAT', async () => {
    const inv = await invoiceOf(rep, runIdOf(fx.users.rep, lastWeek));
    assert.equal(inv.vat, null);
    assert.equal(inv.supplier.vatNumber, null);
    const runs = (await admin.get('/finance/payroll')).json as Json[];
    const row = runs.find((r) => r.id === runIdOf(fx.users.rep, lastWeek));
    assert.ok(row.invoice);
    assert.ok(!('vatAmount' in row.invoice));
  });

  test('registering for VAT: 20% on the total, rounded down to the penny, HMRC wording, a new version to accept', async () => {
    const runId = runIdOf(fx.users.rep, lastWeek);
    const before = await invoiceOf(rep, runId);
    assert.equal(before.status, 'issued');
    const saved = await rep.put('/invoices/profile', { vatNumber: 'GB 000 0000 00' });
    assert.equal(saved.status, 200, JSON.stringify(saved.json));
    const inv = await invoiceOf(rep, runId);
    assert.equal(inv.version, before.version + 1, 'what is paid changed: the person accepts again');
    assert.equal(inv.status, 'issued');
    assert.equal(inv.supplier.vatNumber, 'GB000000000');
    assert.equal(inv.total, before.total, 'the total before VAT is the week’s pay');
    assert.deepEqual(inv.vat, {
      net: inv.total,
      ratePercent: 20,
      vat: expectedVat(inv.total),
      gross: penceToPounds(poundsToPence(inv.total) + vatPence(poundsToPence(inv.total), 20)),
      statement: SELF_BILLING_VAT_STATEMENT,
    });
    assert.equal(SELF_BILLING_VAT_STATEMENT, 'The VAT shown is your output tax due to HMRC.');
    // the team leader sees the VAT too (it is part of the amount), not the address
    const asLeader = await invoiceOf(leader, runId);
    assert.equal(asLeader.vat?.vat, inv.vat!.vat);
    // the payroll row carries it for the office
    const row = ((await admin.get('/finance/payroll')).json as Json[]).find((r) => r.id === runId);
    assert.equal(row.invoice.vatAmount, inv.vat!.vat);
    // recorded as an automatic step
    assert.ok(all<{ summary: string }>(srv.db, `SELECT summary FROM audit_log WHERE action = 'SYSTEM invoices.reissue'`).some((r) => /VAT registration/.test(r.summary)));
    // a new VAT number (still registered) changes no amount: no new version
    assert.equal((await rep.put('/invoices/profile', { vatNumber: 'GB000000001' })).status, 200);
    const again = await invoiceOf(rep, runId);
    assert.equal(again.version, inv.version);
    assert.equal(again.supplier.vatNumber, 'GB000000001');
    // stopping: VAT goes, a new version again
    assert.equal((await rep.put('/invoices/profile', { vatNumber: '' })).status, 200);
    const stopped = await invoiceOf(rep, runId);
    assert.equal(stopped.vat, null);
    assert.equal(stopped.version, inv.version + 1);
  });

  test('the payroll spreadsheet has the VAT, the total to pay and the invoice number (MON-4)', async () => {
    const runId = runIdOf(fx.users.rep, lastWeek);
    assert.equal((await rep.put('/invoices/profile', { vatNumber: 'GB000000000' })).status, 200);
    const inv = await invoiceOf(rep, runId);
    const csv = String((await admin.get(`/finance/payroll/export?weekStart=${lastWeek}&people=self_billed`)).json);
    const line = csv.split('\r\n').find((l) => l.startsWith('Remy Rep,'))!;
    const cells = line.split(',');
    assert.equal(cells[11], inv.total.toFixed(2), 'gross pay');
    assert.equal(cells[12], inv.vat!.vat.toFixed(2), 'VAT');
    assert.equal(cells[13], inv.vat!.gross.toFixed(2), 'total to pay');
    assert.equal(cells[14], inv.number);
    assert.match(all<{ summary: string }>(srv.db, `SELECT summary FROM audit_log WHERE action = 'GET /finance/payroll/export'`)[0]!.summary, /^Exported the payroll spreadsheet \(CSV\): .*self-employed \(self-billed\) only, £[\d,.]+ to pay$/);
  });

  test('an invoice already accepted keeps what was accepted', async () => {
    const runId = runIdOf(fx.users.rep, lastWeek);
    assert.equal((await rep.post('/invoices/agreement/accept', {})).status, 200);
    const inv = await invoiceOf(rep, runId);
    const accepted = await rep.post(`/invoices/${inv.id}/accept`, {});
    assert.equal(accepted.status, 200, JSON.stringify(accepted.json));
    assert.equal((await rep.put('/invoices/profile', { vatNumber: 'GB000000000' })).status, 200);
    const after = await invoiceOf(rep, runId);
    assert.equal(after.status, 'accepted');
    assert.equal(after.version, inv.version);
    assert.equal(after.vat, null, 'accepted without VAT: it stays so (tell the office)');
    assert.equal(after.supplier.vatNumber, null);
  });

  test('the payment pays the total with VAT, in exact pence', async () => {
    const runId = runIdOf(fx.users.rep, lastWeek);
    assert.equal((await rep.put('/invoices/profile', { vatNumber: 'GB000000000' })).status, 200);
    assert.equal((await rep.post('/invoices/agreement/accept', {})).status, 200);
    const inv = await invoiceOf(rep, runId);
    assert.equal((await rep.post(`/invoices/${inv.id}/accept`, {})).status, 200);
    const at = new Date(businessNow().getTime() - 86_400_000).toISOString();
    run(
      srv.db,
      `INSERT INTO bank_accounts (user_id, holder_name, sort_code_enc, account_number_enc, last4, sort_code_last2, changed_at, changed_by, confirmed_by_admin_at, confirmed_by)
       VALUES (?, 'Remy Rep', ?, ?, '0001', '00', ?, ?, ?, ?)`,
      [fx.users.rep, encrypt('000000'), encrypt('00000001'), at, fx.users.rep, at, fx.users.admin],
    );
    const conn = (await admin.post('/payments/connections', { provider: 'bank_file', settings: { format: 'starling' } })).json.id;
    assert.equal((await admin.patch(`/payments/connections/${conn}`, { mode: 'live', confirm: PAYMENT_LIVE_CONFIRMATION })).status, 200);
    const draft = await admin.post('/payments/batches', { connectionId: conn, runIds: [runId] });
    assert.equal(draft.status, 201, JSON.stringify(draft.json));
    const item = (draft.json.items as Json[])[0];
    assert.equal(item.amountPence, poundsToPence(inv.total) + vatPence(poundsToPence(inv.total), 20));
    const sent = await admin.post(`/payments/batches/${draft.json.id}/approve`, { code: currentCode(srv.db, fx.users.admin) });
    assert.equal(sent.status, 200, JSON.stringify(sent.json));
    const file = String((await admin.get(`/payments/batches/${draft.json.id}/file`)).json);
    assert.ok(file.includes((item.amountPence / 100).toFixed(2)), file);
    const marked = await admin.post(`/payments/batches/${draft.json.id}/mark-paid`, {});
    assert.equal(marked.status, 200, JSON.stringify(marked.json));
    assert.equal(marked.json.items[0].note ?? null, null, 'no "the week now comes to" note: VAT is part of what was due');
  });
});
