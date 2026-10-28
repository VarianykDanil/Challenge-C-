/**
 * P2 invoices: every /invoices route for every role (anonymous, client, rep, leader, recruiter, admin), the finance
 * hooks (invoice summaries on payroll rows, Mark paid gated on acceptance with the admin's override), the job's issue /
 * refresh / reissue / deem steps, the attention items, the audit rows and the demo seed. The business clock is pinned
 * to Wed 21 Oct 2026, 15:00 London; the first job tick ran on Tue 20 Oct at 09:00. Last week (w/c 12 Oct) is paid on
 * Fri 23 Oct, so its invoices count as accepted at 12:00 Thu 22 Oct; the week before (payday Fri 16 Oct, gone) is
 * invoiced late, so its invoices get 24 hours (until Wed 21 Oct 09:00) and then count as accepted.
 *
 * Line checks go by kind, amount and paid flag, never by wording: with P1's breakdown the lines read "4 days × £60.00",
 * "FXC: 12 subs × £45.00"; with the stored run they read "Base: 4 days × £60.00" — the same invoice either way.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SELF_BILLING_AGREEMENT_VERSION, invoiceLinesTotal, type Invoice, type InvoiceLine } from '@lm/shared';
import { all, get, openDb, run, type Db } from '../db/connection.ts';
import { createSchema } from '../db/schema.ts';
import { extension as invoicesExtension } from '../db/extensions/invoices.ts';
import { materialisePayrollRuns } from '../db/maintenance.ts';
import { addDays, setBusinessClock } from '../lib/dates.ts';
import { syncInvoices, NOT_ACCEPTED_MESSAGE } from '../lib/invoices.ts';
import { addHistory, startTestServer, type Json, type TestClient, type TestServer } from './helpers.ts';

const WEDNESDAY = new Date('2026-10-21T15:00:00');
setBusinessClock(WEDNESDAY);
const LAST_WEEK = '2026-10-12';
const WEEK_BEFORE = '2026-10-05';
/** The first job tick: Tue 20 Oct 09:00, the day before the pinned clock. */
const TUESDAY_9 = new Date('2026-10-20T09:00:00');

const uploads = mkdtempSync(path.join(os.tmpdir(), 'lm-p2-uploads-'));
process.env.LM_UPLOADS_DIR = uploads;

let srv: TestServer;
let admin: TestClient;
let leader: TestClient;
let rep: TestClient;
let repA2: TestClient;
let repB: TestClient;
let recruiter: TestClient;
let client: TestClient;
const fx = () => srv.fixture!;
const db = (): Db => srv.db;

const runOf = (userId: number, weekStart: string) => get<{ id: number; gross: number; status: string }>(db(), `SELECT id, gross, status FROM payroll_runs WHERE user_id = ? AND week_start = ?`, [userId, weekStart])!;
const invoiceOfRun = (runId: number) => get<{ id: number; number: string; status: string; version: number; total: number; deemAt: string }>(db(), `SELECT id, number, status, version, total, deem_at AS deemAt FROM invoices WHERE payroll_run_id = ?`, [runId]);
const invoiceOfRunLines = (runId: number) => JSON.parse(get<{ l: string }>(db(), `SELECT lines_json AS l FROM invoices WHERE payroll_run_id = ?`, [runId])!.l) as InvoiceLine[];
/** The paid lines as [kind, amount] (the wording depends on whether P1's breakdown is there). */
const paidLines = (lines: InvoiceLine[]) => lines.filter((l) => l.paid).map((l) => [l.kind, l.amount] as const);
const auditRows = (action: string) => all<{ summary: string; entity: string | null; entityId: number | null; after: string | null }>(db(), `SELECT summary, entity, entity_id AS entityId, after_json AS after FROM audit_log WHERE action = ? ORDER BY id`, [action]);

before(async () => {
  srv = await startTestServer();
  const f = srv.fixture!;
  // two completed weeks of work: three reps and the leader of team A (the recruiter is paid Mon–Fri automatically)
  addHistory(db(), { userId: f.users.rep, teamId: f.teams.a, campaignId: f.campaignId, weeks: 2, stops: 40, sales: 3 }); // 4 days × £60 + 12 × £45 + £75 bonus = £855
  addHistory(db(), { userId: f.users.repA2, teamId: f.teams.a, campaignId: f.campaignId, weeks: 2, daysPerWeek: 3, stops: 30, sales: 2 }); // 3 × £60 + 6 × £45 = £450
  addHistory(db(), { userId: f.users.repB, teamId: f.teams.b, campaignId: f.campaignId, weeks: 2, daysPerWeek: 2, stops: 30, sales: 1 }); // 2 × £60 + 2 × £45 = £210
  addHistory(db(), { userId: f.users.leader, teamId: f.teams.a, campaignId: f.campaignId, weeks: 2, daysPerWeek: 2, stops: 30, sales: 2 });
  materialisePayrollRuns(db());
  [admin, leader, rep, repA2, repB, recruiter, client] = await Promise.all([
    srv.login('admin'), srv.login('leader'), srv.login('rep'), srv.login('repA2'), srv.login('repB'), srv.login('recruiter'), srv.login('client'),
  ]);
});

after(async () => {
  await srv.close();
  setBusinessClock(null);
  rmSync(uploads, { recursive: true, force: true });
});

/** Every /invoices route: [method, path]. */
const ROUTES = (): [string, string][] => [
  ['GET', '/invoices'], ['GET', '/invoices/agreement'], ['POST', '/invoices/agreement/accept'],
  ['GET', '/invoices/profile'], ['PUT', '/invoices/profile'], ['GET', `/invoices/profile/${fx().users.rep}`], ['PUT', `/invoices/profile/${fx().users.rep}`],
  ['GET', '/invoices/company'], ['PUT', '/invoices/company'], ['GET', '/invoices/signatures/0123456789abcdef.png'], ['GET', '/invoices/disputes'],
  ['GET', '/invoices/by-run/1'], ['GET', '/invoices/1'], ['POST', '/invoices/1/accept'], ['POST', '/invoices/1/dispute'], ['POST', '/invoices/1/resolve'],
];

test('anonymous → 401 and a client account → 403 clientPortalOnly on every /invoices route', async () => {
  const anon = srv.anon();
  for (const [method, p] of ROUTES()) {
    const a = await anon.req(method, p, method === 'GET' ? undefined : {});
    assert.equal(a.status, 401, `anon ${method} ${p}`);
    const c = await client.req(method, p, method === 'GET' ? undefined : {});
    assert.equal(c.status, 403, `client ${method} ${p}`);
    assert.equal(c.json.clientPortalOnly, true, `client ${method} ${p}`);
  }
});

