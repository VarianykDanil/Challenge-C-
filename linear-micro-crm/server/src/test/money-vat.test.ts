/**
 * MON-7: VAT on self-billed invoices. A supplier whose VAT number the office has checked is charged VAT at the standard
 * rate on the invoice total (rounded down to the penny); the invoice carries HMRC's sentence for self-billed invoices
 * and the supplier's VAT number, and the payment pays the total with VAT. When VAT starts or stops, the open invoices
 * are reissued for the person to accept again; an invoice already accepted, or counting as accepted, keeps what was
 * accepted.
 *
 * A VAT number moves money, so nobody adds VAT to their own pay (the review's blocking finding): a number someone types
 * in (themselves, or an administrator for them) waits, with no VAT, until an administrator who is not that person
 * confirms it with a fresh two-step code, after checking it on HMRC's "Check a UK VAT number" service. The number must
 * pass HMRC's check digits. Taking a number off is at once (it only lowers what is paid).
 * VAT numbers here are HMRC's published example numbers (GB 999 9999 73) or made up to pass the check digits: the
 * repository is public.
 */
import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { PAYMENT_LIVE_CONFIRMATION, SELF_BILLING_VAT_STATEMENT, penceToPounds, poundsToPence, vatPence, type Invoice } from '@lm/shared';
import { all, get, run } from '../db/connection.ts';
import { materialisePayrollRuns } from '../db/maintenance.ts';
import { createSchema } from '../db/schema.ts';
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

/** HMRC's published example VAT number, and a second one made up to pass the newer (9755) check digits. */
const VAT_A = 'GB999999973';
const VAT_B = 'GB999999918';

const runIdOf = (userId: number, week: string) => get<{ id: number }>(srv.db, `SELECT id FROM payroll_runs WHERE user_id = ? AND week_start = ?`, [userId, week])!.id;
const invoiceOf = async (c: TestClient, runId: number) => {
  const r = await c.get(`/invoices/by-run/${runId}`);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json as Invoice;
};
const expectedVat = (total: number) => penceToPounds(vatPence(poundsToPence(total), 20));
const code = () => currentCode(srv.db, fx.users.admin);
/** The office confirms the rep's VAT number (checked with HMRC). */
const confirmVat = (vatNumber: string, userId = fx.users.rep) => admin.post(`/invoices/profile/${userId}/vat/confirm`, { vatNumber, code: code() });
const attentionKeys = async (c: TestClient) => ((await c.get('/me/attention')).json as Json[] | { items: Json[] });

