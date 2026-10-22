/**
 * Release 1.3 — P3 statements: every /statements route for every role (admin, leader, recruiter, rep, client,
 * anonymous), the upload → match → apply path with hand-computed figures, client IDs, column templates, the Gmail
 * settings (the app password encrypted, never returned, never audited), the mail check with a fake mail source and
 * .eml messages, the attention items and the audit rows.
 */
import { after, afterEach, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CheckNowResult, StatementDetail, StatementSummary } from '@lm/shared';
import { all, get, run, type Db } from '../db/connection.ts';
import { decrypt } from '../lib/crypto.ts';
import { addDays, mondayOf, todayISO } from '../lib/dates.ts';
import { configureStatementsDir } from '../lib/statements/files.ts';
import { MAIL_META_KEY, mailErrorMessage, senderAuthenticated, setMailSource, type FetchRequest, type FetchResult, type MailSource } from '../lib/statements/mail.ts';
import { runStatementJobOnce, startStatementJob } from '../lib/statements/job.ts';
import { renderStatementPdf, type StatementPdfSpec } from '../lib/statements/render.ts';
import { provider as statementsAttention } from '../lib/attention/statements.ts';
import { addEvent, addGauge, startTestServer, type TestClient, type TestServer } from './helpers.ts';

let dir: string;
let srv: TestServer;
let admin: TestClient;
let leader: TestClient;
let recruiter: TestClient;
let rep: TestClient;
let client: TestClient;

const fx = () => srv.fixture!;
/** The last complete pay week (Monday) and the one before. */
const W = addDays(mondayOf(todayISO()), -7);
const W0 = addDays(W, -7);
const dmy = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

before(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'lm-statements-'));
  configureStatementsDir(dir);
  srv = await startTestServer();
  admin = await srv.login('admin');
  leader = await srv.login('leader');
  recruiter = await srv.login('recruiter');
  rep = await srv.login('rep');
  client = await srv.login('client');
  // Gauges for the fixture campaign (FXC) in week W: Remy 5 + 4 = 9, Rita 3, Bo 6; and Remy 2 in week W0.
  const { teams, campaignId, users } = fx();
  const ev = (teamId: number, date: string) => addEvent(srv.db, { campaignId, teamId, date });
  addGauge(srv.db, { eventId: ev(teams.a, W), userId: users.rep, date: W, stops: 60, sales: 5 });
  addGauge(srv.db, { eventId: ev(teams.a, addDays(W, 1)), userId: users.rep, date: addDays(W, 1), stops: 50, sales: 4 });
  addGauge(srv.db, { eventId: ev(teams.a, addDays(W, 2)), userId: users.repA2, date: addDays(W, 2), stops: 40, sales: 3 });
  addGauge(srv.db, { eventId: ev(teams.b, addDays(W, 3)), userId: users.repB, date: addDays(W, 3), stops: 55, sales: 6 });
  addGauge(srv.db, { eventId: ev(teams.a, addDays(W0, 4)), userId: users.rep, date: addDays(W0, 4), stops: 30, sales: 2 });
});

after(async () => {
  setMailSource(null);
  await srv.close();
  configureStatementsDir(null);
  rmSync(dir, { recursive: true, force: true });
});

afterEach(() => setMailSource(null));

/** A fixture-charity statement for week W (Remy paid 7 of 9, Rita 3, Bo 6, and someone who is not ours). */
function fxcSpec(over: Partial<StatementPdfSpec> = {}): StatementPdfSpec {
  return {
    title: 'Fixture Charity',
    subtitle: 'Commission statement',
    lines: [`Period: ${dmy(W)} to ${dmy(addDays(W, 6))}`],
    headers: ['Fundraiser name', 'Sign-ups', 'Cancelled', 'Paid subs', 'Amount'],
    rows: [
      ['Remy Rep', '9', '2', '7', '£840.00'],
      ['Rita Rep', '3', '0', '3', '£360.00'],
      ['Bo Rep', '6', '0', '6', '£720.00'],
      ['Zed Agency-Temp', '2', '0', '2', '£240.00'],
    ],
    totals: ['Total', '20', '2', '18', '£2,160.00'],
    widths: [160, 70, 70, 70, 90],
    right: [false, true, true, true, true],
    createdAt: `${addDays(W, 9)}T08:00:00.000Z`,
    color: '#DB2777',
    ...over,
  };
}

async function upload(cookie: string, body: Uint8Array | string, qs = '', type = 'application/pdf'): Promise<{ status: number; json: any }> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const res = await fetch(`${srv.base}/statements/upload${qs}`, { method: 'POST', headers: { 'content-type': type, cookie }, body: typeof body === 'string' ? body : new Uint8Array(body) });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

const auditRows = (db: Db, like: string) => all<{ action: string; summary: string; userId: number | null; before: string | null; after: string | null }>(
  db,
  `SELECT action, summary, user_id AS userId, before_json AS before, after_json AS after FROM audit_log WHERE action LIKE ? ORDER BY id`,
  [like],
);

// ───────────────────────────── roles ─────────────────────────────

const ROUTES: [string, string][] = [
  ['GET', '/statements'], ['GET', '/statements/mail'], ['PUT', '/statements/mail'], ['POST', '/statements/mail/test'],
  ['POST', '/statements/check-now'], ['GET', '/statements/senders'], ['PUT', '/statements/senders'],
  ['GET', '/statements/templates/1'], ['PUT', '/statements/templates/1'], ['GET', '/statements/client-refs'],
  ['PUT', '/statements/client-refs/1'], ['POST', '/statements/upload'], ['GET', '/statements/1'], ['GET', '/statements/1/file'],
  ['PATCH', '/statements/1'], ['DELETE', '/statements/1'], ['POST', '/statements/1/apply'], ['PUT', '/statements/1/rows/1'],
];

test('roles: anonymous 401, a client 403 (portal only), leader / recruiter / rep 403, on every /statements route', async () => {
  const anon = srv.anon();
  for (const [method, p] of ROUTES) {
    const body = method === 'GET' || method === 'DELETE' ? undefined : {};
    assert.equal((await anon.req(method, p, body)).status, 401, `anon ${method} ${p}`);
    const c = await client.req(method, p, body);
    assert.equal(c.status, 403, `client ${method} ${p}`);
    assert.equal(c.json.clientPortalOnly, true);
    for (const [who, tc] of [['leader', leader], ['recruiter', recruiter], ['rep', rep]] as const) {
      assert.equal((await tc.req(method, p, body)).status, 403, `${who} ${method} ${p}`);
    }
  }
  assert.equal((await upload(rep.cookie, new Uint8Array(10))).status, 403, 'a rep cannot upload');
  assert.equal((await upload(client.cookie, new Uint8Array(10))).status, 403, 'nor can a client');
});

test('admin: the empty reads before anything exists', async () => {
  assert.deepEqual((await admin.get('/statements')).json, []);
  assert.deepEqual((await admin.get('/statements/senders')).json, []);
  assert.deepEqual((await admin.get('/statements/client-refs')).json, []);
  assert.equal((await admin.get(`/statements/templates/${fx().campaignId}`)).status, 404);
  assert.equal((await admin.get('/statements/999')).status, 404);
  assert.equal((await admin.get('/statements/999/file')).status, 404);
  assert.equal((await admin.get('/statements/abc')).status, 400);
  const mail = (await admin.get('/statements/mail')).json;
  assert.deepEqual({ ...mail, checkEveryMinutes: undefined, lastFetchAt: undefined }, { address: null, hasPassword: false, enabled: false, lastCheckAt: null, lastError: null, checkEveryMinutes: undefined, lastFetchAt: undefined });
  assert.equal(mail.checkEveryMinutes, 15);
  assert.equal((await admin.post('/statements/check-now')).status, 409, 'nothing to check until Gmail is set up');
  assert.equal((await admin.post('/statements/mail/test')).status, 409);
});

// ───────────────────────────── upload → match → apply ─────────────────────────────

let statementId = 0;

