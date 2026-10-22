/**
 * Release 1.3 — P3 statements, last fix round (re-review minors):
 *  - a sign-up dated after today, or more than 31 days outside the statement's period, blocks Apply (a typo'd year or
 *    a US-format date would otherwise write a confirmation for a week far away);
 *  - a listed person's days the statement has no row for count as cancelled: a warning says so and holds the
 *    statement for review;
 *  - the people a replacement dropped stay on its record once applied, are counted in its audit row, and their pay
 *    line says they are not on the corrected statement (not "confirmed");
 *  - P3 never writes pay_adjustments: the replaced statement's lines are handed over by P1 (replacesStatementId);
 *  - Check now and uploads have a per-person limit;
 *  - a PDF that could not be read can be uploaded again (the failed copy is replaced and read afresh).
 */
import { after, afterEach, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StatementDetail } from '@lm/shared';
import { all, get, run } from '../db/connection.ts';
import { addDays, mondayOf, todayISO } from '../lib/dates.ts';
import { configureStatementsDir } from '../lib/statements/files.ts';
import { setMailSource, type MailSource } from '../lib/statements/mail.ts';
import { renderStatementPdf, type StatementPdfSpec } from '../lib/statements/render.ts';
import { STATEMENT_CHECKS_PER_WINDOW, STATEMENT_UPLOADS_PER_WINDOW } from '../routes/statements.ts';
import { addEvent, addGauge, startTestServer, type TestClient, type TestServer } from './helpers.ts';

let dir: string;
let srv: TestServer;
let admin: TestClient;
const fx = () => srv.fixture!;
const dmy = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
/** Pay weeks (Mondays), all complete: A last week, B the week before, C1–C3 three earlier weeks. */
const A = addDays(mondayOf(todayISO()), -7);
const B = addDays(A, -7);
const C1 = addDays(A, -35);
const C3 = addDays(C1, 14);

before(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'lm-statement-minors-'));
  configureStatementsDir(dir);
  srv = await startTestServer();
  admin = await srv.login('admin');
  const { teams, campaignId, users } = fx();
  run(srv.db, `INSERT INTO meta (key, value) VALUES ('ext:pay:rule_from', ?), ('ext:pay:day_rate', '63.5')`, [addDays(C1, -7)]);
  const start = get<{ s: string }>(srv.db, `SELECT start_date AS s FROM campaigns WHERE id = ?`, [campaignId])!.s;
  run(srv.db, `INSERT INTO campaign_rates (campaign_id, rep_rate, payout_rate, effective_from, source, approved_by, client_post_id, created_at) VALUES (?, 45, 120, ?, 'seed', NULL, NULL, '2026-01-01T00:00:00Z')`, [campaignId, start]);
  const gauge = (userId: number, teamId: number, date: string, sales: number) =>
    addGauge(srv.db, { eventId: addEvent(srv.db, { campaignId, teamId, date }), userId, date, stops: 10 * sales + 20, sales });
  gauge(users.rep, teams.a, A, 4); // week A: Remy 4 on Monday
  gauge(users.rep, teams.a, B, 7); // week B: Remy 7 on Monday, Rita 3 on Tuesday
  gauge(users.repA2, teams.a, addDays(B, 1), 3);
  gauge(users.repA2, teams.a, addDays(C1, 4), 3); // weeks C: Rita 3 on C1's Friday and 2 on C3's Tuesday
  gauge(users.repA2, teams.a, addDays(C3, 1), 2);
});

after(async () => {
  await srv.close();
  configureStatementsDir(null);
  rmSync(dir, { recursive: true, force: true });
});

afterEach(() => setMailSource(null));

function spec(from: string, to: string, headers: string[], rows: string[][], subtitle: string): StatementPdfSpec {
  return {
    title: 'Fixture Charity',
    subtitle,
    lines: [`Period: ${dmy(from)} to ${dmy(to)}`],
    headers,
    rows,
    totals: null,
    widths: headers.map(() => 130),
    createdAt: `${addDays(to, 2)}T08:00:00.000Z`,
    color: '#DB2777',
  };
}