test('the job issues one invoice per unpaid field run (reps, leaders), numbered in order; never for the recruiter', async () => {
  assert.equal(get<{ n: number }>(db(), `SELECT COUNT(*) AS n FROM invoices`)!.n, 0, 'nothing before the job runs');
  const r = syncInvoices(db(), TUESDAY_9);
  assert.equal(r.issued, 8, 'rep, repA2, repB and the leader × 2 weeks');
  assert.equal(r.deemed, 0, 'the week before was invoiced after its payday (Fri 16 Oct): 24 hours to check it, not accepted at once');
  assert.deepEqual(syncInvoices(db(), TUESDAY_9), { issued: 0, reissued: 0, refreshed: 0, deemed: 0 }, 'idempotent');
  const rows = all<{ number: string; userId: number; total: number; gross: number; linesJson: string; deemAt: string; weekStart: string }>(
    db(),
    `SELECT i.number, i.user_id AS userId, i.total, p.gross, i.lines_json AS linesJson, i.deem_at AS deemAt, p.week_start AS weekStart
     FROM invoices i JOIN payroll_runs p ON p.id = i.payroll_run_id ORDER BY i.id`,
  );
  assert.deepEqual(rows.map((x) => x.number), Array.from({ length: 8 }, (_, i) => `LM-SB-2026-${String(i + 1).padStart(6, '0')}`));
  assert.ok(!rows.some((x) => x.userId === fx().users.recruiter), 'office recruiters keep the payslip');
  assert.ok(runOf(fx().users.recruiter, LAST_WEEK), 'the recruiter does have a run');
  for (const x of rows) {
    assert.equal(x.total, x.gross, 'the invoice total is what will be paid');
    assert.equal(invoiceLinesTotal(JSON.parse(x.linesJson) as InvoiceLine[]), x.gross);
    // issued Tue 20 Oct 09:00: last week's by 12:00 Thu 22 Oct; the week before's payday has gone, so 24 hours from issue
    assert.equal(x.deemAt, x.weekStart === LAST_WEEK ? '2026-10-22T12:00:00' : '2026-10-21T09:00:00');
  }
  const repLast = rows.find((x) => x.userId === fx().users.rep && x.weekStart === LAST_WEEK)!;
  assert.equal(repLast.total, 855);
  const repLines = JSON.parse(repLast.linesJson) as InvoiceLine[];
  // 4 days × £60 + 12 sales × £45 + the plan's £75 bonus (the weeks are before the 1.3 rule date)
  assert.deepEqual(paidLines(repLines), [['base', 240], ['commission', 540], ['bonus', 75]]);
  assert.equal(repLines.find((l) => l.kind === 'base')!.quantity, 4);
  assert.equal(repLines.find((l) => l.kind === 'commission')!.quantity, 12);
  assert.equal(auditRows('SYSTEM invoices.issue').length, 2, 'one automatic audit row per week');
  assert.equal(auditRows('SYSTEM invoices.deem').length, 0, 'nothing counted as accepted the moment it was issued');
  assert.deepEqual(
    all<{ status: string }>(db(), `SELECT i.status FROM invoices i JOIN payroll_runs p ON p.id = i.payroll_run_id WHERE p.week_start = ?`, [WEEK_BEFORE]).map((x) => x.status),
    ['issued', 'issued', 'issued', 'issued'],
  );
  // Wed 15:00 (the pinned clock): past those 24 hours, the late week counts as accepted
  assert.deepEqual(syncInvoices(db()), { issued: 0, reissued: 0, refreshed: 0, deemed: 4 });
  assert.deepEqual(syncInvoices(db()), { issued: 0, reissued: 0, refreshed: 0, deemed: 0 }, 'idempotent');
  assert.equal(auditRows('SYSTEM invoices.deem').length, 1, 'the late week, counted as accepted in one tick');
  assert.deepEqual(
    all<{ status: string }>(db(), `SELECT i.status FROM invoices i JOIN payroll_runs p ON p.id = i.payroll_run_id WHERE p.week_start = ?`, [WEEK_BEFORE]).map((x) => x.status),
    ['deemed_accepted', 'deemed_accepted', 'deemed_accepted', 'deemed_accepted'],
  );
});

test('payroll rows carry the invoice summary; runs without an invoice gain no key', async () => {
  const list = await admin.get(`/finance/payroll?from=${WEEK_BEFORE}&to=${LAST_WEEK}`);
  assert.equal(list.status, 200);
  const repRun = list.json.find((r: Json) => r.userId === fx().users.rep && r.weekStart === LAST_WEEK);
  assert.equal(repRun.invoice.status, 'issued');
  assert.equal(repRun.invoice.total, 855);
  assert.equal(repRun.invoice.deemedAcceptedAt, '2026-10-22T12:00:00');
  assert.match(repRun.invoice.number, /^LM-SB-2026-\d{6}$/);
  const recruiterRun = list.json.find((r: Json) => r.userId === fx().users.recruiter && r.weekStart === LAST_WEEK);
  assert.ok(!('invoice' in recruiterRun));
  const mine = await rep.get('/finance/me');
  assert.ok(mine.json.runs.every((r: Json) => r.invoice && r.invoice.total === r.gross));
  const slip = await rep.get(`/finance/payroll/${repRun.id}`);
  assert.equal(slip.json.invoice.id, repRun.invoice.id);
});

test('reading an invoice: admin, the person and their team leader; nobody else', async () => {
  const runId = runOf(fx().users.rep, LAST_WEEK).id;
  const inv = invoiceOfRun(runId)!;
  for (const [who, c, status] of [['admin', admin, 200], ['rep', rep, 200], ['leader', leader, 200], ['repA2', repA2, 403], ['repB', repB, 403], ['recruiter', recruiter, 403]] as const) {
    assert.equal((await c.get(`/invoices/${inv.id}`)).status, status, `${who} /invoices/:id`);
    assert.equal((await c.get(`/invoices/by-run/${runId}`)).status, status, `${who} /invoices/by-run/:runId`);
  }
  const bLeader = runOf(fx().users.repB, LAST_WEEK).id;
  assert.equal((await leader.get(`/invoices/by-run/${bLeader}`)).status, 403, 'another team');
  assert.equal((await admin.get('/invoices/999999')).status, 404);
  assert.equal((await admin.get(`/invoices/by-run/${runOf(fx().users.recruiter, LAST_WEEK).id}`)).status, 404, 'no invoice for the recruiter');
  const full = (await rep.get(`/invoices/${inv.id}`)).json as Invoice;
  assert.equal(full.supplier.name, 'Remy Rep');
  assert.equal(full.customer.name, 'Linear MCR Limited');
  assert.equal(full.selfBillingNote, 'Self-billed invoice issued by Linear MCR Limited on behalf of the supplier under a self-billing agreement.');
  assert.equal(full.signatory.name, 'Ada Admin', 'the owner signs by default');
  assert.equal(full.dueDate, '2026-10-23');
  assert.equal(full.acceptance, null);
  assert.deepEqual(full.actions, { accept: true, dispute: true, resolve: false, markPaidWithReason: false });
  assert.equal(full.agreementAccepted, false);
  const asAdmin = (await admin.get(`/invoices/${inv.id}`)).json as Invoice;
  assert.deepEqual(asAdmin.actions, { accept: false, dispute: false, resolve: false, markPaidWithReason: true });
  assert.ok(!('agreementAccepted' in asAdmin), 'only the supplier is told about their agreement');
  assert.equal(asAdmin.runTotal, 855, 'the office sees the run as it stands');
  assert.equal(asAdmin.figuresChanged, false);
  assert.ok(!('runTotal' in full), 'the person does not need it');
  // the week before counted as accepted at its deadline (24 hours after it was issued late, never before it existed),
  // before Remy had accepted any self-billing agreement: it says so
  const deemed = (await rep.get(`/invoices/by-run/${runOf(fx().users.rep, WEEK_BEFORE).id}`)).json as Invoice;
  assert.equal(deemed.status, 'deemed_accepted');
  assert.equal(deemed.issuedAt, TUESDAY_9.toISOString());
  assert.deepEqual(deemed.acceptance, { by: 'Remy Rep', at: '2026-10-21T09:00:00', deemed: true, withoutAgreement: true });
});

test('GET /invoices: own; leader own team and self; admin all; filters', async () => {
  const mine = await rep.get('/invoices');
  assert.equal(mine.status, 200);
  assert.equal(mine.json.length, 2);
  assert.ok(mine.json.every((r: Json) => r.userId === fx().users.rep && r.payrollRunId && r.userName === 'Remy Rep'));
  assert.equal((await rep.get(`/invoices?userId=${fx().users.repA2}`)).status, 403);
  const team = await leader.get('/invoices');
  assert.deepEqual([...new Set(team.json.map((r: Json) => r.userId))].sort(), [fx().users.leader, fx().users.rep, fx().users.repA2].sort());
  assert.equal((await admin.get('/invoices')).json.length, 8);
  assert.equal((await admin.get(`/invoices?weekStart=${LAST_WEEK}`)).json.length, 4);
  assert.equal((await admin.get('/invoices?status=accepted')).json.length, 0);
  assert.equal((await admin.get('/invoices?status=deemed_accepted')).json.length, 4);
  assert.equal((await admin.get('/invoices?status=nope')).status, 400);
  assert.equal((await recruiter.get('/invoices')).json.length, 0, 'the recruiter has none');
});