test('upload: the raw PDF body; validation in plain words', async () => {
  assert.equal((await upload(admin.cookie, JSON.stringify({}), '', 'application/json')).status, 415);
  assert.equal((await upload(admin.cookie, new Uint8Array(0))).status, 400);
  const zeros = await upload(admin.cookie, new Uint8Array(1_500_000));
  assert.equal(zeros.status, 422, '1.5 MB that is not a PDF: read, then refused');
  assert.match(zeros.json.error, /not a PDF/);
  const big = await upload(admin.cookie, new Uint8Array(21 * 1024 * 1024));
  assert.equal(big.status, 413);
  assert.match(big.json.error, /over 20 MB/);
  assert.equal((await upload(admin.cookie, await renderStatementPdf(fxcSpec()), '?campaignId=9999')).status, 404);
  assert.equal((await admin.get('/statements')).json.length, 0, 'nothing stored by a refused upload');
});

test('upload: stored, campaign found from the PDF, rows matched by exact name, one row left for the office', async () => {
  const r = await upload(admin.cookie, await renderStatementPdf(fxcSpec()), `?fileName=${encodeURIComponent('../../FXC statement.pdf')}`);
  assert.equal(r.status, 201, JSON.stringify(r.json));
  const s: StatementSummary = r.json;
  statementId = s.id;
  assert.equal(s.campaignId, fx().campaignId, 'found by the name "Fixture Charity" in the PDF');
  assert.equal(s.source, 'upload');
  assert.equal(s.fileName, 'FXC statement.pdf', 'no path in the stored name');
  assert.deepEqual([s.periodStart, s.periodEnd], [W, addDays(W, 6)]);
  assert.equal(s.status, 'needs_review');
  assert.deepEqual([s.rowCount, s.matchedCount, s.unmatchedCount], [4, 3, 1]);
  const again = await upload(admin.cookie, await renderStatementPdf(fxcSpec()));
  assert.equal(again.status, 409);
  assert.equal(again.json.details.statementId, statementId);
  assert.match(again.json.error, /already here/);

  const d: StatementDetail = (await admin.get(`/statements/${statementId}`)).json;
  assert.deepEqual(d.rows.map((x) => [x.name, x.confirmed, x.cancelled, x.amount, x.match, x.userId]), [
    ['Remy Rep', 7, 2, 840, 'auto', fx().users.rep],
    ['Rita Rep', 3, 0, 360, 'auto', fx().users.repA2],
    ['Bo Rep', 6, 0, 720, 'auto', fx().users.repB],
    ['Zed Agency-Temp', 2, 0, 240, 'none', null],
  ]);
  assert.equal(d.table!.mappingSource, 'detected');
  assert.equal(d.table!.layout, 'totals');
  assert.deepEqual(d.blockers, ['1 row is not matched to anyone yet: pick the person, or mark the row as not one of ours.']);
  assert.ok(d.warnings!.some((w) => /read the columns itself/.test(w)));
  assert.equal(d.effect, null, 'no pay preview while something blocks Apply');
  // logged vs confirmed per person (hand-computed): Remy 9 logged, 7 confirmed, 2 cancelled; Rita 3/3; Bo 6/6
  assert.deepEqual(d.people!.map((p) => [p.userName, p.logged, p.confirmed, p.cancelled, p.weeks.map((w) => [w.weekStart, w.weekConfirmed])]), [
    ['Bo Rep', 6, 6, 0, [[W, 6]]],
    ['Remy Rep', 9, 7, 2, [[W, 7]]],
    ['Rita Rep', 3, 3, 0, [[W, 3]]],
  ]);
  assert.deepEqual(d.notListed, [], 'not worked out while a row is unmatched');
  const list = (await admin.get('/statements?status=needs_review')).json;
  assert.deepEqual(list.map((x: StatementSummary) => x.id), [statementId]);
  assert.deepEqual((await admin.get('/statements?status=applied')).json, []);
  assert.equal((await admin.get('/statements?status=nonsense')).status, 400);
});