/** PDFs this file's uploads had read (each counts towards the per-person upload limit). */
let reads = 0;

async function uploadRaw(bytes: Uint8Array): Promise<{ status: number; json: any }> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const res = await fetch(`${srv.base}/statements/upload?campaignId=${fx().campaignId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/pdf', cookie: admin.cookie },
    body: new Uint8Array(bytes),
  });
  const text = await res.text();
  if (res.status === 201) reads++;
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

async function upload(s: StatementPdfSpec): Promise<StatementDetail> {
  const r = await uploadRaw(new Uint8Array(await renderStatementPdf(s)));
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return (await admin.get(`/statements/${r.json.id}`)).json;
}

test('a sign-up dated after today, or far outside the period, blocks Apply until the row is checked', async () => {
  const { campaignId, users } = fx();
  assert.equal((await admin.put(`/statements/templates/${campaignId}`, { name: 'Fundraiser', date: 'Sign-up date', status: 'Status' })).status, 200);
  const nextYear = addDays(A, 364); // a typo'd year: the same weekday a year on
  const longAgo = addDays(A, -60);
  const d = await upload(spec(A, addDays(A, 6), ['Sign-up date', 'Fundraiser', 'Status'], [
    [dmy(A), 'Remy Rep', 'Active'], [dmy(A), 'Remy Rep', 'Active'], [dmy(A), 'Remy Rep', 'Active'], [dmy(nextYear), 'Remy Rep', 'Active'], [dmy(longAgo), 'Remy Rep', 'Active'],
  ], 'Week A with two odd dates'));
  const future = d.blockers!.find((b) => b.includes('after today'));
  assert.match(future ?? '', /^A sign-up for Remy Rep is dated \w{3} \d{1,2} \w{3} \d{4}, after today\. Check the dates with the PDF, or mark the row as not one of ours\.$/, JSON.stringify(d.blockers));
  assert.ok(future!.includes(nextYear.slice(0, 4)), 'with the year');
  const far = d.blockers!.find((b) => b.includes('more than 31 days'));
  assert.match(far ?? '', /^A sign-up for Remy Rep is dated \w{3} \d{1,2} \w{3} \d{4}, more than 31 days outside the statement's period \(.+\)\. Check the dates with the PDF, or mark the row as not one of ours\.$/, JSON.stringify(d.blockers));
  assert.equal(d.effect, null, 'no pay preview while it is blocked');
  assert.equal((await admin.post(`/statements/${d.id}/apply`)).status, 409);
  assert.equal(all(srv.db, `SELECT 1 FROM sale_confirmations WHERE week_start = ?`, [mondayOf(nextYear)]).length, 0, 'nothing written for the far week');
  // the office marks both rows as not one of ours: Apply is possible again
  for (const r of d.rows!.filter((x) => x.saleDate === nextYear || x.saleDate === longAgo)) {
    assert.equal((await admin.put(`/statements/${d.id}/rows/${r.id}`, { userId: null })).status, 200);
  }
  const fixed: StatementDetail = (await admin.get(`/statements/${d.id}`)).json;
  assert.deepEqual(fixed.blockers, []);
  assert.deepEqual(fixed.people!.find((p) => p.userId === users.rep)!.weeks.map((w) => [w.weekStart, w.logged, w.confirmed]), [[A, 4, 3]]);
  assert.equal((await admin.del(`/statements/${d.id}`)).status, 204);
});

test("a listed person's days with no row on the statement count as cancelled: a warning says so and holds it for review", async () => {
  const { campaignId } = fx();
  assert.equal((await admin.put(`/statements/templates/${campaignId}`, { name: 'Fundraiser name', period: 'Period', confirmed: 'Paid subs' })).status, 200);
  // the statement covers C1–C3, but Rita's only row is for C3 (2 paid): her 3 on C1's Friday have no row
  const d = await upload(spec(C1, addDays(C3, 6), ['Fundraiser name', 'Period', 'Paid subs'], [['Rita Rep', `${dmy(C3)} to ${dmy(addDays(C3, 6))}`, '2']], 'Weeks C, one row'));
  assert.deepEqual(d.blockers, []);
  const w = d.warnings!.find((x) => x.includes('no row'));
  assert.match(w ?? '', /^Rita Rep logged 3 FXC sales on days this statement has no row for (her|them) \(w\/c \d{1,2} \w{3}\): they count as cancelled\. Check with the PDF before you press Apply\.$/, JSON.stringify(d.warnings));
  assert.equal(d.status, 'needs_review', 'never applies itself: the columns are saved and every row is matched, but a week is silent');
  assert.equal((await admin.del(`/statements/${d.id}`)).status, 204);
  // with a row for every week it is ready
  const full = await upload(spec(C1, addDays(C3, 6), ['Fundraiser name', 'Period', 'Paid subs'], [['Rita Rep', `${dmy(C1)} to ${dmy(addDays(C3, 6))}`, '5']], 'Weeks C, whole period'));
  assert.ok(!full.warnings!.some((x) => x.includes('no row')), JSON.stringify(full.warnings));
  assert.equal(full.status, 'parsed');
  assert.equal((await admin.del(`/statements/${full.id}`)).status, 204);
});

test('a replacement keeps the people it dropped on its record; their line says they are not on the corrected statement', async () => {
  const { users } = fx();
  const headers = ['Fundraiser name', 'Paid subs'];
  // v1 for week B: Remy 7 of 7, Rita 2 of 3 → Rita's unpaid week goes from £135 (3 × £45) to £90
  const v1 = await upload(spec(B, addDays(B, 6), headers, [['Remy Rep', '7'], ['Rita Rep', '2']], 'Week B'));
  assert.equal((await admin.put(`/statements/templates/${fx().campaignId}`, { name: 'Fundraiser name', confirmed: 'Paid subs' })).status, 200);
  const a1 = await admin.post(`/statements/${v1.id}/apply`);
  assert.equal(a1.status, 200, JSON.stringify(a1.json));
  // v2, the same period, lists Remy only: Rita goes back to the 3 she logged
  const v2 = await upload(spec(B, addDays(B, 6), headers, [['Remy Rep', '7']], 'Week B, corrected'));
  assert.equal(v2.replaces?.id, v1.id);
  assert.deepEqual(v2.dropped!.map((p) => p.userName), ['Rita Rep']);
  const preview = v2.effect!.people.find((p) => p.userId === users.repA2)!;
  assert.equal(preview.sentence, "Not on FXC's corrected statement: back to the 3 subs logged; the week's pay goes from £90.00 to £135.00 (not paid yet).");
  const a2 = await admin.post(`/statements/${v2.id}/apply`);
  assert.equal(a2.status, 200, JSON.stringify(a2.json));
  const applied: StatementDetail = a2.json;
  assert.equal(applied.status, 'applied');
  assert.deepEqual(applied.dropped!.map((p) => [p.userName, p.logged, p.confirmedBefore]), [['Rita Rep', 3, 2]], 'still on the record once applied');
  assert.ok(applied.warnings!.some((x) => /^1 person was on the statement this replaced but not on this one \(Rita Rep\): their weeks went back to the subs they logged\.$/.test(x)), JSON.stringify(applied.warnings));
  assert.equal(applied.effect!.totalDifference, 45);
  assert.equal((applied.effect as unknown as Record<string, unknown>).dropped, undefined, 'the effect is P1’s answer as it was');
  const audit = all<{ summary: string }>(srv.db, `SELECT summary FROM audit_log WHERE action = 'POST /statements/:id/apply' ORDER BY id`).pop()!;
  assert.match(audit.summary, /: 1 person, 1 person back to the subs they logged, 0 cancelled subs, \+£45(\.00)? on the next pay runs$/);
});

test('P3 never writes pay_adjustments itself: the replaced statement’s lines are handed over by P1', () => {
  const src = readFileSync(fileURLToPath(new URL('../lib/statements/store.ts', import.meta.url)), 'utf8');
  assert.ok(!/UPDATE\s+pay_adjustments|INSERT\s+INTO\s+pay_adjustments|DELETE\s+FROM\s+pay_adjustments/i.test(src));
  assert.ok(src.includes('replacesStatementId'));
});

test('a PDF that could not be read can be uploaded again: the failed copy is replaced and read afresh', async () => {
  const junk = new TextEncoder().encode('%PDF-1.4\n% damaged in the post\n');
  const first = await uploadRaw(junk);
  assert.equal(first.status, 201);
  assert.equal(first.json.status, 'failed');
  const again = await uploadRaw(junk);
  assert.equal(again.status, 201, JSON.stringify(again.json));
  assert.notEqual(again.json.id, first.json.id);
  assert.equal(again.json.status, 'failed', 'read again (still damaged)');
  assert.equal((await admin.get(`/statements/${first.json.id}`)).status, 404, 'the failed copy is gone');
  const audit = all<{ summary: string }>(srv.db, `SELECT summary FROM audit_log WHERE action = 'POST /statements/upload' ORDER BY id`).pop()!;
  assert.match(audit.summary, /, which could not be read \(it replaces the copy received before, which could not be read either\)$/);
  // a statement that was read is still a duplicate
  const ok = await upload(spec(A, addDays(A, 6), ['Fundraiser name', 'Paid subs'], [['Remy Rep', '4']], 'Week A, read fine'));
  const bytes = new Uint8Array(await renderStatementPdf(spec(A, addDays(A, 6), ['Fundraiser name', 'Paid subs'], [['Remy Rep', '4']], 'Week A, read fine')));
  const dup = await uploadRaw(bytes);
  assert.equal(dup.status, 409);
  assert.equal(dup.json.details?.statementId ?? dup.json.statementId, ok.id);
  assert.equal((await admin.del(`/statements/${ok.id}`)).status, 204);
  assert.equal((await admin.del(`/statements/${again.json.id}`)).status, 204);
});

test('Check now and uploads have a per-person limit (each Check now opens a Gmail connection; each upload is read)', async () => {
  await admin.put('/statements/mail', { address: 'matt@gmail.example', appPassword: 'abcdefghijklmnop', enabled: true });
  await admin.put('/statements/senders', [{ campaignId: fx().campaignId, address: 'statements@fixture-charity.example' }]);
  let fetches = 0;
  const quiet: MailSource = {
    async fetchNew() {
      fetches++;
      return { mailbox: '[Gmail]/All Mail', uidValidity: '7', found: 0, lastUid: null, messages: [] };
    },
    async test() {
      return { mailbox: '[Gmail]/All Mail', recent: 0 };
    },
  };
  setMailSource(quiet);
  for (let i = 0; i < STATEMENT_CHECKS_PER_WINDOW; i++) assert.equal((await admin.post('/statements/check-now')).status, 200, `check ${i + 1}`);
  const refused = await admin.post('/statements/check-now');
  assert.equal(refused.status, 429);
  assert.equal(refused.json.error, `That is more than ${STATEMENT_CHECKS_PER_WINDOW} Gmail checks in 10 minutes. Linear Hub also checks by itself every 15 minutes, so wait a few minutes before you press Check now again.`);
  assert.equal(fetches, STATEMENT_CHECKS_PER_WINDOW, 'the refused one never connected');
  // uploads: every PDF read counts (a duplicate, which is not read, does not)
  let status = 0;
  for (let i = 0; i <= STATEMENT_UPLOADS_PER_WINDOW && status !== 429; i++) {
    status = (await uploadRaw(new TextEncoder().encode(`%PDF-1.4\n% not really a PDF ${i}\n`))).status;
  }
  assert.equal(status, 429);
  assert.equal(reads, STATEMENT_UPLOADS_PER_WINDOW, 'every upload read in this file, up to the limit');
  const r = await uploadRaw(new TextEncoder().encode('%PDF-1.4\n% one more\n'));
  assert.equal(r.status, 429);
  assert.equal(r.json.error, `That is more than ${STATEMENT_UPLOADS_PER_WINDOW} statement uploads in 10 minutes. Wait a few minutes, then upload the rest.`);
});