test('the agreement: field people accept it once (version, time, IP); office roles are not asked', async () => {
  const a = await rep.get('/invoices/agreement');
  assert.equal(a.status, 200);
  assert.equal(a.json.version, SELF_BILLING_AGREEMENT_VERSION);
  assert.equal(a.json.acceptedAt, null);
  assert.match(a.json.body, /Linear MCR Limited/);
  const accepted = await rep.post('/invoices/agreement/accept');
  assert.equal(accepted.status, 200);
  assert.ok(accepted.json.acceptedAt);
  const again = await rep.post('/invoices/agreement/accept');
  assert.equal(again.json.acceptedAt, accepted.json.acceptedAt, 'the first acceptance stands');
  const row = get<{ ip: string | null; version: string }>(db(), `SELECT ip, version FROM self_billing_agreements WHERE user_id = ?`, [fx().users.rep])!;
  assert.equal(row.version, SELF_BILLING_AGREEMENT_VERSION);
  assert.ok(row.ip, 'the IP is recorded');
  assert.equal(auditRows('POST /invoices/agreement/accept').length, 1, 'one audit row: the second acceptance changed nothing');
  assert.equal((await admin.post('/invoices/agreement/accept')).status, 403);
  assert.equal((await recruiter.post('/invoices/agreement/accept')).status, 403);
  assert.equal((await recruiter.get('/invoices/agreement')).status, 200, 'anyone may read it');
});

test('supplier details: own and (admin) anyone; formats checked; open invoices follow, accepted ones do not', async () => {
  const before = await rep.get('/invoices/profile');
  assert.equal(before.status, 200);
  assert.equal(before.json.invoiced, true);
  assert.equal(before.json.postcode, null);
  const saved = await rep.put('/invoices/profile', { addressLine1: '12 Oak Road', addressTown: 'Manchester', postcode: 'm14 5qt', utr: '12345 67890' });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.postcode, 'M14 5QT');
  assert.equal(saved.json.utr, '1234567890');
  assert.equal(saved.json.vatNumber, null);
  assert.equal((await rep.put('/invoices/profile', { postcode: 'nope' })).status, 400);
  assert.equal((await rep.put('/invoices/profile', { utr: '123' })).status, 400);
  assert.equal((await rep.put('/invoices/profile', { vatNumber: 'FR123' })).status, 400);
  assert.equal((await rep.put('/invoices/profile', { name: 'Someone else' })).status, 400, 'the name is not an invoice detail');
  const inv = (await rep.get(`/invoices/by-run/${runOf(fx().users.rep, LAST_WEEK).id}`)).json as Invoice;
  assert.deepEqual(inv.supplier.addressLines, ['12 Oak Road', 'Manchester']);
  assert.equal(inv.supplier.postcode, 'M14 5QT');
  assert.equal(inv.supplier.utr, '1234567890');
  // the team leader may open the invoice but sees neither the home address nor the UTR; the office sees everything
  const asLeader = (await leader.get(`/invoices/by-run/${runOf(fx().users.rep, LAST_WEEK).id}`)).json as Invoice;
  assert.deepEqual(asLeader.supplier, { name: 'Remy Rep', addressLines: [], postcode: null, utr: null, vatNumber: null, withheld: true });
  assert.equal(asLeader.total, inv.total, 'the lines and total stay');
  const asOffice = (await admin.get(`/invoices/by-run/${runOf(fx().users.rep, LAST_WEEK).id}`)).json as Invoice;
  assert.equal(asOffice.supplier.utr, '1234567890');
  assert.ok(!('withheld' in asOffice.supplier));
  // admin: anyone's; nobody else
  assert.equal((await admin.get(`/invoices/profile/${fx().users.rep}`)).json.utr, '1234567890');
  // changed: a VAT number now charges VAT, and registering reissues the person's open invoices (money-vat.test.ts), so
  // the format check uses the recruiter, who has no invoices, to leave Rita's invoices for the tests below
  const byAdmin = await admin.put(`/invoices/profile/${fx().users.recruiter}`, { addressLine1: '3 Mill Street', postcode: 'SK11AA', vatNumber: 'GB 999 9999 73' });
  assert.equal(byAdmin.status, 200);
  assert.equal(byAdmin.json.vatNumber, 'GB999999973');
  assert.equal(byAdmin.json.postcode, 'SK1 1AA');
  for (const c of [leader, rep, recruiter]) {
    assert.equal((await c.get(`/invoices/profile/${fx().users.repA2}`)).status, 403);
    assert.equal((await c.put(`/invoices/profile/${fx().users.repA2}`, {})).status, 403);
  }
  assert.equal((await admin.get('/invoices/profile/999999')).status, 404);
  const recruiterProfile = await recruiter.get('/invoices/profile');
  assert.equal(recruiterProfile.json.invoiced, false);
  const audit = auditRows('PUT /invoices/profile');
  assert.equal(audit.length, 1, 'failed saves write nothing');
  assert.match(audit[0]!.summary, /^Updated their invoice details: address, town, postcode, UTR$/);
  assert.match(auditRows('PUT /invoices/profile/:userId')[0]!.summary, /^Updated invoice details for Rae Recruiter: address, postcode, VAT number \(the VAT number waits for the office to check it\)$/);
  await rep.put('/invoices/profile', { addressLine1: '12 Oak Road' });
  assert.equal(auditRows('PUT /invoices/profile').length, 1, 'saved unchanged: no row');
});

/** A 1×1 transparent PNG. */
const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