test('the PDF: inline, framable by this origin only, never cached; ?download=1 as an attachment', async () => {
  const res = await fetch(`${srv.base}/statements/${statementId}/file`, { headers: { cookie: admin.cookie } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/pdf');
  assert.equal(res.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.equal(res.headers.get('content-security-policy'), "frame-ancestors 'self'");
  assert.equal(res.headers.get('cache-control'), 'private, no-store');
  assert.match(res.headers.get('content-disposition')!, /^inline; filename="FXC statement.pdf"/);
  assert.equal(Buffer.from(await res.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');
  const dl = await fetch(`${srv.base}/statements/${statementId}/file?download=1`, { headers: { cookie: admin.cookie } });
  assert.match(dl.headers.get('content-disposition')!, /^attachment;/);
  await dl.arrayBuffer();
  const other = await fetch(`${srv.base}/statements`, { headers: { cookie: admin.cookie } });
  assert.equal(other.headers.get('x-frame-options'), 'DENY', 'every other response stays DENY');
  await other.arrayBuffer();
});

test('rows: pick the person or "not one of ours"; a picked row with a fundraiser ID teaches that ID', async () => {
  const d: StatementDetail = (await admin.get(`/statements/${statementId}`)).json;
  const zed = d.rows.find((r) => r.name === 'Zed Agency-Temp')!;
  assert.equal((await admin.put(`/statements/${statementId}/rows/${zed.id}`, { userId: 999999 })).status, 404, 'an unknown person');
  assert.equal((await admin.put(`/statements/${statementId}/rows/999999`, { userId: null })).status, 404);
  assert.equal((await admin.put(`/statements/${statementId}/rows/${zed.id}`, { userId: 'x' })).status, 400);
  const marked = await admin.put(`/statements/${statementId}/rows/${zed.id}`, { userId: null });
  assert.equal(marked.status, 200);
  assert.deepEqual([marked.json.match, marked.json.userId, marked.json.rememberedRef], ['manual', null, null]);
  const after: StatementDetail = (await admin.get(`/statements/${statementId}`)).json;
  assert.deepEqual(after.blockers, []);
  assert.equal(after.status, 'needs_review', 'the columns are not saved yet, so it still waits for the office');
  assert.ok(after.effect, 'the pay preview (P1 applyConfirmedSales dry run) is shown once nothing blocks');
  assert.equal(after.effect!.dryRun, true);
  const audit = auditRows(srv.db, 'PUT /statements/:id/rows/:rowId');
  assert.match(audit[audit.length - 1]!.summary, /^Marked “Zed Agency-Temp” on the FXC statement for .* as not one of ours$/);
});

test('apply: the whole-week figures go to pay, the allocation and the columns are kept; applied statements are locked', async () => {
  const r = await admin.post(`/statements/${statementId}/apply`);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const d: StatementDetail = r.json;
  assert.equal(d.status, 'applied');
  assert.ok(d.appliedAt);
  assert.equal(d.appliedByName, 'Ada Admin');
  assert.deepEqual(d.blockers, []);
  assert.ok(d.effect && d.effect.dryRun === false, 'the stored ApplyResult of the real call');
  const alloc = all<{ userId: number; weekStart: string; logged: number; confirmed: number; weekConfirmed: number }>(
    srv.db,
    `SELECT user_id AS userId, week_start AS weekStart, logged, confirmed, week_confirmed AS weekConfirmed FROM statement_allocations WHERE statement_id = ? ORDER BY user_id`,
    [statementId],
  ).map((a) => ({ ...a }));
  const { users } = fx();
  assert.deepEqual(alloc, [
    { userId: users.rep, weekStart: W, logged: 9, confirmed: 7, weekConfirmed: 7 },
    { userId: users.repA2, weekStart: W, logged: 3, confirmed: 3, weekConfirmed: 3 },
    { userId: users.repB, weekStart: W, logged: 6, confirmed: 6, weekConfirmed: 6 },
  ]);
  const t = (await admin.get(`/statements/templates/${fx().campaignId}`)).json;
  assert.deepEqual(t.mapping, { name: 'Fundraiser name', gross: 'Sign-ups', confirmed: 'Paid subs', cancelled: 'Cancelled', amount: 'Amount' }, 'Apply saved the columns by header');
  assert.equal((await admin.post(`/statements/${statementId}/apply`)).status, 409);
  assert.equal((await admin.patch(`/statements/${statementId}`, { periodStart: W, periodEnd: addDays(W, 6) })).status, 409);
  assert.equal((await admin.del(`/statements/${statementId}`)).status, 409);
  const zed = d.rows.find((x) => x.name === 'Zed Agency-Temp')!;
  assert.equal((await admin.put(`/statements/${statementId}/rows/${zed.id}`, { userId: fx().users.rep })).status, 409);
  const audit = auditRows(srv.db, 'POST /statements/:id/apply');
  assert.match(audit[0]!.summary, /^Applied the FXC statement for .*: 3 people, 2 cancelled subs, /);
  assert.equal(audit[0]!.userId, fx().users.admin);
  // a gauge edited later never rewrites what the applied statement shows (it shows what was applied)
  addGauge(srv.db, { eventId: addEvent(srv.db, { campaignId: fx().campaignId, teamId: fx().teams.a, date: addDays(W, 4) }), userId: users.repA2, date: addDays(W, 4), stops: 20, sales: 2 });
  const later: StatementDetail = (await admin.get(`/statements/${statementId}`)).json;
  assert.deepEqual(later.people!.find((p) => p.userId === users.repA2)!.logged, 3);
});

test('a statement for exactly the same period replaces the applied one; a partial overlap is refused', async () => {
  // a corrected copy: Remy now 8 paid; Bo is not on it any more
  const spec = fxcSpec({ subtitle: 'Commission statement (corrected)', rows: [['Remy Rep', '9', '1', '8', '£960.00'], ['Rita Rep', '3', '0', '3', '£360.00']], totals: null });
  const { users } = fx();
  // P1's correction lines from the first statement (P1's real applyConfirmedSales writes them; its stub in this tree does
  // not): one still waiting on an unpaid week, one already paid out with a paid run
  const paidWeek = addDays(W, -35);
  run(srv.db, `INSERT INTO payroll_runs (user_id, week_start, week_end, due_date, status, paid_date, reference) VALUES (?, ?, ?, ?, 'paid', ?, ?)`, [users.rep, paidWeek, addDays(paidWeek, 6), addDays(paidWeek, 11), addDays(paidWeek, 11), `LM-TEST-${paidWeek}`]);
  const line = (target: string) =>
    run(srv.db, `INSERT INTO pay_adjustments (user_id, target_week_start, source_week_start, kind, amount, note, campaign_id, statement_id, created_at) VALUES (?, ?, ?, 'cancellation', -40, 'test', ?, ?, ?)`, [
      users.rep, target, W, fx().campaignId, statementId, new Date().toISOString(),
    ]).lastInsertRowid;
  const waiting = line(addDays(W, 7));
  const paidOut = line(paidWeek);
  const r = await upload(admin.cookie, await renderStatementPdf(spec), `?campaignId=${fx().campaignId}`);
  assert.equal(r.status, 201);
  assert.equal(r.json.status, 'needs_review', 'it would replace an applied statement: the office looks first, even with every row matched');
  const preview: StatementDetail = (await admin.get(`/statements/${r.json.id}`)).json;
  assert.deepEqual(preview.blockers, []);
  assert.equal(preview.replaces?.id, statementId);
  assert.ok(preview.warnings!.some((w) => /^This replaces the FXC statement for .* applied on /.test(w)), JSON.stringify(preview.warnings));
  assert.deepEqual(preview.dropped!.map((d) => [d.userName, d.logged, d.confirmedBefore]), [['Bo Rep', 6, 6]], 'Bo was on the replaced one only');
  assert.ok(preview.warnings!.some((w) => /^1 person is on the statement this replaces but not on this one \(Bo Rep\): their weeks go back to the subs they logged\.$/.test(w)));
  assert.equal(get<{ s: number }>(srv.db, `SELECT statement_id AS s FROM pay_adjustments WHERE id = ?`, [waiting])!.s, statementId, 'the preview changes nothing');
  const applied = await admin.post(`/statements/${r.json.id}/apply`);
  assert.equal(applied.status, 200);
  assert.equal(get<{ s: number | null }>(srv.db, `SELECT superseded_by AS s FROM statements WHERE id = ?`, [statementId])!.s, r.json.id);
  const remy = (applied.json as StatementDetail).people!.find((p) => p.userName === 'Remy Rep')!;
  assert.deepEqual(remy.weeks.map((w) => [w.weekStart, w.confirmed, w.weekConfirmed]), [[W, 8, 8]], 'the replaced statement does not count twice');
  // the correction still waiting on an unpaid week now belongs to the new statement (P1 updates it in place); the paid
  // one stays with the statement it was paid for
  assert.equal(get<{ s: number }>(srv.db, `SELECT statement_id AS s FROM pay_adjustments WHERE id = ?`, [waiting])!.s, r.json.id);
  assert.equal(get<{ s: number }>(srv.db, `SELECT statement_id AS s FROM pay_adjustments WHERE id = ?`, [paidOut])!.s, statementId);
  run(srv.db, `DELETE FROM pay_adjustments WHERE id IN (?, ?)`, [waiting, paidOut]);
  run(srv.db, `DELETE FROM payroll_runs WHERE reference = ?`, [`LM-TEST-${paidWeek}`]);
  // the old one says what replaced it; the new one what it replaced; the list knows
  const old: StatementDetail = (await admin.get(`/statements/${statementId}`)).json;
  assert.equal(old.supersededBy, r.json.id);
  assert.equal(old.replacedBy?.id, r.json.id);
  assert.equal(((applied.json as StatementDetail).replaces)?.id, statementId);
  assert.equal(((await admin.get('/statements')).json as StatementSummary[]).find((x) => x.id === statementId)!.supersededBy, r.json.id);
  // a period that overlaps only part of the applied week
  const overlap = fxcSpec({ subtitle: 'Mid-week statement', lines: [`Period: ${dmy(addDays(W, 3))} to ${dmy(addDays(W, 9))}`], rows: [['Bo Rep', '6', '0', '6', '£720.00']], totals: null });
  const o = await upload(admin.cookie, await renderStatementPdf(overlap), `?campaignId=${fx().campaignId}`);
  assert.equal(o.status, 201);
  const od: StatementDetail = (await admin.get(`/statements/${o.json.id}`)).json;
  assert.ok(od.blockers!.some((b) => /overlaps the FXC statement for .* that is already applied/.test(b)), JSON.stringify(od.blockers));
  assert.equal((await admin.post(`/statements/${o.json.id}/apply`)).status, 409);
  assert.equal((await admin.del(`/statements/${o.json.id}`)).status, 204, 'an unapplied statement can be discarded');
  assert.equal((await admin.get(`/statements/${o.json.id}`)).status, 404);
  assert.match(auditRows(srv.db, 'DELETE /statements/:id')[0]!.summary, /^Discarded the FXC statement for /);
});

test('a week split between two statements: the other statement keeps its days (hand-computed)', async () => {
  // Remy logged 2 in week W0 (on its Friday). A statement for W0's Mon–Wed (nothing of Remy's) is applied first; a
  // later one for Thu–Sun of W0 confirms 1 of Remy's 2. Week W0 → 1 (Thu–Sun) + 0 (Mon–Wed, confirmed elsewhere, none).
  const first = fxcSpec({ subtitle: 'Part 1', lines: [`Period: ${dmy(W0)} to ${dmy(addDays(W0, 2))}`], headers: ['Fundraiser name', 'Paid subs'], rows: [['Rita Rep', '0']], totals: null, widths: [200, 100], right: [false, true] });
  const f = await upload(admin.cookie, await renderStatementPdf(first), `?campaignId=${fx().campaignId}`);
  assert.equal(f.status, 201);
  // a different layout from the saved template: fix the columns for this campaign first
  const fd: StatementDetail = (await admin.get(`/statements/${f.json.id}`)).json;
  assert.ok(fd.blockers!.some((b) => /saved columns use/.test(b)), JSON.stringify(fd.blockers));
  const saved = await admin.put(`/statements/templates/${fx().campaignId}`, { name: 'Fundraiser name', confirmed: 'Paid subs' });
  assert.equal(saved.status, 200);
  assert.equal((await admin.post(`/statements/${f.json.id}/apply`)).status, 200);
  const second = fxcSpec({ subtitle: 'Part 2', lines: [`Period: ${dmy(addDays(W0, 3))} to ${dmy(addDays(W0, 6))}`], headers: ['Fundraiser name', 'Paid subs'], rows: [['Remy Rep', '1']], totals: null, widths: [200, 100], right: [false, true] });
  const s = await upload(admin.cookie, await renderStatementPdf(second), `?campaignId=${fx().campaignId}`);
  const sd: StatementDetail = (await admin.get(`/statements/${s.json.id}`)).json;
  assert.deepEqual(sd.blockers, []);
  const remy = sd.people!.find((p) => p.userName === 'Remy Rep')!;
  assert.deepEqual(remy.weeks, [{ weekStart: W0, logged: 2, confirmed: 1, cancelled: 1, weekConfirmed: 1 }]);
});

test('PATCH: the campaign and period the PDF did not state; validation', async () => {
  const spec = fxcSpec({ title: 'Somebody Else', subtitle: 'Statement', lines: ['No dates on this one'], rows: [['Bo Rep', '6', '0', '6', '£720.00']], totals: null });
  const r = await upload(admin.cookie, await renderStatementPdf(spec));
  assert.equal(r.status, 201);
  assert.equal(r.json.campaignId, null);
  const d: StatementDetail = (await admin.get(`/statements/${r.json.id}`)).json;
  assert.ok(d.blockers!.includes('Pick the campaign this statement is for.'));
  assert.ok(d.blockers!.includes('Set the period the statement covers (the PDF does not say).'));
  assert.equal((await admin.patch(`/statements/${r.json.id}`, { periodStart: addDays(W, 6), periodEnd: W })).status, 400);
  assert.equal((await admin.patch(`/statements/${r.json.id}`, { periodStart: W })).status, 400, 'both ends');
  assert.equal((await admin.patch(`/statements/${r.json.id}`, { periodStart: '2026-01-01', periodEnd: '2026-12-31' })).status, 400, 'too long');
  assert.equal((await admin.patch(`/statements/${r.json.id}`, { campaignId: 999 })).status, 404);
  const p = await admin.patch(`/statements/${r.json.id}`, { campaignId: fx().campaignId, periodStart: addDays(W, 7), periodEnd: addDays(W, 13) });
  assert.equal(p.status, 200, JSON.stringify(p.json));
  assert.equal(p.json.campaignCode, 'FXC');
  assert.ok(!p.json.blockers.some((b: string) => /campaign|period the statement/.test(b)), JSON.stringify(p.json.blockers));
  assert.match(auditRows(srv.db, 'PATCH /statements/:id').pop()!.summary, /campaign FXC, period /);
  assert.equal((await admin.del(`/statements/${r.json.id}`)).status, 204);
});

// ───────────────────────────── client IDs and templates ─────────────────────────────

test('client IDs: replace a person’s, one ID per client, unapplied statements match again', async () => {
  const { users, campaignId } = fx();
  assert.equal((await admin.put(`/statements/client-refs/999999`, [])).status, 404);
  const clientId = get<{ id: number }>(srv.db, `SELECT id FROM users WHERE role = 'client'`)!.id;
  assert.equal((await admin.put(`/statements/client-refs/${clientId}`, [{ campaignId, ref: 'X' }])).status, 404, 'a client account has no client IDs');
  assert.equal((await admin.put(`/statements/client-refs/${users.rep}`, [{ campaignId: 999, ref: 'X' }])).status, 404);
  assert.equal((await admin.put(`/statements/client-refs/${users.rep}`, [{ campaignId, ref: 'x'.repeat(41) }])).status, 400);
  const saved = await admin.put(`/statements/client-refs/${users.rep}`, [{ campaignId, ref: 'FXC-0042' }]);
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.json, [{ userId: users.rep, campaignId, ref: 'FXC-0042' }]);
  const clash = await admin.put(`/statements/client-refs/${users.repA2}`, [{ campaignId, ref: 'fxc-0042' }]);
  assert.equal(clash.status, 409);
  assert.equal(clash.json.error, 'FXC-0042 is already Remy Rep’s fundraiser ID at FXC.');
  assert.deepEqual((await admin.get(`/statements/client-refs?userId=${users.rep}`)).json, saved.json);
  // a statement with IDs and initials only: matched by ID
  const spec = fxcSpec({ subtitle: 'By ID', lines: [`Period: ${dmy(addDays(W, 14))} to ${dmy(addDays(W, 20))}`], headers: ['Fundraiser ID', 'Name', 'Paid subs'], rows: [['FXC-0042', 'R. Rep', '1'], ['FXC-0043', 'R. Rep', '2']], totals: null, widths: [100, 150, 80], right: [false, false, true] });
  await admin.put(`/statements/templates/${campaignId}`, { ref: 'Fundraiser ID', name: 'Name', confirmed: 'Paid subs' });
  const r = await upload(admin.cookie, await renderStatementPdf(spec), `?campaignId=${campaignId}`);
  let d: StatementDetail = (await admin.get(`/statements/${r.json.id}`)).json;
  assert.deepEqual(d.rows.map((x) => [x.fundraiserRef, x.userId, x.match]), [['FXC-0042', users.rep, 'auto'], ['FXC-0043', null, 'none']]);
  // Rita gets FXC-0043 → the waiting row matches by itself
  await admin.put(`/statements/client-refs/${users.repA2}`, [{ campaignId, ref: 'FXC-0043' }]);
  d = (await admin.get(`/statements/${r.json.id}`)).json;
  assert.deepEqual(d.rows.map((x) => x.userId), [users.rep, users.repA2]);
  assert.equal(d.status, 'parsed');
  // picking a person for a row with an unknown ID remembers it as theirs
  const spec2 = fxcSpec({ subtitle: 'By ID 2', lines: [`Period: ${dmy(addDays(W, 21))} to ${dmy(addDays(W, 27))}`], headers: ['Fundraiser ID', 'Name', 'Paid subs'], rows: [['FXC-0050', 'B. Rep', '4']], totals: null, widths: [100, 150, 80], right: [false, false, true] });
  const r2 = await upload(admin.cookie, await renderStatementPdf(spec2), `?campaignId=${campaignId}`);
  const row = ((await admin.get(`/statements/${r2.json.id}`)).json as StatementDetail).rows[0]!;
  const picked = await admin.put(`/statements/${r2.json.id}/rows/${row.id}`, { userId: users.repB });
  assert.equal(picked.json.rememberedRef, 'FXC-0050');
  assert.deepEqual((await admin.get(`/statements/client-refs?userId=${users.repB}`)).json, [{ userId: users.repB, campaignId, ref: 'FXC-0050' }]);
  assert.match(auditRows(srv.db, 'PUT /statements/:id/rows/:rowId').pop()!.summary, /to Bo Rep \(saved FXC-0050 as their client ID\)$/);
  // blank refs remove
  assert.deepEqual((await admin.put(`/statements/client-refs/${users.repB}`, [{ campaignId, ref: '' }])).json, []);
  assert.match(auditRows(srv.db, 'PUT /statements/client-refs/:userId').pop()!.summary, /^Changed Bo Rep’s client IDs: FXC removed$/);
  for (const id of [r.json.id, r2.json.id]) await admin.del(`/statements/${id}`);
});

test('templates: validation in plain words; saving re-reads the unapplied statements', async () => {
  const { campaignId } = fx();
  assert.equal((await admin.put(`/statements/templates/${campaignId}`, { amount: 'Amount' })).status, 400);
  assert.equal((await admin.put(`/statements/templates/999`, { name: 'Name', confirmed: 'Paid' })).status, 404);
  assert.equal((await admin.put(`/statements/templates/${campaignId}`, { name: { evil: true } })).status, 400);
  const t = await admin.put(`/statements/templates/${campaignId}`, { name: 1, confirmed: 3, ref: null });
  assert.equal(t.status, 200);
  assert.deepEqual(t.json.mapping, { name: 1, confirmed: 3 });
  assert.match(auditRows(srv.db, 'PUT /statements/templates/:campaignId').pop()!.summary, /^Saved the statement columns for FXC: /);
});

// ───────────────────────────── senders and Gmail settings ─────────────────────────────

const APP_PASSWORD = 'abcd efgh ijkl mnop';

test('senders: the whole list replaced; addresses checked', async () => {
  const { campaignId } = fx();
  assert.equal((await admin.put('/statements/senders', [{ campaignId, address: 'not an email' }])).status, 400);
  assert.equal((await admin.put('/statements/senders', [{ campaignId: 999, address: 'a@b.example' }])).status, 404);
  const r = await admin.put('/statements/senders', [{ campaignId, address: 'Statements@Fixture-Charity.example' }, { campaignId, address: 'statements@fixture-charity.example' }]);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, [{ campaignId, address: 'statements@fixture-charity.example' }]);
  assert.match(auditRows(srv.db, 'PUT /statements/senders').pop()!.summary, /^Changed the statement senders: added FXC statements@fixture-charity.example$/);
});

test('Gmail settings: the app password is encrypted at rest, never returned and never audited', async () => {
  assert.equal((await admin.put('/statements/mail', { address: 'matt@gmail.example', appPassword: 'short' })).status, 400);
  assert.equal((await admin.put('/statements/mail', { enabled: true })).status, 400, 'nothing to check with yet');
  assert.equal((await admin.put('/statements/mail', { address: 'nope' })).status, 400);
  const r = await admin.put('/statements/mail', { address: 'Matt@Gmail.example', appPassword: APP_PASSWORD, enabled: true });
  assert.equal(r.status, 200);
  assert.equal(r.json.address, 'matt@gmail.example');
  assert.equal(r.json.hasPassword, true);
  assert.equal(r.json.enabled, true);
  const everything = JSON.stringify([r.json, (await admin.get('/statements/mail')).json]);
  assert.ok(!everything.includes('abcd') && !everything.includes('mnop'), 'no part of the password in any answer');
  const stored = get<{ value: string }>(srv.db, `SELECT value FROM meta WHERE key = ?`, [MAIL_META_KEY])!.value;
  assert.ok(!stored.includes('abcdefghijklmnop') && !stored.includes('abcd efgh'), 'not stored in plain text');
  assert.equal(decrypt(JSON.parse(stored).passwordEnc), 'abcdefghijklmnop', 'encrypted with the app secret');
  const audit = auditRows(srv.db, 'PUT /statements/mail');
  assert.equal(audit.length, 1);
  assert.equal(audit[0]!.summary, 'Changed the Gmail statements settings: address matt@gmail.example, app password saved, automatic check on');
  assert.ok(!JSON.stringify(audit).includes('abcd'), 'the trail never holds it');
  assert.equal((await admin.put('/statements/mail', { address: 'matt@gmail.example' })).status, 200);
  assert.equal(auditRows(srv.db, 'PUT /statements/mail').length, 1, 'a save that changes nothing writes no row');
});

// ───────────────────────────── the mail check (fake mail source, .eml messages) ─────────────────────────────

/** An RFC 822 message from `from` with the PDFs attached (base64), like Gmail serves it. */
function eml(o: { from: string | null; messageId: string; subject: string; date: string; pdfs: { name: string; data: Buffer }[]; auth?: string | null }): Buffer {
  const domain = o.from?.split('@')[1] ?? 'unknown.example';
  // what Gmail's own servers add on arrival (null: no Authentication-Results at all)
  const auth = o.auth === undefined ? `mx.google.com;\r\n       dkim=pass header.i=@${domain} header.s=s1 header.b=AbCd;\r\n       spf=pass (google.com: domain of ${o.from} designates 192.0.2.1 as permitted sender) smtp.mailfrom=${o.from};\r\n       dmarc=pass (p=NONE sp=NONE dis=NONE) header.from=${domain}` : o.auth;
  const parts = [
    ...(auth === null ? [] : [`Authentication-Results: ${auth}`]),
    ...(o.from === null ? [] : [`From: "Fixture Charity Finance" <${o.from}>`]),
    'To: matt@gmail.example',
    `Subject: ${o.subject}`,
    `Date: ${o.date}`,
    `Message-ID: ${o.messageId}`,
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="lm-boundary"',
    '',
    '--lm-boundary',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Hello Matt, please find this week’s statement attached.',
  ];
  for (const p of o.pdfs) {
    parts.push('--lm-boundary', `Content-Type: application/pdf; name="${p.name}"`, `Content-Disposition: attachment; filename="${p.name}"`, 'Content-Transfer-Encoding: base64', '');
    parts.push(...(p.data.toString('base64').match(/.{1,76}/g) ?? []));
  }
  parts.push('--lm-boundary--', '');
  return Buffer.from(parts.join('\r\n'));
}

/** A fake Gmail: a list of messages by UID, answering only UIDs above the last one seen. */
function fakeGmail(messages: { uid: number; source: Buffer }[], calls: FetchRequest[] = []): MailSource {
  return {
    async fetchNew(req): Promise<FetchResult> {
      calls.push(req);
      const resume = req.mailbox === '[Gmail]/All Mail' && req.uidValidity === '7' && req.lastUid !== null;
      const found = messages.filter((m) => !resume || m.uid > req.lastUid!);
      const take = found.slice(0, req.max);
      return { mailbox: '[Gmail]/All Mail', uidValidity: '7', found: found.length, lastUid: take.length ? take[take.length - 1]!.uid : req.lastUid, messages: take };
    },
    async test() {
      return { mailbox: '[Gmail]/All Mail', recent: messages.length };
    },
  };
}

test('check now: each PDF attachment from a listed sender is stored once; the next check starts after the last UID', async () => {
  const { campaignId } = fx();
  await admin.put(`/statements/templates/${campaignId}`, { name: 'Fundraiser name', gross: 'Sign-ups', confirmed: 'Paid subs', cancelled: 'Cancelled', amount: 'Amount' });
  const weekLater = fxcSpec({ subtitle: 'Commission statement (email)', lines: [`Period: ${dmy(addDays(W, 35))} to ${dmy(addDays(W, 41))}`], rows: [['Remy Rep', '0', '0', '0', '£0.00']], totals: null });
  const unknownName = fxcSpec({ subtitle: 'Commission statement (email 2)', lines: [`Period: ${dmy(addDays(W, 42))} to ${dmy(addDays(W, 48))}`], rows: [['Someone New', '1', '0', '1', '£120.00']], totals: null });
  const calls: FetchRequest[] = [];
  const messages = [
    { uid: 11, source: eml({ from: 'statements@fixture-charity.example', messageId: '<m11@fixture-charity.example>', subject: 'Your commission statement', date: 'Wed, 14 Oct 2026 08:47:00 +0100', pdfs: [{ name: 'auto.pdf', data: await renderStatementPdf(weekLater) }, { name: 'review.pdf', data: await renderStatementPdf(unknownName) }] }) },
    { uid: 12, source: eml({ from: 'someone@else.example', messageId: '<m12@else.example>', subject: 'Not a sender', date: 'Wed, 14 Oct 2026 09:00:00 +0100', pdfs: [{ name: 'x.pdf', data: await renderStatementPdf(fxcSpec({ subtitle: 'stray' })) }] }) },
    { uid: 13, source: eml({ from: 'statements@fixture-charity.example', messageId: '<m13@fixture-charity.example>', subject: 'No attachment', date: 'Wed, 14 Oct 2026 10:00:00 +0100', pdfs: [] }) },
  ];
  setMailSource(fakeGmail(messages, calls));
  const r = await admin.post('/statements/check-now');
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const res: CheckNowResult = r.json;
  assert.deepEqual(res, { checked: 3, fetched: 2, parsed: 2, applied: 1, errors: [] });
  assert.deepEqual(calls[0]!.senders, ['statements@fixture-charity.example']);
  assert.equal(calls[0]!.address, 'matt@gmail.example');
  assert.equal(calls[0]!.password, 'abcdefghijklmnop', 'the source gets the decrypted password');
  assert.equal(calls[0]!.lastUid, null);
  const stored = all<{ source: string; sender: string; subject: string; messageId: string; status: string; receivedAt: string }>(
    srv.db,
    `SELECT source, sender, subject, message_id AS messageId, status, received_at AS receivedAt FROM statements WHERE source = 'email' ORDER BY id`,
  );
  assert.deepEqual(stored.map((s) => [s.sender, s.messageId, s.status]), [
    ['statements@fixture-charity.example', '<m11@fixture-charity.example>#1', 'applied'],
    ['statements@fixture-charity.example', '<m11@fixture-charity.example>#2', 'needs_review'],
  ]);
  assert.equal(stored[0]!.receivedAt, '2026-10-14T07:47:00.000Z', 'the email’s own date');
  const sys = auditRows(srv.db, 'SYSTEM statements.%');
  assert.ok(sys.some((a) => a.action === 'SYSTEM statements.apply' && a.userId === null && /^Applied a statement automatically: FXC /.test(a.summary)));
  assert.ok(sys.some((a) => a.action === 'SYSTEM statements.fetch' && /^Fetched 2 statements from Gmail: FXC .*; 1 applied automatically$/.test(a.summary)));
  assert.match(auditRows(srv.db, 'POST /statements/check-now').pop()!.summary, /^Checked Gmail for statements: 2 new statements, 1 applied automatically$/);
  const mail = (await admin.get('/statements/mail')).json;
  assert.ok(mail.lastCheckAt && mail.lastFetchAt);
  assert.equal(mail.lastError, null);
  // the next check resumes after UID 13 and finds nothing new
  const again: CheckNowResult = (await admin.post('/statements/check-now')).json;
  assert.deepEqual(again, { checked: 0, fetched: 0, parsed: 0, applied: 0, errors: [] });
  assert.deepEqual([calls[1]!.mailbox, calls[1]!.uidValidity, calls[1]!.lastUid], ['[Gmail]/All Mail', '7', 13]);
  // a new address forgets where the check got to; the same messages are recognised by Message-ID and not stored twice
  await admin.put('/statements/mail', { address: 'matt2@gmail.example' });
  await admin.put('/statements/mail', { enabled: true });
  const fresh: CheckNowResult = (await admin.post('/statements/check-now')).json;
  assert.equal(fresh.fetched, 0);
  assert.equal(calls[2]!.lastUid, null);
});

test('check now / test connection: a Gmail failure in plain words, kept for Settings and the top box, audited once', async () => {
  const failing: MailSource = {
    async fetchNew() {
      throw Object.assign(new Error('Command failed'), { authenticationFailed: true, responseText: '[AUTHENTICATIONFAILED] Invalid credentials (Failure)' });
    },
    async test() {
      throw Object.assign(new Error('Command failed'), { responseText: '[ALERT] Your account is not enabled for IMAP use.' });
    },
  };
  setMailSource(failing);
  const r: CheckNowResult = (await admin.post('/statements/check-now')).json;
  assert.equal(r.fetched, 0);
  assert.match(r.errors[0]!, /^Wrong app password/);
  await admin.post('/statements/check-now');
  assert.equal(auditRows(srv.db, 'SYSTEM statements.mail_error').length, 1, 'the same failure is recorded once');
  const me = { ...(await admin.get('/auth/me')).json.user };
  const items = statementsAttention.items(srv.db, me, { today: todayISO(), nowHHMM: '12:00', nowISO: new Date().toISOString() });
  const mailItem = items.find((i) => i.key.startsWith('statements:mail:'))!;
  assert.ok(mailItem);
  assert.equal(mailItem.severity, 'danger');
  assert.match(mailItem.body, /^Wrong app password/);
  const t = await admin.post('/statements/mail/test');
  assert.equal(t.status, 200);
  assert.equal(t.json.ok, false);
  assert.match(t.json.message, /^IMAP is off in Gmail/);
  assert.match(auditRows(srv.db, 'POST /statements/mail/test').pop()!.summary, /^Tested the Gmail connection: failed \(IMAP is off/);
  setMailSource(fakeGmail([]));
  const ok = (await admin.post('/statements/mail/test')).json;
  assert.equal(ok.ok, true);
  assert.equal(ok.message, 'Connected to Gmail as matt2@gmail.example (read-only). No emails from your statement senders in the last 60 days.');
  assert.equal((await admin.get('/statements/mail')).json.lastError, null, 'a good test clears the old error');
});

test('the 15-minute job: does nothing while the check is off; LM_STATEMENTS_JOB=0 starts nothing', async () => {
  const calls: FetchRequest[] = [];
  setMailSource(fakeGmail([], calls));
  await admin.put('/statements/mail', { enabled: false });
  await runStatementJobOnce(srv.db);
  assert.equal(calls.length, 0);
  await admin.put('/statements/mail', { enabled: true });
  await runStatementJobOnce(srv.db);
  assert.equal(calls.length, 1);
  process.env.LM_STATEMENTS_JOB = '0';
  try {
    const stop = startStatementJob(srv.db);
    stop();
  } finally {
    delete process.env.LM_STATEMENTS_JOB;
  }
  const stop = startStatementJob(srv.db);
  stop(); // the timers are cleared (and unref'd: the test process ends on time)
});

test('the real mail source is read-only: EXAMINE (readOnly locks) and no command that changes mail', () => {
  const src = readFileSync(path.join(import.meta.dirname, '../lib/statements/mail.ts'), 'utf8');
  assert.equal((src.match(/getMailboxLock\(path, \{ readOnly: true \}\)/g) ?? []).length, 2);
  for (const bad of ['messageFlagsAdd', 'messageFlagsSet', 'messageFlagsRemove', 'messageMove', 'messageCopy', 'messageDelete', 'mailboxOpen(', 'append(', 'mailboxCreate']) {
    assert.ok(!src.includes(bad), `mail.ts never calls ${bad}`);
  }
});

test('mailErrorMessage: Gmail and network failures as sentences Matt can act on', () => {
  assert.match(mailErrorMessage({ authenticationFailed: true, responseText: 'Invalid credentials (Failure)' }), /^Wrong app password/);
  assert.match(mailErrorMessage({ responseText: '[ALERT] Application-specific password required: https://support.google.com/accounts/answer/185833 (Failure)' }), /wants an app password, not your normal Google password/);
  assert.match(mailErrorMessage({ responseText: '[ALERT] Your account is not enabled for IMAP use.' }), /^IMAP is off in Gmail/);
  assert.match(mailErrorMessage({ responseText: '[ALERT] Please log in via your web browser' }), /^Google stopped the sign-in/);
  assert.match(mailErrorMessage({ code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND imap.gmail.com' }), /^Could not reach Gmail/);
  assert.match(mailErrorMessage(new Error('Something odd')), /^Could not check Gmail: Something odd\.$/);
});

// ───────────────────────────── attention ─────────────────────────────

test('attention: admins only; a statement that needs a look, one that could not be read, one ready to apply', async () => {
  const me = (await admin.get('/auth/me')).json.user;
  const now = { today: todayISO(), nowHHMM: '12:00', nowISO: new Date().toISOString() };
  const items = statementsAttention.items(srv.db, me, now).filter((i) => !i.key.startsWith('statements:mail'));
  // the email statement with "Someone New" on it (from the check-now test) waits for a person to be picked
  const waiting = get<{ id: number }>(srv.db, `SELECT id FROM statements WHERE message_id = '<m11@fixture-charity.example>#2'`)!.id;
  const review = items.find((i) => i.key === `statements:review:${waiting}`)!;
  assert.ok(review, JSON.stringify(items));
  assert.equal(review.severity, 'warning');
  assert.equal(review.kind, 'statements');
  assert.match(review.title, /^FXC statement for \d+.* \d{4} needs a look$/, 'the period tells two statements of one client apart');
  assert.equal(review.href, `/finance/statements?statement=${waiting}`);
  assert.equal(review.body, '1 row is not matched to anyone yet. Pick the person, then press Apply.');
  assert.equal(review.count, 1);
  // a PDF that cannot be read
  const r = await upload(admin.cookie, await renderStatementPdf(fxcSpec({ subtitle: 'Remittance', headers: [], rows: [], totals: null })), `?campaignId=${fx().campaignId}`);
  assert.equal(r.status, 201);
  assert.equal(r.json.status, 'failed');
  assert.match(auditRows(srv.db, 'POST /statements/upload').pop()!.summary, /could not be read$/);
  const again = statementsAttention.items(srv.db, me, now);
  assert.ok(again.some((i) => i.key === `statements:failed:${r.json.id}` && /could not find the table/.test(i.body)));
  for (const who of [leader, recruiter, rep]) {
    const user = (await who.get('/auth/me')).json.user;
    assert.deepEqual(statementsAttention.items(srv.db, user, now), [], `${user.role}: nothing`);
  }
  const feed = (await admin.get('/me/attention')).json;
  assert.ok(feed.items.some((i: { key: string }) => i.key === `statements:failed:${r.json.id}`), 'in the top box through the provider registry');
});

// ───────────────────────────── the demo seed ─────────────────────────────

test('the demo seed: BCN (by fundraiser ID) and CHN (one fundraiser written with an initial) wait for the office', async () => {
  const demo = await startTestServer({ seed: true });
  try {
    const a = await demo.login('admin');
    const list: StatementSummary[] = (await a.get('/statements')).json;
    assert.deepEqual(list.map((s) => [s.campaignCode, s.status, s.source]).sort(), [['BCN', 'needs_review', 'email'], ['CHN', 'failed', 'email'], ['CHN', 'needs_review', 'email']]);
    const bcn = list.find((s) => s.campaignCode === 'BCN')!;
    assert.equal(bcn.unmatchedCount, 0);
    assert.equal(bcn.matchedCount, bcn.rowCount);
    const d: StatementDetail = (await a.get(`/statements/${bcn.id}`)).json;
    assert.deepEqual(d.blockers, []);
    assert.ok(d.rows.every((r) => r.match === 'auto' && /^FR-\d+$/.test(r.fundraiserRef ?? '')));
    assert.ok(d.people!.some((p) => p.cancelled > 0), 'some cancellations');
    const chn = list.find((s) => s.campaignCode === 'CHN' && s.status === 'needs_review')!;
    assert.ok(chn.unmatchedCount! > 0);
    const cd: StatementDetail = (await a.get(`/statements/${chn.id}`)).json;
    assert.equal(cd.table!.layout, 'per-sub');
    // one pick covers every sign-up row written the same way ("J. Lee" once per sub)
    const first = cd.rows.find((r) => r.match === 'none')!;
    assert.match(first.name!, /^[A-Z]\. /);
    const who = get<{ id: number }>(demo.db, `SELECT id FROM users WHERE last_name = ? AND substr(first_name, 1, 1) = ? AND role = 'rep'`, [first.name!.slice(3), first.name![0]])!.id;
    const picked = await a.put(`/statements/${chn.id}/rows/${first.id}`, { userId: who });
    assert.equal(picked.status, 200);
    assert.equal(picked.json.alsoMatched, chn.unmatchedCount! - 1);
    const after: StatementDetail = (await a.get(`/statements/${chn.id}`)).json;
    assert.equal(after.unmatchedCount, 0);
    assert.deepEqual(after.blockers, []);
    assert.ok(after.people!.some((p) => p.userId === who));
    const res = await fetch(`${demo.base}/statements/${chn.id}/file`, { headers: { cookie: a.cookie } });
    assert.equal(res.status, 200);
    assert.ok((await res.arrayBuffer()).byteLength > 2000);
    assert.deepEqual((await a.get('/statements/senders')).json.map((s: { address: string }) => s.address).sort(), ['commissions@breastcancernow.example', 'finance@childrenshospicenorth.example']);
    const c = await demo.login('client');
    assert.equal((await c.get('/statements')).status, 403);
    const jordan = await demo.login('rep');
    assert.equal((await jordan.get(`/statements/${bcn.id}/file`)).status, 403);
  } finally {
    await demo.close();
  }
});

test('an applied statement keeps working when its PDF file is gone: the page still opens, the file says so', () => {
  const id = get<{ id: number }>(srv.db, `SELECT id FROM statements WHERE status = 'applied' ORDER BY id LIMIT 1`)!.id;
  run(srv.db, `UPDATE statements SET file_path = 'missing.pdf' WHERE id = ?`, [id]);
  return (async () => {
    assert.equal((await admin.get(`/statements/${id}`)).status, 200);
    const f = await admin.get(`/statements/${id}/file`);
    assert.equal(f.status, 404);
    assert.equal(f.json.error, 'Statement PDF not found');
    run(srv.db, `UPDATE statements SET file_path = '../../etc/passwd' WHERE id = ?`, [id]);
    assert.equal((await admin.get(`/statements/${id}/file`)).status, 404, 'a path outside the folder is never read');
  })();
});

// ───────────────────────────── who sent it, retries, the test button ─────────────────────────────

test('senderAuthenticated: only Gmail’s own topmost Authentication-Results counts, aligned with the From domain', () => {
  const h = (...lines: string[]) => lines.map((line) => ({ key: line.split(':')[0]!.toLowerCase(), line }));
  const from = 'statements@fixture-charity.example';
  assert.equal(senderAuthenticated(h('Authentication-Results: mx.google.com;\r\n  dkim=pass header.i=@fixture-charity.example header.s=s1;\r\n  dmarc=pass (p=NONE) header.from=fixture-charity.example'), from), true);
  assert.equal(senderAuthenticated(h('Authentication-Results: mx.google.com; dkim=pass header.i=@mail.fixture-charity.example'), from), true, 'a subdomain signature is aligned');
  assert.equal(senderAuthenticated(h('Authentication-Results: mx.google.com; dkim=pass header.d=fixture-charity.example'), from), true);
  assert.equal(senderAuthenticated(h('Authentication-Results: mx.google.com; dmarc=fail header.from=fixture-charity.example; dkim=pass header.i=@evil.example'), from), false, 'signed by someone else');
  assert.equal(senderAuthenticated(h('Authentication-Results: mx.google.com; spf=pass smtp.mailfrom=statements@fixture-charity.example'), from), false, 'SPF alone is not enough');
  assert.equal(
    senderAuthenticated(h('Authentication-Results: mx.google.com; dmarc=fail header.from=fixture-charity.example', 'Authentication-Results: mx.google.com; dmarc=pass header.from=fixture-charity.example'), from),
    false,
    'a lower header the sender wrote never counts',
  );
  assert.equal(senderAuthenticated(h('Authentication-Results: spoofed.example; dmarc=pass header.from=fixture-charity.example'), from), false, 'not written by Gmail');
  assert.equal(senderAuthenticated(h('Authentication-Results: mx.google.com; dkim=pass header.i=@example'), 'a@example'), false, 'a bare top-level domain is never aligned');
  assert.equal(senderAuthenticated([], from), false);
  assert.equal(senderAuthenticated(h('Authentication-Results: mx.google.com; dmarc=pass header.from=fixture-charity.example'), null), false);
});

test('check now: an email Gmail could not confirm, one without a From, and a re-sent period never apply themselves', async () => {
  const { campaignId } = fx();
  await admin.put('/statements/mail', { address: 'matt@gmail.example', appPassword: APP_PASSWORD, enabled: true });
  await admin.put('/statements/senders', [{ campaignId, address: 'statements@fixture-charity.example' }]);
  await admin.put(`/statements/templates/${campaignId}`, { name: 'Fundraiser name', gross: 'Sign-ups', confirmed: 'Paid subs', cancelled: 'Cancelled', amount: 'Amount' });
  const period = (n: number) => [`Period: ${dmy(addDays(W, 7 * n))} to ${dmy(addDays(W, 7 * n + 6))}`];
  const pdf = (n: number, sub: string) => renderStatementPdf(fxcSpec({ subtitle: sub, lines: period(n), rows: [['Remy Rep', '0', '0', '0', '£0.00']], totals: null }));
  const messages = [
    { uid: 31, source: eml({ from: 'statements@fixture-charity.example', messageId: '<m31@fixture-charity.example>', subject: 'Statement', date: 'Wed, 14 Oct 2026 08:47:00 +0100', pdfs: [{ name: 'a.pdf', data: await pdf(-9, 'unconfirmed') }], auth: null }) },
    { uid: 32, source: eml({ from: 'statements@fixture-charity.example', messageId: '<m32@fixture-charity.example>', subject: 'Statement', date: 'Wed, 14 Oct 2026 08:48:00 +0100', pdfs: [{ name: 'b.pdf', data: await pdf(-10, 'forged') }], auth: 'mx.google.com; dkim=fail header.i=@fixture-charity.example; dmarc=fail (p=NONE) header.from=fixture-charity.example' }) },
    { uid: 33, source: eml({ from: null, messageId: '<m33@fixture-charity.example>', subject: 'No sender', date: 'Wed, 14 Oct 2026 08:49:00 +0100', pdfs: [{ name: 'c.pdf', data: await pdf(-11, 'no from') }] }) },
    { uid: 34, source: eml({ from: 'statements@fixture-charity.example', messageId: '<m34@fixture-charity.example>', subject: 'Statement', date: 'Wed, 14 Oct 2026 08:50:00 +0100', pdfs: [{ name: 'd.pdf', data: await pdf(-12, 'confirmed') }] }) },
    { uid: 35, source: eml({ from: 'statements@fixture-charity.example', messageId: '<m35@fixture-charity.example>', subject: 'Statement again', date: 'Wed, 14 Oct 2026 08:51:00 +0100', pdfs: [{ name: 'e.pdf', data: await pdf(-12, 'confirmed, sent again') }] }) },
  ];
  setMailSource(fakeGmail(messages));
  run(srv.db, `UPDATE meta SET value = json_set(value, '$.lastUid', NULL) WHERE key = ?`, [MAIL_META_KEY]);
  const r: CheckNowResult = (await admin.post('/statements/check-now')).json;
  assert.deepEqual([r.checked, r.fetched, r.applied], [5, 4, 1], JSON.stringify(r));
  const byId = (m: string) => get<{ id: number; status: string; senderVerified: number | null }>(srv.db, `SELECT id, status, sender_verified AS senderVerified FROM statements WHERE message_id = ?`, [`${m}#1`]);
  assert.deepEqual({ ...byId('<m31@fixture-charity.example>') }, { id: byId('<m31@fixture-charity.example>')!.id, status: 'needs_review', senderVerified: 0 }, 'no Authentication-Results: waits');
  assert.equal(byId('<m32@fixture-charity.example>')!.status, 'needs_review', 'DKIM and DMARC failed: waits');
  assert.equal(byId('<m33@fixture-charity.example>'), undefined, 'no From address: not a listed sender, not read');
  assert.equal(byId('<m34@fixture-charity.example>')!.status, 'applied', 'confirmed by Gmail, columns saved, all matched: applied');
  assert.equal(byId('<m35@fixture-charity.example>')!.status, 'needs_review', 'the same period again: waits for the office, never replaces by itself');
  const d: StatementDetail = (await admin.get(`/statements/${byId('<m31@fixture-charity.example>')!.id}`)).json;
  assert.equal(d.senderVerified, false);
  assert.ok(d.warnings!.some((w) => /^Gmail could not confirm that this email really came from Fixture Charity/.test(w)), JSON.stringify(d.warnings));
  const again: StatementDetail = (await admin.get(`/statements/${byId('<m35@fixture-charity.example>')!.id}`)).json;
  assert.equal(again.replaces?.id, byId('<m34@fixture-charity.example>')!.id);
  const me = (await admin.get('/auth/me')).json.user;
  const items = statementsAttention.items(srv.db, me, { today: todayISO(), nowHHMM: '12:00', nowISO: new Date().toISOString() });
  const item = (id: number) => items.find((i) => i.key === `statements:review:${id}`);
  assert.match(item(byId('<m35@fixture-charity.example>')!.id)?.body ?? '', /^It replaces a statement for the same period that is already applied\./);
});

test('check now: an email that fails to process is tried again on the next checks, then skipped with a message', async () => {
  const { campaignId } = fx();
  const spec = fxcSpec({ subtitle: 'Retry me', lines: [`Period: ${dmy(addDays(W, -91))} to ${dmy(addDays(W, -85))}`], rows: [['Remy Rep', '0', '0', '0', '£0.00']], totals: null });
  const calls: FetchRequest[] = [];
  setMailSource(fakeGmail([{ uid: 41, source: eml({ from: 'statements@fixture-charity.example', messageId: '<m41@fixture-charity.example>', subject: 'Retry', date: 'Wed, 14 Oct 2026 09:00:00 +0100', pdfs: [{ name: 'r.pdf', data: await renderStatementPdf(spec) }] }) }], calls));
  run(srv.db, `UPDATE meta SET value = json_set(value, '$.lastUid', 40, '$.mailbox', '[Gmail]/All Mail', '$.uidValidity', '7') WHERE key = ?`, [MAIL_META_KEY]);
  // the statements folder cannot be written (a file where the folder should be): storing the PDF throws
  const blocked = path.join(dir, 'not-a-folder');
  writeFileSync(blocked, 'x');
  configureStatementsDir(path.join(blocked, 'statements'));
  try {
    for (let i = 1; i <= 2; i++) {
      const r: CheckNowResult = (await admin.post('/statements/check-now')).json;
      assert.equal(r.fetched, 0);
      assert.match(r.errors[0]!, /^One email \(UID 41\) could not be read this time; Linear Hub tries it again on the next check\.$/);
      assert.equal(JSON.parse(get<{ value: string }>(srv.db, `SELECT value FROM meta WHERE key = ?`, [MAIL_META_KEY])!.value).lastUid, 40, `check ${i}: the cursor stays before it`);
    }
    const third: CheckNowResult = (await admin.post('/statements/check-now')).json;
    assert.match(third.errors[0]!, /^One email \(UID 41\) could not be read after 3 tries, so it was skipped\. Open it in Gmail and upload its PDF in Finance → Statements\.$/);
    assert.equal(JSON.parse(get<{ value: string }>(srv.db, `SELECT value FROM meta WHERE key = ?`, [MAIL_META_KEY])!.value).lastUid, 41, 'then the cursor moves on');
    assert.deepEqual(calls.map((c) => c.lastUid), [40, 40, 40]);
  } finally {
    configureStatementsDir(dir);
  }
  void campaignId;
});

test('test connection: one at a time and at most one every 10 seconds; a new app password is tested afresh', async () => {
  let tests = 0;
  setMailSource({
    fetchNew: async () => ({ mailbox: 'INBOX', uidValidity: '1', found: 0, lastUid: null, messages: [] }),
    test: async () => {
      tests++;
      await new Promise((r) => setTimeout(r, 30));
      return { mailbox: 'INBOX', recent: 2 };
    },
  });
  const [a, b] = await Promise.all([admin.post('/statements/mail/test'), admin.post('/statements/mail/test')]);
  assert.equal(tests, 1, 'two presses at once share one connection');
  assert.deepEqual(a.json, b.json);
  assert.equal((await admin.post('/statements/mail/test')).json.ok, true);
  assert.equal(tests, 1, 'a press within 10 seconds answers the last result');
  await admin.put('/statements/mail', { appPassword: 'qrst uvwx yzab cdef' });
  await admin.post('/statements/mail/test');
  assert.equal(tests, 2, 'a new app password connects again');
});