async function keysOf(c: TestClient): Promise<string[]> {
  const a = await attentionKeys(c);
  return (Array.isArray(a) ? a : a.items).map((i) => String(i.key));
}

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
    assert.equal((await rep.get('/invoices/profile')).json.vat.status, 'none');
  });

  test('HMRC check digits: a made-up number is refused, a real-looking one is kept', async () => {
    for (const bad of ['GB 000 0000 00', 'GB000000000', 'GB123456789', 'FR123']) {
      const r = await rep.put('/invoices/profile', { vatNumber: bad });
      assert.equal(r.status, 400, bad);
      assert.match(r.json.error, /VAT number/);
    }
    for (const good of ['GB 999 9999 73', '999999918', 'GB999999973001']) {
      assert.equal((await rep.put('/invoices/profile', { vatNumber: good })).status, 200, good);
    }
  });

  test('the review probe: a rep typing a VAT number changes nothing paid until a different person (the office) confirms it', async () => {
    const runId = runIdOf(fx.users.rep, lastWeek);
    const before = await invoiceOf(rep, runId);
    assert.equal(before.status, 'issued');
    const saved = await rep.put('/invoices/profile', { vatNumber: 'GB 999 9999 73' });
    assert.equal(saved.status, 200, JSON.stringify(saved.json));
    assert.equal(saved.json.vatNumber, VAT_A);
    assert.equal(saved.json.vat.status, 'waiting');
    assert.ok(saved.json.vat.changedAt);
    assert.equal(saved.json.vat.changedByName, 'Remy Rep');
    // nothing paid changes yet: same version, no VAT, nothing on the payroll row
    const waiting = await invoiceOf(rep, runId);
    assert.equal(waiting.version, before.version);
    assert.equal(waiting.vat, null);
    assert.equal(waiting.total, before.total);
    const row = ((await admin.get('/finance/payroll')).json as Json[]).find((r) => r.id === runId);
    assert.ok(!('vatAmount' in row.invoice));
    // the office is told; nobody but an administrator can confirm, and never the person
    assert.ok((await keysOf(admin)).some((k) => k.startsWith(`invoices:vat:${fx.users.rep}:`)));
    assert.ok(!(await keysOf(rep)).some((k) => k.startsWith('invoices:vat:')));
    for (const who of [rep, leader, await srv.login('client')]) {
      assert.equal((await who.post(`/invoices/profile/${fx.users.rep}/vat/confirm`, { vatNumber: VAT_A })).status, 403);
    }
    assert.equal((await srv.anon().post(`/invoices/profile/${fx.users.rep}/vat/confirm`, { vatNumber: VAT_A })).status, 401);
    // the office: a fresh code, and the number it checked (a number changed meanwhile is not confirmed)
    assert.equal((await admin.post(`/invoices/profile/${fx.users.rep}/vat/confirm`, { vatNumber: VAT_A })).status, 400);
    assert.equal((await confirmVat(VAT_B)).status, 409);
    const confirmed = await confirmVat('GB 999 9999 73');
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.json));
    assert.equal(confirmed.json.vat.status, 'confirmed');
    assert.equal(confirmed.json.vat.confirmedByName, 'Ada Admin');
    assert.ok(!(await keysOf(admin)).some((k) => k.startsWith('invoices:vat:')), 'the item goes once confirmed');
    // now VAT is charged: a new version to accept, 20% rounded down to the penny, HMRC's sentence
    const inv = await invoiceOf(rep, runId);
    assert.equal(inv.version, before.version + 1, 'what is paid changed: the person accepts again');
    assert.equal(inv.status, 'issued');
    assert.equal(inv.supplier.vatNumber, VAT_A);
    assert.equal(inv.total, before.total, 'the total before VAT is the week’s pay');
    assert.deepEqual(inv.vat, {
      net: inv.total,
      ratePercent: 20,
      vat: expectedVat(inv.total),
      gross: penceToPounds(poundsToPence(inv.total) + vatPence(poundsToPence(inv.total), 20)),
      statement: SELF_BILLING_VAT_STATEMENT,
    });
    assert.equal(SELF_BILLING_VAT_STATEMENT, 'The VAT shown is your output tax due to HMRC.');
    const asLeader = await invoiceOf(leader, runId);
    assert.equal(asLeader.vat?.vat, inv.vat!.vat);
    const row2 = ((await admin.get('/finance/payroll')).json as Json[]).find((r) => r.id === runId);
    assert.equal(row2.invoice.vatAmount, inv.vat!.vat);
    // the trail: who confirmed it, and the automatic reissue
    const trail = all<{ summary: string }>(srv.db, `SELECT summary FROM audit_log WHERE action = 'POST /invoices/profile/:userId/vat/confirm'`);
    assert.equal(trail.length, 1);
    assert.match(trail[0]!.summary, /Confirmed Remy Rep's VAT number GB 999 9999 73/);
    assert.ok(all<{ summary: string }>(srv.db, `SELECT summary FROM audit_log WHERE action = 'SYSTEM invoices.reissue'`).some((r) => /VAT/.test(r.summary)));
    // a different number waits again: VAT comes off until the office checks the new one
    const changed = await rep.put('/invoices/profile', { vatNumber: VAT_B });
    assert.equal(changed.json.vat.status, 'waiting');
    const off = await invoiceOf(rep, runId);
    assert.equal(off.vat, null);
    assert.equal(off.version, inv.version + 1);
    // taking the number off is at once and needs nobody (it only lowers what is paid)
    assert.equal((await rep.put('/invoices/profile', { vatNumber: '' })).json.vat.status, 'none');
    assert.equal((await invoiceOf(rep, runId)).version, off.version, 'no VAT before or after: nothing to accept again');
  });

  test('an administrator typing in someone’s VAT number waits too; nobody confirms a number they typed or their own', async () => {
    const admin2Id = run(
      srv.db,
      `INSERT INTO users (employee_id, email, first_name, last_name, role, position, team_id, pay_plan_id, start_date, status, phone, avatar_color, city)
       VALUES ('FX-0009', 'abe.admin@fixture.test', 'Abe', 'Admin', 'admin', 'assistant_owner', NULL, ?, ?, 'active', NULL, '#4F46E5', 'Manchester')`,
      [fx.plans.owner, addDays(fx.today, -365)],
    ).lastInsertRowid;
    const admin2 = await srv.login({ email: 'abe.admin@fixture.test', employeeId: 'FX-0009' });
    const typed = await admin.put(`/invoices/profile/${fx.users.rep}`, { vatNumber: VAT_A });
    assert.equal(typed.status, 200, JSON.stringify(typed.json));
    assert.equal(typed.json.vat.status, 'waiting');
    assert.equal(typed.json.vat.changedByName, 'Ada Admin');
    assert.equal((await invoiceOf(rep, runIdOf(fx.users.rep, lastWeek))).vat, null);
    // the administrator who typed it in cannot confirm it (and keeps their code); a second administrator can
    const self = await confirmVat(VAT_A);
    assert.equal(self.status, 403, JSON.stringify(self.json));
    assert.match(self.json.error, /You typed this VAT number in, so another administrator confirms it/);
    const raw = await attentionKeys(admin2);
    const item = (Array.isArray(raw) ? raw : raw.items).find((i) => String(i.key).startsWith(`invoices:vat:${fx.users.rep}:`));
    assert.ok(item, 'the second administrator is told');
    assert.match(String(item.body), /Ada Admin typed in VAT number GB 999 9999 73 for Remy/);
    assert.equal(item.href, `/team/${fx.users.rep}#invoice-details`);
    const byOther = await admin2.post(`/invoices/profile/${fx.users.rep}/vat/confirm`, { vatNumber: VAT_A, code: currentCode(srv.db, admin2Id) });
    assert.equal(byOther.status, 200, JSON.stringify(byOther.json));
    assert.equal(byOther.json.vat.confirmedByName, 'Abe Admin');
    assert.ok((await invoiceOf(rep, runIdOf(fx.users.rep, lastWeek))).vat, 'VAT once a different administrator confirmed it');
    // an administrator's own number: another administrator confirms it; their own feed does not ask them to
    assert.equal((await admin.put('/invoices/profile', { vatNumber: VAT_B })).status, 200);
    assert.ok(!(await keysOf(admin)).some((k) => k.startsWith(`invoices:vat:${fx.users.admin}:`)));
    assert.ok((await keysOf(admin2)).some((k) => k.startsWith(`invoices:vat:${fx.users.admin}:`)));
    const own = await confirmVat(VAT_B, fx.users.admin);
    assert.equal(own.status, 403, JSON.stringify(own.json));
    assert.match(own.json.error, /another administrator/);
    assert.equal((await admin2.post(`/invoices/profile/${fx.users.admin}/vat/confirm`, { vatNumber: VAT_B, code: currentCode(srv.db, admin2Id) })).status, 200);
  });

  test('an invoice already accepted, or counting as accepted, keeps what was accepted', async () => {
    const runId = runIdOf(fx.users.rep, lastWeek);
    assert.equal((await rep.post('/invoices/agreement/accept', {})).status, 200);
    const inv = await invoiceOf(rep, runId);
    assert.equal((await rep.post(`/invoices/${inv.id}/accept`, {})).status, 200);
    // the other week's invoice is past its deadline (it counts as accepted) but the job has not marked it yet
    const otherRun = runIdOf(fx.users.rep, addDays(lastWeek, -7));
    const other = await invoiceOf(rep, otherRun);
    run(srv.db, `UPDATE invoices SET deem_at = '2000-01-03T12:00:00' WHERE id = ?`, [other.id]);
    assert.equal((await rep.put('/invoices/profile', { vatNumber: VAT_A })).status, 200);
    assert.equal((await confirmVat(VAT_A)).status, 200);
    const after = await invoiceOf(rep, runId);
    assert.equal(after.status, 'accepted');
    assert.equal(after.version, inv.version);
    assert.equal(after.vat, null, 'accepted without VAT: it stays so (tell the office)');
    // a later change of address refreshes the open invoice's address, never its VAT
    assert.equal((await rep.put('/invoices/profile', { addressLine1: '1 New Street' })).status, 200);
    const deemed = await invoiceOf(rep, otherRun);
    assert.equal(deemed.version, other.version);
    assert.equal(deemed.vat, null, 'counting as accepted without VAT: no VAT added by a later refresh');
  });

  test('the payment pays the total with VAT, in exact pence', async () => {
    const runId = runIdOf(fx.users.rep, lastWeek);
    assert.equal((await rep.put('/invoices/profile', { vatNumber: VAT_A })).status, 200);
    assert.equal((await confirmVat(VAT_A)).status, 200);
    assert.equal((await rep.post('/invoices/agreement/accept', {})).status, 200);
    const inv = await invoiceOf(rep, runId);
    assert.ok(inv.vat);
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
    const sent = await admin.post(`/payments/batches/${draft.json.id}/approve`, { code: code() });
    assert.equal(sent.status, 200, JSON.stringify(sent.json));
    const file = String((await admin.get(`/payments/batches/${draft.json.id}/file`)).json);
    assert.ok(file.includes((item.amountPence / 100).toFixed(2)), file);
    const marked = await admin.post(`/payments/batches/${draft.json.id}/mark-paid`, {});
    assert.equal(marked.status, 200, JSON.stringify(marked.json));
    assert.equal(marked.json.items[0].note ?? null, null, 'no "the week now comes to" note: VAT is part of what was due');
  });

  test('the payroll spreadsheet has the VAT, the total to pay and the invoice number (MON-4)', async () => {
    const runId = runIdOf(fx.users.rep, lastWeek);
    assert.equal((await rep.put('/invoices/profile', { vatNumber: VAT_A })).status, 200);
    assert.equal((await confirmVat(VAT_A)).status, 200);
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

  test('upgrading a 1.4.0 database: a VAT number typed in 1.4.0 adds no VAT until the office confirms it', async () => {
    const runId = runIdOf(fx.users.rep, lastWeek);
    // 1.4.0: the person typed a number (no money effect then), and an invoice was accepted printing it
    assert.equal((await rep.post('/invoices/agreement/accept', {})).status, 200);
    const inv = await invoiceOf(rep, runId);
    assert.equal((await rep.post(`/invoices/${inv.id}/accept`, {})).status, 200);
    const db = srv.db;
    run(db, `UPDATE users SET vat_number = ? WHERE id = ?`, [VAT_A, fx.users.rep]);
    run(db, `UPDATE invoices SET supplier_json = json_set(supplier_json, '$.vatNumber', ?) WHERE user_id = ?`, [VAT_A, fx.users.rep]);
    run(db, `UPDATE invoices SET supplier_json = json_remove(supplier_json, '$.vatCharged') WHERE user_id = ?`, [fx.users.rep]);
    for (const c of ['vat_changed_at', 'vat_changed_by', 'vat_confirmed_at', 'vat_confirmed_by']) {
      try { db.exec(`ALTER TABLE users DROP COLUMN ${c}`); } catch { /* not there */ }
    }
    const changed = createSchema(db);
    assert.ok(changed.includes('invoices:users.vat_confirmed_at'), JSON.stringify(changed));
    assert.deepEqual(createSchema(db).filter((c) => c.startsWith('invoices:')), [], 'a second start changes nothing');
    // the accepted invoice printed the number but charged no VAT, and still charges none
    const after = await invoiceOf(rep, runId);
    assert.equal(after.supplier.vatNumber, VAT_A);
    assert.equal(after.vat, null);
    const row = ((await admin.get('/finance/payroll')).json as Json[]).find((r) => r.id === runId);
    assert.ok(!('vatAmount' in row.invoice));
    // the number waits for the office, who is told
    assert.equal((await rep.get('/invoices/profile')).json.vat.status, 'waiting');
    assert.ok((await keysOf(admin)).some((k) => k.startsWith(`invoices:vat:${fx.users.rep}:`)));
  });
});