test('Settings → Company: everyone reads it, only the admin saves it; the signature PNG is stored and served', async () => {
  for (const c of [rep, leader, recruiter, admin]) assert.equal((await c.get('/invoices/company')).status, 200);
  for (const c of [rep, leader, recruiter]) assert.equal((await c.put('/invoices/company', { legalName: 'X Ltd' })).status, 403);
  const saved = await admin.put('/invoices/company', {
    legalName: 'Linear MCR Limited', addressLines: ['1 North Parade', 'Parsonage Gardens', 'Manchester'], postcode: 'm3 2bb', companyNumber: '12345678',
    signatoryName: 'Matt Owner', signatureImage: `data:image/png;base64,${PNG_1PX}`,
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.postcode, 'M3 2BB');
  assert.equal(saved.json.companyNumber, '12345678');
  assert.match(saved.json.signatureUrl, /^\/api\/invoices\/signatures\/[a-f0-9]{16}\.png$/);
  const file = saved.json.signatureUrl.split('/').pop();
  const img = await fetch(`${srv.base}/invoices/signatures/${file}`, { headers: { cookie: rep.cookie } });
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/png');
  assert.equal(Buffer.from(await img.arrayBuffer()).toString('base64'), PNG_1PX);
  assert.equal((await rep.get('/invoices/signatures/0000000000000000.png')).status, 404);
  assert.equal((await rep.get('/invoices/signatures/..%2Fapp-secret')).status, 404, 'only content-addressed names');
  // the open invoices print the new customer block and signatory
  const inv = (await rep.get(`/invoices/by-run/${runOf(fx().users.rep, LAST_WEEK).id}`)).json as Invoice;
  assert.equal(inv.customer.companyNumber, '12345678');
  assert.equal(inv.signatory.name, 'Matt Owner');
  assert.equal(inv.signatory.signatureUrl, saved.json.signatureUrl);
  // checks
  assert.equal((await admin.put('/invoices/company', { signatureImage: 'data:image/jpeg;base64,AAAA' })).status, 400);
  assert.equal((await admin.put('/invoices/company', { signatureImage: `data:image/png;base64,${Buffer.from('not a png').toString('base64')}` })).status, 400);
  // bytes that only start like a PNG (the 8-byte signature, then HTML) are refused, and nothing is written
  const filesBefore = readdirSync(uploads).sort();
  const fake = Buffer.concat([Buffer.from(PNG_1PX, 'base64').subarray(0, 8), Buffer.from('<html><script>alert(1)</script></html>')]);
  assert.equal((await admin.put('/invoices/company', { signatureImage: `data:image/png;base64,${fake.toString('base64')}` })).status, 400);
  const truncated = Buffer.from(PNG_1PX, 'base64').subarray(0, 40);
  assert.equal((await admin.put('/invoices/company', { signatureImage: `data:image/png;base64,${truncated.toString('base64')}` })).status, 400, 'no IEND');
  const trailing = Buffer.concat([Buffer.from(PNG_1PX, 'base64'), Buffer.from('<script>')]);
  assert.equal((await admin.put('/invoices/company', { signatureImage: `data:image/png;base64,${trailing.toString('base64')}` })).status, 400, 'bytes after IEND');
  assert.equal((await admin.put('/invoices/company', { legalName: 'Linear MCR Limited', signatureImage: '' })).status, 400, 'an empty image is not "remove"');
  assert.deepEqual(readdirSync(uploads).sort(), filesBefore, 'a refused image leaves no file');
  const big = Buffer.concat([Buffer.from(PNG_1PX, 'base64'), Buffer.alloc(201 * 1024)]).toString('base64');
  assert.equal((await admin.put('/invoices/company', { signatureImage: `data:image/png;base64,${big}` })).status, 400, 'over 200 KB');
  assert.equal((await admin.put('/invoices/company', { companyNumber: '12' })).status, 400);
  assert.equal((await admin.put('/invoices/company', { legalName: '  ' })).status, 400);
  const audit = auditRows('PUT /invoices/company');
  assert.equal(audit.length, 1);
  assert.equal(audit[0]!.entity, 'settings');
  assert.ok(!audit[0]!.after?.includes(PNG_1PX), 'the image bytes never reach the trail');
  const removed = await admin.put('/invoices/company', { signatureImage: null });
  assert.equal(removed.json.signatureUrl, null);
});

test('accept: the supplier only, after the agreement; idempotent; audited', async () => {
  const repInv = invoiceOfRun(runOf(fx().users.rep, LAST_WEEK).id)!;
  const a2Inv = invoiceOfRun(runOf(fx().users.repA2, LAST_WEEK).id)!;
  const noAgreement = await repA2.post(`/invoices/${a2Inv.id}/accept`);
  assert.equal(noAgreement.status, 409);
  assert.equal(noAgreement.json.details.code, 'agreement_required');
  assert.equal((await leader.post(`/invoices/${repInv.id}/accept`)).status, 403, 'not the leader');
  assert.equal((await admin.post(`/invoices/${repInv.id}/accept`)).status, 403, 'not the office');
  assert.equal((await repB.post(`/invoices/${repInv.id}/accept`)).status, 403);
  const ok = await rep.post(`/invoices/${repInv.id}/accept`);
  assert.equal(ok.status, 200);
  assert.equal(ok.json.status, 'accepted');
  assert.equal(ok.json.acceptance.by, 'Remy Rep');
  assert.equal(ok.json.acceptance.deemed, false);
  assert.equal(ok.json.actions.accept, false);
  assert.equal(ok.json.actions.dispute, true, 'still disputable before the deadline');
  const again = await rep.post(`/invoices/${repInv.id}/accept`);
  assert.equal(again.json.acceptedAt, ok.json.acceptedAt);
  const audit = auditRows('POST /invoices/:id/accept');
  assert.equal(audit.length, 1, 'accepting twice writes one row');
  assert.match(audit[0]!.summary, /^Accepted invoice LM-SB-2026-\d{6} \(Remy Rep, w\/c 12 Oct, £855\)$/);
  assert.equal(audit[0]!.entity, 'invoice');
  assert.equal(get<{ ip: string | null }>(db(), `SELECT accepted_ip AS ip FROM invoices WHERE id = ?`, [repInv.id])!.ip !== null, true);
});

test('Mark paid: an accepted invoice pays; an issued one needs a reason (409 says where to go); the override is stored and audited', async () => {
  const accepted = runOf(fx().users.rep, LAST_WEEK).id;
  assert.equal((await admin.post(`/finance/payroll/${accepted}/pay`, {})).status, 200);
  const issued = runOf(fx().users.repB, LAST_WEEK).id;
  const refused = await admin.post(`/finance/payroll/${issued}/pay`, {});
  assert.equal(refused.status, 409);
  assert.equal(refused.json.error, NOT_ACCEPTED_MESSAGE);
  assert.equal(refused.json.error, 'This invoice is not accepted yet. Open the run to mark it paid with a reason.');
  assert.equal(refused.json.details.code, 'invoice_not_accepted');
  assert.equal(runOf(fx().users.repB, LAST_WEEK).status, 'pending', 'nothing paid');
  assert.equal((await admin.post(`/finance/payroll/${issued}/pay`, { overrideReason: 'x' })).status, 400, 'a reason of 3+ characters');
  assert.equal((await admin.post(`/finance/payroll/${issued}/pay`, { overrideReason: 42 })).status, 400);
  const paid = await admin.post(`/finance/payroll/${issued}/pay`, { overrideReason: 'Bo is on holiday and asked to be paid today' });
  assert.equal(paid.status, 200);
  assert.equal(paid.json.status, 'paid');
  const inv = (await admin.get(`/invoices/by-run/${issued}`)).json as Invoice;
  assert.equal(inv.paidOverride?.reason, 'Bo is on holiday and asked to be paid today');
  assert.equal(inv.paidOverride?.byName, 'Ada Admin');
  assert.equal(inv.runStatus, 'paid');
  assert.equal(inv.actions?.markPaidWithReason, false);
  const rows = auditRows('POST /finance/payroll/:id/pay');
  assert.equal(rows.length, 2);
  assert.match(rows[0]!.summary, /^Marked paid: Remy Rep w\/c 12 Oct, £855$/, 'an accepted invoice: the 1.2 wording');
  assert.match(rows[1]!.summary, /^Marked paid: Bo Rep w\/c 12 Oct, £210 without an accepted invoice \(LM-SB-2026-\d{6}\)\. Reason: "Bo is on holiday and asked to be paid today"$/);
  // the paid week can no longer be disputed; it can still be accepted (for the record)
  const paidInv = invoiceOfRun(issued)!;
  assert.equal((await repB.post('/invoices/agreement/accept')).status, 200);
  const late = await repB.post(`/invoices/${paidInv.id}/dispute`, { reason: 'Too late?', lines: [] });
  assert.equal(late.status, 409);
  assert.equal((await repB.post(`/invoices/${paidInv.id}/accept`)).json.status, 'accepted');
});

test('dispute: the supplier says what is wrong; the invoice is held; the office sees the lines and our figures', async () => {
  const runId = runOf(fx().users.repA2, LAST_WEEK).id;
  const inv = invoiceOfRun(runId)!;
  assert.equal((await repA2.post(`/invoices/${inv.id}/dispute`, { reason: '', lines: [] })).status, 400);
  assert.equal((await repA2.post(`/invoices/${inv.id}/dispute`, { reason: 'Wrong', lines: [{ line: 9 }] })).status, 400, 'no line 10');
  assert.equal((await repA2.post(`/invoices/${inv.id}/dispute`, { reason: 'Wrong', lines: [{ line: 0 }, { line: 0 }] })).status, 400);
  assert.equal((await leader.post(`/invoices/${inv.id}/dispute`, { reason: 'Wrong', lines: [] })).status, 403);
  const d = await repA2.post(`/invoices/${inv.id}/dispute`, { reason: 'I made 8 sales, not 6', lines: [{ line: 1, note: '8 sales' }] });
  assert.equal(d.status, 200);
  assert.equal(d.json.status, 'disputed');
  assert.deepEqual(d.json.dispute.lines, [{ line: 1, note: '8 sales' }]);
  assert.equal((await repA2.post(`/invoices/${inv.id}/dispute`, { reason: 'Again', lines: [] })).status, 409);
  assert.equal((await rep.get('/invoices/disputes')).status, 403);
  assert.equal((await leader.get('/invoices/disputes')).status, 403);
  // a client statement confirmed Rita's 6 sales for the week: the dispute links to it
  run(db(), `INSERT INTO sale_confirmations (user_id, campaign_id, week_start, confirmed, statement_id, confirmed_at) VALUES (?, ?, ?, 6, 77, ?)`, [
    fx().users.repA2, fx().campaignId, LAST_WEEK, new Date().toISOString(),
  ]);
  const code = get<{ code: string }>(db(), `SELECT code FROM campaigns WHERE id = ?`, [fx().campaignId])!.code;
  const list = await admin.get('/invoices/disputes');
  assert.equal(list.status, 200);
  assert.equal(list.json.length, 1);
  const row = list.json[0];
  assert.equal(row.userName, 'Rita Rep');
  assert.equal(row.dispute.reason, 'I made 8 sales, not 6');
  // the line as printed on the invoice (P1's wording or the run's), with the person's note
  const printed = ((await admin.get(`/invoices/${inv.id}`)).json as Invoice).lines[1]!;
  assert.equal(printed.kind, 'commission');
  assert.deepEqual(row.disputedLines, [{ line: 1, description: printed.description, amount: 270, paid: true, note: '8 sales' }]);
  assert.deepEqual(row.ours, { total: 450, salesLogged: 6 });
  assert.equal(row.figuresChanged, false);
  assert.deepEqual(row.statements, [{ id: 77, campaignCode: code }]);
  // held until the office resolves it: Mark paid refuses (and says where to resolve it), even with a reason
  const refused = await admin.post(`/finance/payroll/${runId}/pay`, {});
  assert.equal(refused.status, 409);
  assert.equal(refused.json.details.code, 'invoice_disputed');
  assert.match(refused.json.error, /Finance → Company → Disputed invoices:/, 'named as the card is');
  const withReason = await admin.post(`/finance/payroll/${runId}/pay`, { overrideReason: 'Paying now, will sort it out later' });
  assert.equal(withReason.status, 409, 'no "Mark paid anyway" for a disputed invoice');
  assert.equal(withReason.json.details.code, 'invoice_disputed');
  assert.equal(runOf(fx().users.repA2, LAST_WEEK).status, 'pending', 'nothing paid');
  const held = (await admin.get(`/invoices/${inv.id}`)).json as Invoice;
  assert.deepEqual(held.actions, { accept: false, dispute: false, resolve: true, markPaidWithReason: false });
  assert.match(auditRows('POST /invoices/:id/dispute')[0]!.summary, /^Said something's wrong with invoice LM-SB-2026-\d{6} \(Rita Rep, w\/c 12 Oct, £450\): "I made 8 sales, not 6"$/);
});

test('attention: the person sees "Check and accept your invoice" (in the bell, never a toast); the admin sees each dispute', async () => {
  srv.resetCache();
  const repFeed = await rep.get('/me/attention');
  const repKeys = repFeed.json.items.map((i: Json) => i.key as string);
  assert.ok(!repKeys.some((k: string) => k.startsWith('invoices:open:')), 'accepted, and counted as accepted: nothing to do');
  const leaderLast = invoiceOfRun(runOf(fx().users.leader, LAST_WEEK).id)!;
  const leaderFeed = await leader.get('/me/attention');
  const item = leaderFeed.json.items.find((i: Json) => i.key === `invoices:open:${leaderLast.id}:v1`);
  assert.ok(item, 'the leader still has last week\'s to accept');
  assert.equal(item.kind, 'invoices');
  // info, even under 24 hours to the deadline: a warning toast covered the open invoice's own buttons on phones
  assert.equal(item.severity, 'info');
  assert.equal(item.title, 'Check and accept your invoice by 12:00 Thu 22 Oct');
  assert.match(item.body, /by 12:00 Thu 22 Oct/);
  const adminFeed = await admin.get('/me/attention');
  const dispute = invoiceOfRun(runOf(fx().users.repA2, LAST_WEEK).id)!;
  const adminItem = adminFeed.json.items.find((i: Json) => i.key === `invoices:dispute:${dispute.id}:v1`);
  assert.equal(adminItem.title, "Rita Rep says something's wrong");
  assert.equal(adminItem.href, '/finance?tab=company#disputes');
  const waiting = adminFeed.json.items.find((i: Json) => String(i.key).startsWith('invoices:waiting:'));
  assert.ok(waiting && waiting.count >= 1, 'the day before the deadline: how many are still waiting');
  const recruiterFeed = await recruiter.get('/me/attention');
  assert.ok(!recruiterFeed.json.items.some((i: Json) => i.kind === 'invoices'));
});

test('resolve: admin only, disputed only; "Keep as it is" makes it payable with the note the person sees', async () => {
  const runId = runOf(fx().users.leader, LAST_WEEK).id;
  const inv = invoiceOfRun(runId)!;
  assert.equal((await admin.post(`/invoices/${inv.id}/resolve`, { action: 'keep', note: 'Checked' })).status, 409, 'not disputed');
  assert.equal((await leader.post('/invoices/agreement/accept')).status, 200);
  assert.equal((await leader.post(`/invoices/${inv.id}/dispute`, { reason: 'My override is missing', lines: [] })).status, 200);
  for (const c of [leader, rep, recruiter]) assert.equal((await c.post(`/invoices/${inv.id}/resolve`, { action: 'keep', note: 'Checked' })).status, 403);
  assert.equal((await admin.post(`/invoices/${inv.id}/resolve`, { action: 'keep', note: '' })).status, 400);
  assert.equal((await admin.post(`/invoices/${inv.id}/resolve`, { action: 'keep', note: 'Checked', adjustment: { amount: 10 } })).status, 400, 'a correction needs a reissue');
  const kept = await admin.post(`/invoices/${inv.id}/resolve`, { action: 'keep', note: 'Overrides stopped on 1 October: the invoice is right.' });
  assert.equal(kept.status, 200);
  assert.equal(kept.json.status, 'resolved');
  assert.equal(kept.json.resolution.action, 'keep');
  assert.equal(kept.json.resolution.byName, 'Ada Admin');
  const seen = (await leader.get(`/invoices/${inv.id}`)).json as Invoice;
  assert.equal(seen.resolution?.note, 'Overrides stopped on 1 October: the invoice is right.');
  assert.equal(seen.actions?.accept, true, 'the person may still accept it for the record');
  assert.equal(seen.actions?.dispute, false, 'the office has answered');
  srv.resetCache();
  const feed = await leader.get('/me/attention');
  assert.ok(feed.json.items.some((i: Json) => i.key.startsWith(`invoices:resolved:${inv.id}:`)), 'the office replied');
  assert.equal((await admin.post(`/finance/payroll/${runId}/pay`, {})).status, 200, 'resolved → payable');
  assert.match(auditRows('POST /invoices/:id/resolve')[0]!.summary, /^Kept invoice LM-SB-2026-\d{6} \(Lee Leader, w\/c 12 Oct, £[\d,]+\) as it is: "Overrides stopped/);
});

test('resolve: "Fix and reissue" adds the correction (pay_adjustments, kind dispute) and issues version 2 to accept again', async () => {
  const runId = runOf(fx().users.repA2, LAST_WEEK).id;
  const inv = invoiceOfRun(runId)!;
  const fixed = await admin.post(`/invoices/${inv.id}/resolve`, { action: 'reissue', note: 'Added your two missing sales.', adjustment: { amount: 90, note: '2 missing sales × £45' } });
  assert.equal(fixed.status, 200);
  assert.equal(fixed.json.version, 2);
  assert.equal(fixed.json.status, 'issued');
  assert.equal(fixed.json.number, inv.number, 'same number, new version');
  assert.equal(fixed.json.dispute, null);
  assert.equal(fixed.json.resolution.action, 'reissue');
  assert.equal(fixed.json.previousVersions.length, 1);
  assert.equal(fixed.json.previousVersions[0].status, 'disputed');
  assert.equal(fixed.json.previousVersions[0].disputeReason, 'I made 8 sales, not 6');
  assert.equal(fixed.json.total, runOf(fx().users.repA2, LAST_WEEK).gross, 'the new version is the run as it stands');
  const adj = get<{ kind: string; amount: number; invoiceId: number; target: string; createdBy: number }>(
    db(), `SELECT kind, amount, invoice_id AS invoiceId, target_week_start AS target, created_by AS createdBy FROM pay_adjustments WHERE invoice_id = ?`, [inv.id],
  )!;
  assert.deepEqual({ ...adj }, { kind: 'dispute', amount: 90, invoiceId: inv.id, target: LAST_WEEK, createdBy: fx().users.admin });
  assert.equal((await admin.get('/invoices/disputes')).json.length, 0);
  assert.equal((await admin.post(`/finance/payroll/${runId}/pay`, {})).status, 409, 'version 2 is not accepted yet');
  assert.equal((await repA2.post('/invoices/agreement/accept')).status, 200);
  assert.equal((await repA2.post(`/invoices/${inv.id}/accept`)).json.status, 'accepted');
  assert.match(auditRows('POST /invoices/:id/resolve')[1]!.summary, /^Fixed and reissued invoice LM-SB-2026-\d{6} \(Rita Rep, w\/c 12 Oct, £[\d,.]+\) as version 2 \(was £450\): "Added your two missing sales\."$/);
  // a paid week cannot be reissued
  const paidRun = runOf(fx().users.rep, LAST_WEEK).id;
  run(db(), `UPDATE invoices SET status = 'disputed', disputed_at = ?, dispute_reason = 'x' WHERE payroll_run_id = ?`, [new Date().toISOString(), paidRun]);
  const paidInv = invoiceOfRun(paidRun)!;
  assert.equal((await admin.post(`/invoices/${paidInv.id}/resolve`, { action: 'reissue', note: 'Fix' })).status, 409);
  assert.equal((await admin.post(`/invoices/${paidInv.id}/resolve`, { action: 'keep', note: 'It stands' })).status, 200, 'keep works on a paid week');
});

test('a change that does not move the money refreshes the invoice in place: status, version and acceptance stay', async () => {
  // Rita's week before: counted as accepted. A statement confirms 5 of her 6 sales on a week whose pay does not change.
  const runId = runOf(fx().users.repA2, WEEK_BEFORE).id;
  const before = invoiceOfRun(runId)!;
  assert.equal(before.status, 'deemed_accepted');
  run(db(), `UPDATE payroll_runs SET sales_confirmed = 5, sales_cancelled = 1 WHERE id = ?`, [runId]);
  assert.deepEqual(syncInvoices(db()), { issued: 0, reissued: 0, refreshed: 1, deemed: 0 });
  const after = invoiceOfRun(runId)!;
  assert.deepEqual({ status: after.status, version: after.version, total: after.total, deemAt: after.deemAt }, { status: before.status, version: 1, total: before.total, deemAt: before.deemAt });
  assert.deepEqual(syncInvoices(db()), { issued: 0, reissued: 0, refreshed: 0, deemed: 0 }, 'up to date now');
  assert.match(auditRows('SYSTEM invoices.refresh').at(-1)!.summary, /^Brought invoice LM-SB-2026-\d{6} for Rita Rep \(w\/c 5 Oct\) up to date with the week: what is paid did not change$/);
  // the wording the person had agreed to is kept when a refresh rewrites it (here: an older wording of a paid line)
  const agreedLines = (JSON.parse(get<{ l: string }>(db(), `SELECT lines_json AS l FROM invoices WHERE id = ?`, [after.id])!.l) as InvoiceLine[])
    .map((l) => (l.paid ? { ...l, description: `${l.description} (as first worded)` } : l));
  run(db(), `UPDATE invoices SET lines_json = ? WHERE id = ?`, [JSON.stringify(agreedLines), after.id]);
  run(db(), `UPDATE payroll_runs SET sales_cancelled = 2 WHERE id = ?`, [runId]);
  assert.deepEqual(syncInvoices(db()), { issued: 0, reissued: 0, refreshed: 1, deemed: 0 });
  const kept = all<{ number: string; version: number; status: string; acceptedAt: string; lines: string }>(
    db(), `SELECT number, version, status, accepted_at AS acceptedAt, lines_json AS lines FROM invoice_refreshes WHERE invoice_id = ? ORDER BY id`, [after.id],
  );
  assert.equal(kept.length, 1, 'one record: the lines before this refresh');
  assert.deepEqual({ ...kept[0]!, lines: JSON.parse(kept[0]!.lines) }, {
    number: before.number, version: 1, status: 'deemed_accepted', acceptedAt: new Date('2026-10-21T09:00:00').toISOString(), lines: agreedLines,
  });
  assert.ok(!invoiceOfRunLines(runId).some((l) => l.description.endsWith('(as first worded)')), 'the invoice itself shows the current wording');
  assert.equal(invoiceOfRun(runId)!.status, 'deemed_accepted');
  // an accepted invoice the person reads straight after the change: refreshed on the read, still accepted
  const lastRun = runOf(fx().users.repA2, LAST_WEEK).id;
  const accepted = invoiceOfRun(lastRun)!;
  assert.equal(accepted.status, 'accepted');
  run(db(), `UPDATE payroll_runs SET sales_cancelled = 1 WHERE id = ?`, [lastRun]);
  const read = (await repA2.get(`/invoices/${accepted.id}`)).json as Invoice;
  assert.equal(read.status, 'accepted');
  assert.equal(read.version, accepted.version);
  assert.equal(invoiceOfRun(lastRun)!.status, 'accepted');
});

test('a version issued after the usual deadline gets 24 hours: the person is told what changed and can accept or dispute it', async () => {
  const runId = runOf(fx().users.repA2, LAST_WEEK).id; // version 2, accepted, payday Fri 23 Oct
  const before = invoiceOfRun(runId)!;
  assert.equal(before.status, 'accepted');
  assert.equal(before.total, 540);
  setBusinessClock(new Date('2026-10-22T13:00:00')); // Thu 13:00, after the usual 12:00 deadline
  try {
    run(db(), `UPDATE payroll_runs SET deductions = deductions + 15, gross = gross - 15 WHERE id = ?`, [runId]);
    const r = syncInvoices(db());
    assert.equal(r.reissued, 1);
    const now = invoiceOfRun(runId)!;
    assert.equal(now.version, before.version + 1);
    assert.equal(now.status, 'issued', 'not counted as accepted the moment it was issued');
    assert.equal(now.deemAt, '2026-10-23T13:00:00', '24 hours from the reissue: into payday');
    // Rita is told what changed, and can accept it or say something's wrong
    srv.resetCache();
    const item = (await repA2.get('/me/attention')).json.items.find((i: Json) => i.key === `invoices:open:${now.id}:v${now.version}`);
    assert.ok(item, 'a bell item for the new version');
    assert.equal(item.title, 'Your invoice changed: £525.00 (was £540.00)');
    assert.equal(item.body, "w/c 12 Oct, £525.00. Accept it or say what's wrong by 13:00 Fri 23 Oct; after that it counts as accepted.");
    const seen = (await repA2.get(`/invoices/${now.id}`)).json as Invoice;
    assert.equal(seen.acceptance, null);
    assert.deepEqual(seen.actions, { accept: true, dispute: true, resolve: false, markPaidWithReason: false });
    // payday morning: still Rita's to answer, so Mark paid needs her acceptance or the office's reason
    setBusinessClock(new Date('2026-10-23T08:30:00'));
    const refused = await admin.post(`/finance/payroll/${runId}/pay`, {});
    assert.equal(refused.status, 409);
    assert.equal(refused.json.details.code, 'invoice_not_accepted');
    assert.equal(refused.json.details.deemedAcceptedAt, '2026-10-23T13:00:00');
    assert.equal((await repA2.post(`/invoices/${now.id}/accept`)).json.status, 'accepted');
    const paid = await admin.post(`/finance/payroll/${runId}/pay`, {});
    assert.equal(paid.status, 200, 'accepted on payday morning → paid');
    assert.equal(paid.json.status, 'paid');
  } finally {
    setBusinessClock(WEDNESDAY);
  }
});

test('a version issued on or after payday (a statement on Friday, an old failed transfer) is never accepted at once', async () => {
  // Lee's week before: payday Fri 16 Oct has gone (an unpaid transfer). A bonus is added on Fri 23 Oct at 08:30.
  const runId = runOf(fx().users.leader, WEEK_BEFORE).id;
  const before = invoiceOfRun(runId)!;
  assert.equal(before.status, 'deemed_accepted');
  setBusinessClock(new Date('2026-10-23T08:30:00'));
  try {
    run(db(), `UPDATE payroll_runs SET bonus = bonus + 25, gross = gross + 25 WHERE id = ?`, [runId]);
    assert.equal(syncInvoices(db()).reissued, 1);
    const now = invoiceOfRun(runId)!;
    assert.deepEqual({ status: now.status, deemAt: now.deemAt }, { status: 'issued', deemAt: '2026-10-24T08:30:00' });
    setBusinessClock(new Date('2026-10-23T17:00:00'));
    const open = (await leader.get(`/invoices/${now.id}`)).json as Invoice;
    assert.equal(open.status, 'issued');
    assert.equal(open.actions?.dispute, true, "Something's wrong is still there on payday");
    assert.equal((await admin.post(`/finance/payroll/${runId}/pay`, {})).json.details.code, 'invoice_not_accepted');
    // nobody answers: 24 hours after the reissue it counts as accepted — dated then, never before the version existed
    setBusinessClock(new Date('2026-10-24T08:31:00'));
    const deemed = (await leader.get(`/invoices/${now.id}`)).json as Invoice;
    assert.equal(deemed.status, 'deemed_accepted');
    assert.equal(deemed.acceptance?.at, '2026-10-24T08:30:00');
    assert.ok(Date.parse(deemed.issuedAt) < Date.parse('2026-10-24T07:30:00Z'), 'issued before it counted as accepted');
    assert.equal(deemed.acceptance?.withoutAgreement, undefined, 'Lee accepted the agreement on Wed 21 Oct');
    assert.equal(deemed.actions?.dispute, false);
    assert.equal((await admin.post(`/finance/payroll/${runId}/pay`, {})).status, 200);
  } finally {
    setBusinessClock(WEDNESDAY);
  }
});

test('a run whose figures change is reissued (by the job, and before anyone accepts or pays it)', async () => {
  const runId = runOf(fx().users.rep, WEEK_BEFORE).id;
  const inv = invoiceOfRun(runId)!;
  // A later payday (Fri 30 Oct, a transfer to redo), so the new versions' deadline is 12:00 Thu 29 Oct rather than 24
  // hours after each reissue. The due date is not one of the figures, so nothing is reissued for it.
  run(db(), `UPDATE payroll_runs SET due_date = '2026-10-30' WHERE id = ?`, [runId]);
  assert.deepEqual(syncInvoices(db()), { issued: 0, reissued: 0, refreshed: 0, deemed: 0 });
  run(db(), `UPDATE payroll_runs SET deductions = 20, gross = gross - 20 WHERE id = ?`, [runId]);
  const r = await rep.post(`/invoices/${inv.id}/accept`);
  assert.equal(r.status, 409);
  assert.equal(r.json.details.code, 'invoice_reissued');
  const now = invoiceOfRun(runId)!;
  assert.equal(now.version, 2);
  assert.equal(now.total, 835);
  assert.equal(now.deemAt, '2026-10-29T12:00:00', '12:00 the day before the new payday');
  const v2 = (await rep.get(`/invoices/${inv.id}`)).json as Invoice;
  assert.deepEqual(paidLines(v2.lines).at(-1), ['deduction', -20]);
  assert.equal(v2.previousVersions?.[0]?.total, 855);
  assert.equal(v2.previousVersions?.[0]?.status, 'deemed_accepted');
  assert.equal((await rep.post(`/invoices/${inv.id}/accept`)).json.status, 'accepted');
  // the job: a change after acceptance → a new version to accept again
  run(db(), `UPDATE payroll_runs SET bonus = 0, gross = gross - 75 WHERE id = ?`, [runId]);
  assert.deepEqual(syncInvoices(db()), { issued: 0, reissued: 1, refreshed: 0, deemed: 0 });
  assert.equal(invoiceOfRun(runId)!.status, 'issued');
  assert.equal(invoiceOfRun(runId)!.total, 760);
  assert.ok(auditRows('SYSTEM invoices.reissue').length >= 2);
  // and Mark paid does the same first
  run(db(), `UPDATE payroll_runs SET deductions = 0, gross = gross + 20 WHERE id = ?`, [runId]);
  const pay = await admin.post(`/finance/payroll/${runId}/pay`, {});
  assert.equal(pay.status, 409);
  assert.equal(pay.json.details.code, 'invoice_reissued');
  assert.equal(invoiceOfRun(runId)!.version, 4);
});

test('the deadline: after 12:00 the day before payday an issued invoice counts as accepted (read at once, stored by the job)', async () => {
  const runId = runOf(fx().users.rep, WEEK_BEFORE).id; // payday moved to Fri 30 Oct by the test before
  const inv = invoiceOfRun(runId)!;
  assert.equal(inv.status, 'issued');
  setBusinessClock(new Date('2026-10-29T12:00:01'));
  try {
    const seen = (await rep.get(`/invoices/${inv.id}`)).json as Invoice;
    assert.equal(seen.status, 'deemed_accepted', 'read: deemed at once');
    assert.equal(seen.acceptance?.deemed, true);
    assert.equal(seen.acceptance?.at, '2026-10-29T12:00:00');
    assert.equal(seen.acceptance?.withoutAgreement, undefined, 'Remy accepted the agreement on 21 Oct');
    assert.equal(seen.actions?.dispute, false, 'too late to dispute');
    const late = await rep.post(`/invoices/${inv.id}/dispute`, { reason: 'Something', lines: [] });
    assert.equal(late.status, 409);
    assert.equal(late.json.error, 'The time to dispute this invoice passed at 12:00 Thu 29 Oct. Speak to the office: a correction can go on a later week.');
    assert.equal(invoiceOfRun(runId)!.status, 'issued', 'not stored yet');
    const r = syncInvoices(db());
    assert.ok(r.deemed >= 1);
    assert.equal(invoiceOfRun(runId)!.status, 'deemed_accepted');
    assert.ok(auditRows('SYSTEM invoices.deem').length >= 1);
    assert.equal((await admin.post(`/finance/payroll/${runId}/pay`, {})).status, 200, 'deemed accepted → payable');
  } finally {
    setBusinessClock(WEDNESDAY);
  }
});

test('an unpaid run removed (nothing payable any more) takes its invoice with it; the number is kept as void', async () => {
  const runId = runOf(fx().users.repB, WEEK_BEFORE).id;
  // a second version first (£5 taken off), so there is an earlier version to keep
  const v1 = invoiceOfRun(runId)!;
  run(db(), `UPDATE payroll_runs SET deductions = deductions + 5, gross = gross - 5 WHERE id = ?`, [runId]);
  assert.equal(syncInvoices(db()).reissued, 1);
  const inv = invoiceOfRun(runId)!;
  assert.equal(inv.version, 2);
  run(db(), `DELETE FROM payroll_runs WHERE id = ?`, [runId]);
  assert.equal(invoiceOfRun(runId), undefined);
  const voided = get<{ number: string; userId: number; total: number; status: string; reason: string }>(
    db(), `SELECT number, user_id AS userId, total, status, reason FROM invoice_voids WHERE invoice_id = ?`, [inv.id],
  )!;
  assert.deepEqual({ ...voided, reason: undefined }, { number: inv.number, userId: fx().users.repB, total: inv.total, status: inv.status, reason: undefined });
  assert.match(voided.reason, /Removed with its pay run/);
  // the earlier versions are kept with it (invoice_versions itself goes with the invoice)
  const versions = JSON.parse(get<{ v: string }>(db(), `SELECT versions_json AS v FROM invoice_voids WHERE invoice_id = ?`, [inv.id])!.v) as { version: number; total: number; status: string; lines: InvoiceLine[]; replacedReason: string }[];
  assert.deepEqual(versions.map((v) => [v.version, v.total, v.status]), [[1, v1.total, 'deemed_accepted']]);
  assert.equal(invoiceLinesTotal(versions[0]!.lines), v1.total);
  assert.equal(versions[0]!.replacedReason, 'The amounts changed after it was issued');
  assert.equal(get<{ n: number }>(db(), `SELECT COUNT(*) AS n FROM invoice_versions WHERE invoice_id = ?`, [inv.id])!.n, 0);
});

test('the self-service invoice writes are limited to 60 a minute per person (429 after that, not audited)', async () => {
  const auditBefore = auditRows('PUT /invoices/profile').length;
  // Bo already tried 4 of these writes in this minute (accepting Remy's invoice, the agreement, a late dispute, his own
  // accept), refused ones included: 56 more go through
  let ok = 0;
  while (ok < 70 && (await repB.put('/invoices/profile', {})).status === 200) ok++;
  assert.equal(ok, 56);
  const refused = await repB.put('/invoices/profile', { addressLine1: '9 Brook Lane' });
  assert.equal(refused.status, 429);
  assert.equal(refused.json.error, 'That is more than 60 changes in a minute. Wait a minute, then try again.');
  assert.equal((await repB.post('/invoices/agreement/accept')).status, 429, 'one counter for all of them');
  assert.equal((await repB.get('/invoices/profile')).status, 200, 'reads are not limited');
  assert.equal((await rep.put('/invoices/profile', {})).status, 200, 'per person');
  assert.equal(auditRows('PUT /invoices/profile').length, auditBefore, 'nothing recorded for unchanged or refused saves');
});

test('a database made at the foundation commit gets the new invoice columns once', () => {
  const fresh = openDb(':memory:');
  try {
    createSchema(fresh);
    // the foundation's invoices table, without P2's columns
    fresh.exec(`DROP TABLE invoice_versions; DROP TABLE invoices;`);
    fresh.exec(`CREATE TABLE invoices (id INTEGER PRIMARY KEY AUTOINCREMENT, payroll_run_id INTEGER NOT NULL UNIQUE, user_id INTEGER NOT NULL, number TEXT NOT NULL UNIQUE,
      version INTEGER NOT NULL DEFAULT 1, issued_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'issued', total REAL NOT NULL DEFAULT 0, lines_json TEXT NOT NULL DEFAULT '[]',
      supplier_json TEXT, customer_json TEXT, accepted_at TEXT, accepted_ip TEXT, disputed_at TEXT, dispute_reason TEXT, dispute_lines TEXT, resolved_at TEXT,
      resolved_by INTEGER, resolution_note TEXT)`);
    fresh.exec(invoicesExtension.sql);
    assert.deepEqual(invoicesExtension.upgrade(fresh), [
      'invoices.deem_at', 'invoices.run_fingerprint', 'invoices.resolution_action', 'invoices.paid_override_reason', 'invoices.paid_override_by', 'invoices.paid_override_at',
    ]);
    assert.deepEqual(invoicesExtension.upgrade(fresh), []);
    assert.deepEqual(createSchema(fresh), []);
  } finally {
    fresh.close();
  }
});

test('a database whose void trigger predates versions_json gets the column and the new trigger once', () => {
  const fresh = openDb(':memory:');
  try {
    createSchema(fresh);
    // invoice_voids and its trigger as the first 1.3 build made them
    fresh.exec(`DROP TRIGGER invoices_keep_void; DROP TABLE invoice_voids;
      CREATE TABLE invoice_voids (invoice_id INTEGER PRIMARY KEY, number TEXT NOT NULL, payroll_run_id INTEGER, user_id INTEGER, version INTEGER NOT NULL,
        status TEXT NOT NULL, total REAL NOT NULL, lines_json TEXT NOT NULL, issued_at TEXT NOT NULL, voided_at TEXT NOT NULL, reason TEXT NOT NULL);
      CREATE TRIGGER invoices_keep_void BEFORE DELETE ON invoices BEGIN
        INSERT OR REPLACE INTO invoice_voids (invoice_id, number, payroll_run_id, user_id, version, status, total, lines_json, issued_at, voided_at, reason)
        VALUES (OLD.id, OLD.number, OLD.payroll_run_id, OLD.user_id, OLD.version, OLD.status, OLD.total, OLD.lines_json, OLD.issued_at, 'x', 'y');
      END;`);
    fresh.exec(invoicesExtension.sql);
    assert.deepEqual(invoicesExtension.upgrade(fresh), ['invoice_voids.versions_json', 'trigger invoices_keep_void']);
    assert.deepEqual(invoicesExtension.upgrade(fresh), []);
    assert.deepEqual(createSchema(fresh), []);
    const sql = (fresh.prepare(`SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'invoices_keep_void'`).get() as { sql: string }).sql;
    assert.match(sql, /versions_json/);
  } finally {
    fresh.close();
  }
});

test('the demo seed: invoices for the last six weeks, Jordan still to accept, two disputes for the office', async () => {
  const demo = await startTestServer({ seed: true, today: '2026-10-21' });
  try {
    const d = demo.db;
    const statuses = all<{ status: string; n: number }>(d, `SELECT status, COUNT(*) AS n FROM invoices GROUP BY status`);
    const by = Object.fromEntries(statuses.map((s) => [s.status, s.n]));
    assert.equal(by.disputed, 2);
    assert.equal(by.resolved, 1);
    assert.ok(by.accepted > 50 && by.deemed_accepted > 20 && by.issued > 5, JSON.stringify(by));
    const mismatched = get<{ n: number }>(d, `SELECT COUNT(*) AS n FROM invoices i JOIN payroll_runs p ON p.id = i.payroll_run_id WHERE abs(i.total - p.gross) > 0.001`)!.n;
    assert.equal(mismatched, 0, 'every invoice total is its run\'s gross');
    const numbers = all<{ number: string }>(d, `SELECT number FROM invoices ORDER BY id`).map((r) => r.number);
    assert.equal(new Set(numbers).size, numbers.length);
    assert.deepEqual(numbers.slice(0, 3), ['LM-SB-2026-000001', 'LM-SB-2026-000002', 'LM-SB-2026-000003'], 'in issue order');
    assert.equal(get<{ v: string }>(d, `SELECT value AS v FROM meta WHERE key = 'ext:invoices:seq:2026'`)!.v, String(numbers.length));
    assert.equal(get<{ n: number }>(d, `SELECT COUNT(*) AS n FROM invoices i JOIN users u ON u.id = i.user_id WHERE u.role NOT IN ('rep', 'leader')`)!.n, 0);
    const accepted = get<{ n: number }>(d, `SELECT COUNT(*) AS n FROM invoices i LEFT JOIN self_billing_agreements a ON a.user_id = i.user_id WHERE i.status = 'accepted' AND a.user_id IS NULL`)!.n;
    assert.equal(accepted, 0, 'nobody accepted an invoice without the agreement');
    // …nor before it: the server refuses that (agreement_required), so the demo never shows it
    const early = all<{ number: string; acceptedAt: string; agreedAt: string }>(d, `SELECT i.number, i.accepted_at AS acceptedAt, MIN(a.accepted_at) AS agreedAt
      FROM invoices i JOIN self_billing_agreements a ON a.user_id = i.user_id WHERE i.accepted_at IS NOT NULL GROUP BY i.id HAVING i.accepted_at < MIN(a.accepted_at)`);
    assert.deepEqual(early, [], 'no invoice accepted before its person accepted the agreement');
    // every acceptance after the version was issued and before its deadline
    const outOfOrder = get<{ n: number }>(d, `SELECT COUNT(*) AS n FROM invoices WHERE accepted_at IS NOT NULL AND accepted_at < issued_at`)!.n;
    assert.equal(outOfOrder, 0);
    // every unpaid field run has its invoice (older failed transfers too, issued on their own Monday), so the first
    // job tick on a fresh demo changes nothing
    const uninvoiced = get<{ n: number }>(d, `SELECT COUNT(*) AS n FROM payroll_runs p JOIN users u ON u.id = p.user_id LEFT JOIN invoices i ON i.payroll_run_id = p.id
      WHERE i.id IS NULL AND p.status IN ('pending', 'failed') AND u.role IN ('rep', 'leader')`)!.n;
    assert.equal(uninvoiced, 0);
    assert.deepEqual(syncInvoices(d), { issued: 0, reissued: 0, refreshed: 0, deemed: 0 }, 'the first tick has nothing to do');
    // the demo is paid up (finding UX-9: a sales demo showed weeks never paid, "74 days overdue"): no older unpaid run,
    // so no invoice for a week before self-billing started in the demo
    const late = all<{ issuedAt: string; status: string }>(d, `SELECT i.issued_at AS issuedAt, i.status FROM invoices i JOIN payroll_runs p ON p.id = i.payroll_run_id WHERE p.week_start < ?`, [addDays(LAST_WEEK, -35)]);
    assert.deepEqual(late, [], 'no older unpaid runs in the demo');
    const jordan = await demo.login('rep');
    const mine = await jordan.get('/finance/me');
    const last = mine.json.runs.find((r: Json) => r.weekStart === LAST_WEEK);
    assert.equal(last.invoice.status, 'issued', 'the demo rep has last week\'s invoice to accept');
    const inv = (await jordan.get(`/invoices/by-run/${last.id}`)).json as Invoice;
    assert.ok(inv.supplier.postcode, 'demo supplier details');
    assert.equal(inv.agreementAccepted, true, 'so the agreement prompt does not cover the demo');
    assert.equal((await jordan.get('/invoices/agreement')).json.acceptedAt !== null, true);
    const owner = await demo.login('admin');
    const disputes = await owner.get('/invoices/disputes');
    assert.equal(disputes.json.length, 2);
    assert.ok(disputes.json.every((r: Json) => r.disputedLines.length === 1));
    const leaderDemo = await demo.login('leader');
    assert.equal((await leaderDemo.get('/invoices/agreement')).json.acceptedAt !== null, true);
    // the demo seed's invoices cover the last six completed weeks (issued the Monday after each)
    const first = get<{ w: string }>(d, `SELECT MIN(p.week_start) AS w FROM invoices i JOIN payroll_runs p ON p.id = i.payroll_run_id WHERE p.status IN ('paid', 'late')`)!.w;
    assert.equal(first, addDays(LAST_WEEK, -35));
  } finally {
    await demo.close();
  }
});
