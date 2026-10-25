/**
 * Release 1.3 — P9 audit-everything: kinds of action, the page reports (POST /audit/events), automatic steps, the
 * client portal, the Audit page's new filters (GET /audit kind / view), the Person filter's list (GET /audit/people)
 * and Team → person → Activity (GET /audit/person/:userId), for every role, a client session and anonymous callers;
 * plus the audit_log.kind column on a fresh and on a 1.2 database. Failed sign-ins are in audit-signins.test.ts, the
 * route coverage in audit-coverage.test.ts.
 *
 * The business clock is pinned to Thu 15 Oct 2026 15:00 (London). Audit times are the real clock.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  AUDIT_EVENTS_PER_MINUTE,
  AUDIT_EVENT_KINDS,
  auditExportSummary,
  auditKindOf,
  auditWhatLabel,
  parseAuditKinds,
  type AuditEntryDetail,
  type AuditPage,
  type AuditPerson,
  type AuditPersonActivity,
} from '@lm/shared';
import { all, get, openDb, run, type Db } from '../db/connection.ts';
import { extension as auditExtension, KIND_CASE } from '../db/extensions/audit.ts';
import { createSchema } from '../db/schema.ts';
import { recordClientEvent, recordExportSummary, recordSystemEvent } from '../lib/audit/events.ts';

const recordRowsSummary = () => recordExportSummary({ what: 'candidate profile', format: 'csv', rows: 1 }, 'Sam Brown');
import { setBusinessClock } from '../lib/dates.ts';
import { AUDIT_EVENTS_LIMIT_MESSAGE, WRITE_LIMIT_PER_MINUTE, perUserWriteLimit } from '../middleware/writeLimit.ts';
import { FIXTURE_ACCOUNTS, startTestServer, type Json, type TestClient, type TestServer } from './helpers.ts';

const TODAY = '2026-10-15';
const LAST_MONDAY = '2026-10-05';
setBusinessClock(new Date(`${TODAY}T15:00:00`));

let srv: TestServer;
let admin: TestClient;
let leader: TestClient;
let recruiter: TestClient;
let rep: TestClient;
let repB: TestClient;
let client: TestClient;
const fx = () => srv.fixture!;
let candidateId = 0;
let runRep = 0;
let runRepB = 0;
let invoiceId = 0;

interface Row {
  id: number;
  userId: number | null;
  action: string;
  entity: string | null;
  entityId: number | null;
  summary: string;
  afterJson: string | null;
  kind: string | null;
}
const rows = (db: Db, where = '', params: (string | number)[] = []) =>
  all<Row>(db, `SELECT id, user_id AS userId, action, entity, entity_id AS entityId, summary, after_json AS afterJson, kind FROM audit_log ${where} ORDER BY id`, params);
const count = (db: Db) => Number(get<{ n: number }>(db, `SELECT COUNT(*) AS n FROM audit_log`)!.n);
const newest = (db: Db) => rows(db).at(-1)!;

function addRun(db: Db, userId: number, weekStart: string): number {
  return run(
    db,
    `INSERT INTO payroll_runs (user_id, week_start, week_end, days_worked, sales, base_pay, commission, gross, due_date, paid_date, status, reference)
     VALUES (?, ?, date(?, '+6 days'), 4, 10, 240, 400, 640, date(?, '+11 days'), NULL, 'pending', ?)`,
    [userId, weekStart, weekStart, weekStart, `PAY-${userId}-${weekStart}`],
  ).lastInsertRowid;
}

before(async () => {
  srv = await startTestServer({ today: TODAY });
  [admin, leader, recruiter, rep, repB, client] = await Promise.all([
    srv.login('admin'), srv.login('leader'), srv.login('recruiter'), srv.login('rep'), srv.login('repB'), srv.login('client'),
  ]);
  candidateId = run(srv.db, `INSERT INTO candidates (first_name, last_name, email, applied_at, stage_updated_at) VALUES ('Sam', 'Brown', 'sam.brown@example.test', ?, ?)`, [TODAY, TODAY]).lastInsertRowid;
  runRep = addRun(srv.db, fx().users.rep, LAST_MONDAY);
  runRepB = addRun(srv.db, fx().users.repB, LAST_MONDAY);
  invoiceId = run(srv.db, `INSERT INTO invoices (payroll_run_id, user_id, number, issued_at, total) VALUES (?, ?, 'LM-SB-2026-000001', ?, 640)`, [runRep, fx().users.rep, new Date().toISOString()]).lastInsertRowid;
});

after(async () => {
  await srv.close();
  setBusinessClock(null);
});

// ───────────────────────────── kinds (pure, and the SQL that classifies old rows) ─────────────────────────────

const ACTIONS: [string, string | null][] = [
  ['SYSTEM statements.fetch', null],
  ['SYSTEM invoices.issue', null],
  ['EVENT export', 'rep'],
  ['EVENT opened', 'admin'],
  ['GET /finance/payroll/export', 'admin'],
  ['POST /auth/login', 'rep'],
  ['POST /auth/login', 'client'],
  ['POST /auth/login/2fa', 'admin'],
  ['POST /auth/logout', 'client'],
  ['POST /auth/pin', 'client'],
  ['POST /client/posts', 'client'],
  ['POST /client/posts', null],
  ['POST /client-posts/:id/approve', 'admin'],
  ['PATCH /client-accounts/:id', 'admin'],
  ['POST /gauges', 'rep'],
  ['POST /finance/payroll/:id/pay', 'admin'],
  ['npm run pin:reset', null],
];

test('auditKindOf: automatic, export, opened, sign-in, client portal, change — in that order', () => {
  const kinds = ACTIONS.map(([a, role]) => auditKindOf(a, role as never));
  assert.deepEqual(kinds, [
    'automatic', 'automatic', 'export', 'opened', 'export', 'sign_in', 'sign_in', 'sign_in', 'sign_in', 'client', 'client', 'client',
    'change', 'change', 'change', 'change', 'change',
  ]);
  assert.deepEqual(parseAuditKinds('sign_in, export,sign_in'), ['sign_in', 'export']);
  assert.equal(parseAuditKinds(undefined), undefined);
  assert.equal(parseAuditKinds(' , '), undefined);
  assert.equal(parseAuditKinds('sign_in,nope'), null);
  assert.deepEqual([...AUDIT_EVENT_KINDS], ['change', 'sign_in', 'export', 'opened', 'automatic', 'client']);
});

test('export summaries: the page\'s slug in words, the format, the row count', () => {
  assert.equal(auditWhatLabel('gauges-by-team'), 'Gauges by team');
  assert.equal(auditWhatLabel('linear-hub-leaderboard-2026-10-21.csv'), 'Linear hub leaderboard');
  assert.equal(auditWhatLabel('payroll_2026-10-05_to_2026-10-11'), 'Payroll');
  assert.equal(auditWhatLabel('  '), 'a table');
  assert.equal(auditExportSummary({ what: 'gauges-by-team', format: 'csv', rows: 124 }), 'Exported Gauges by team as CSV: 124 rows');
  assert.equal(auditExportSummary({ what: 'audit-trail', format: 'pdf', rows: 1 }), 'Exported Audit trail as PDF: 1 row');
  assert.equal(auditExportSummary({ what: 'leaderboard', format: 'pdf' }), 'Exported Leaderboard as PDF');
  assert.equal(auditExportSummary({ what: 'payslip', format: 'print', rows: 1_250 }), 'Printed Payslip: 1,250 rows');
  assert.equal(auditExportSummary({ what: 'test' }), 'Exported Test');
});

test('the SQL that classifies rows written before 1.3 gives the same kind as auditKindOf for every action', () => {
  const db = openDb(':memory:');
  try {
    createSchema(db);
    const plan = run(db, `INSERT INTO pay_plans (name, position, base_per_day) VALUES ('P', 'owner', 0)`).lastInsertRowid;
    const ids: Record<string, number> = {};
    for (const role of ['admin', 'rep', 'client']) {
      ids[role] = run(
        db,
        `INSERT INTO users (employee_id, email, first_name, last_name, role, position, team_id, pay_plan_id, start_date, avatar_color)
         VALUES (?, ?, 'A', ?, ?, ?, NULL, ?, '2025-01-06', '#4F46E5')`,
        [`X-${role}`, `${role}@x.test`, role, role, role === 'client' ? 'client' : role === 'admin' ? 'owner' : 'field_rep', plan],
      ).lastInsertRowid;
    }
    for (const [action, role] of ACTIONS) {
      run(db, `INSERT INTO audit_log (at, user_id, action, summary, kind) VALUES (?, ?, ?, 's', NULL)`, [new Date().toISOString(), role ? ids[role]! : null, action]);
    }
    assert.deepEqual(auditExtension.upgrade(db), ['audit_log.kind (rows classified)']);
    const got = all<{ action: string; kind: string }>(db, `SELECT action, kind FROM audit_log ORDER BY id`).map((r) => r.kind);
    assert.deepEqual(got, ACTIONS.map(([a, role]) => auditKindOf(a, role as never)));
    assert.deepEqual(auditExtension.upgrade(db), [], 'a second start changes nothing');
    assert.ok(KIND_CASE.includes("'automatic'"));
  } finally {
    db.close();
  }
});

test('a 1.2 audit_log (no kind column) upgrades: the column and its index appear, every row is kept and classified once', () => {
  const db = openDb(':memory:');
  try {
    createSchema(db);
    db.exec(`DROP TABLE audit_log`);
    db.exec(`CREATE TABLE audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, user_id INTEGER, action TEXT NOT NULL, entity TEXT, entity_id INTEGER,
             summary TEXT NOT NULL, before_json TEXT, after_json TEXT, ip TEXT)`);
    const at = new Date().toISOString();
    db.exec(`INSERT INTO audit_log (at, user_id, action, summary) VALUES ('${at}', 1, 'POST /auth/login', 'Signed in'), ('${at}', 1, 'POST /gauges', 'Logged gauges'),
             ('${at}', 1, 'GET /finance/payroll/export', 'Exported payroll for Xero')`);
    assert.deepEqual(auditExtension.upgrade(db), ['audit_log.kind', 'audit_log.kind (rows classified)']);
    assert.deepEqual(all<{ kind: string }>(db, `SELECT kind FROM audit_log ORDER BY id`).map((r) => r.kind), ['sign_in', 'change', 'export']);
    assert.ok((db.prepare(`PRAGMA index_list(audit_log)`).all() as { name: string }[]).some((i) => i.name === 'idx_audit_kind_at'));
    assert.deepEqual(auditExtension.upgrade(db), []);
    assert.deepEqual(createSchema(db), [], 'a full start changes nothing more');
  } finally {
    db.close();
  }
});

// ───────────────────────────── POST /audit/events ─────────────────────────────

test('POST /audit/events: every staff role reports an export (204, one export row each); a client 403; anonymous 401', async () => {
  const before = count(srv.db);
  const ev = { kind: 'export', format: 'csv', what: 'gauges-by-team', rows: 12, filename: 'linear-hub-gauges-by-team-2026-10-01_2026-10-15.csv' };
  for (const c of [admin, leader, recruiter, rep]) assert.equal((await c.post('/audit/events', ev)).status, 204);
  const added = rows(srv.db, 'WHERE id > (SELECT MAX(id) - 4 FROM audit_log)');
  assert.equal(count(srv.db), before + 4);
  for (const r of added) {
    assert.equal(r.action, 'EVENT export');
    assert.equal(r.kind, 'export');
    assert.equal(r.entity, 'export');
    assert.equal(r.summary, 'Exported Gauges by team as CSV: 12 rows');
    assert.deepEqual(JSON.parse(r.afterJson!), { what: 'gauges-by-team', format: 'csv', rows: 12, filename: ev.filename });
  }
  assert.deepEqual(added.map((r) => r.userId), [fx().users.admin, fx().users.leader, fx().users.recruiter, fx().users.rep]);
  const denied = await client.post('/audit/events', ev);
  assert.equal(denied.status, 403);
  assert.equal(denied.json.clientPortalOnly, true);
  assert.equal((await srv.anon().post('/audit/events', ev)).status, 401);
  assert.equal(count(srv.db), before + 4, 'refused reports write nothing');
  assert.equal(rows(srv.db, `WHERE action = 'POST /audit/events'`).length, 0, 'never a generic row for the route itself');
  // the contract call every page may make (r3-contracts): the smallest export report
  assert.equal((await rep.post('/audit/events', { kind: 'export', what: 'test' })).status, 204);
  assert.equal(newest(srv.db).summary, 'Exported Test');
});

test('POST /audit/events: only the two kinds and well-formed fields; long text is cut, a path keeps its file name', async () => {
  const before = count(srv.db);
  const bad: Json[] = [
    {},
    { kind: 'deleted', what: 'x' },
    { kind: 'change', what: 'x' },
    { kind: 'export' },
    { kind: 'export', what: '   ' },
    { kind: 'export', what: 'x', rows: -1 },
    { kind: 'export', what: 'x', rows: 1.5 },
    { kind: 'export', what: 'x', rows: 2_000_000 },
    { kind: 'export', what: 'x', format: 'docx' },
    { kind: 'opened', what: 'x', entity: 'nope', entityId: 1 },
    { kind: 'opened', what: 'x', entity: 'candidate', entityId: -3 },
    { kind: 'export', what: 42 },
  ];
  for (const b of bad) assert.equal((await rep.post('/audit/events', b)).status, 400, JSON.stringify(b));
  assert.equal(count(srv.db), before, 'a refused report writes nothing');
  const long = await rep.post('/audit/events', { kind: 'export', format: 'pdf', what: `a${'b'.repeat(200)}`, filename: `../../etc/${'f'.repeat(300)}.pdf`, extra: 'ignored' });
  assert.equal(long.status, 204);
  const after = JSON.parse(newest(srv.db).afterJson!);
  assert.equal(after.what.length, 80);
  assert.equal(after.filename.length, 120);
  assert.ok(!after.filename.includes('/'), 'no folders');
  assert.ok(!('extra' in after));
});

test('POST /audit/events: bidi overrides and other invisible characters are removed, so a row never shows reversed', async () => {
  const r = await recruiter.post('/audit/events', { kind: 'export', format: 'csv', rows: 3, what: 'a\u0000b\nc‮d​e⁦f⁩﻿', filename: 'invoice‮fdp.exe' });
  assert.equal(r.status, 204);
  const row = newest(srv.db);
  const after = JSON.parse(row.afterJson!);
  assert.equal(after.what, 'a b cdef', 'controls become spaces; invisible characters go');
  assert.equal(after.filename, 'invoicefdp.exe', 'the real name, not one that displays as "invoiceexe.pdf"');
  assert.doesNotMatch(row.summary, /\p{Cf}|\p{Cc}/u, row.summary);
  assert.match(row.summary, / as CSV: 3 rows$/, 'the part the server adds reads the right way round');
  // made only of invisible characters: nothing left to record
  assert.equal((await recruiter.post('/audit/events', { kind: 'export', what: '‮​' })).status, 400);
});

test('POST /audit/events opened: a candidate profile — recruitment roles only, a real record, once per 5 minutes', async () => {
  const opened = { kind: 'opened', what: 'candidate profile', entity: 'candidate', entityId: candidateId };
  const n0 = count(srv.db);
  assert.equal((await recruiter.post('/audit/events', opened)).status, 204);
  const r = newest(srv.db);
  assert.equal(r.summary, 'Opened the candidate profile: Sam Brown');
  assert.equal(r.kind, 'opened');
  assert.equal(r.action, 'EVENT opened');
  assert.equal(r.entity, 'candidate');
  assert.equal(r.entityId, candidateId);
  assert.equal(r.userId, fx().users.recruiter);
  assert.equal((await recruiter.post('/audit/events', opened)).status, 204, 'opened again at once: fine, but…');
  assert.equal(count(srv.db), n0 + 1, '…no second row within 5 minutes');
  assert.equal((await leader.post('/audit/events', opened)).status, 204);
  assert.equal(count(srv.db), n0 + 2, 'another person opening it is another row');
  assert.equal((await rep.post('/audit/events', opened)).status, 403, 'a rep cannot open candidates');
  assert.equal((await admin.post('/audit/events', { ...opened, entityId: 999_999 })).status, 404);
  assert.equal((await admin.post('/audit/events', { kind: 'opened', what: 'candidate profile', entity: 'candidate' })).status, 404, 'a record needs its id');
  assert.equal(count(srv.db), n0 + 2);
});

test('POST /audit/events opened: a payslip and an invoice follow GET /finance/payroll/:id (the person, their leader, admins)', async () => {
  const payslip = (id: number) => ({ kind: 'opened', what: 'payslip', entity: 'payroll_run', entityId: id });
  assert.equal((await rep.post('/audit/events', payslip(runRep))).status, 204, 'their own');
  assert.equal(newest(srv.db).summary, 'Opened the payslip: Remy Rep w/c 5 Oct');
  assert.equal((await rep.post('/audit/events', payslip(runRepB))).status, 403, "someone else's");
  assert.equal((await leader.post('/audit/events', payslip(runRep))).status, 204, 'their team');
  assert.equal((await leader.post('/audit/events', payslip(runRepB))).status, 403, 'another team');
  assert.equal((await admin.post('/audit/events', payslip(runRepB))).status, 204);
  assert.equal((await recruiter.post('/audit/events', payslip(runRep))).status, 403);
  // P2's call: what names the invoice already, so the summary says whose it is
  assert.equal((await rep.post('/audit/events', { kind: 'opened', what: 'invoice LM-SB-2026-000001', entity: 'invoice', entityId: invoiceId })).status, 204);
  assert.equal(newest(srv.db).summary, 'Opened the invoice LM-SB-2026-000001: Remy Rep w/c 5 Oct');
  assert.equal((await admin.post('/audit/events', { kind: 'opened', what: 'invoice', entity: 'invoice', entityId: invoiceId })).status, 204);
  assert.equal(newest(srv.db).summary, 'Opened the invoice: LM-SB-2026-000001 (Remy Rep w/c 5 Oct)');
  assert.equal((await repB.post('/audit/events', { kind: 'opened', what: 'invoice', entity: 'invoice', entityId: invoiceId })).status, 403);
  assert.equal((await rep.post('/audit/events', { kind: 'opened', what: 'invoice', entity: 'invoice', entityId: 999_999 })).status, 404);
});

test('POST /audit/events opened: the audit trail itself (administrators), and any other record (administrators)', async () => {
  assert.equal((await admin.post('/audit/events', { kind: 'opened', what: 'audit trail', entity: null, entityId: null })).status, 204);
  const r = newest(srv.db);
  assert.equal(r.summary, 'Opened the audit trail');
  assert.equal(r.entity, null);
  assert.equal(r.entityId, null);
  for (const c of [leader, recruiter, rep]) assert.equal((await c.post('/audit/events', { kind: 'opened', what: 'audit trail' })).status, 403);
  assert.equal((await rep.post('/audit/events', { kind: 'opened', what: 'statement', entity: 'statement', entityId: 3 })).status, 403);
  assert.equal((await admin.post('/audit/events', { kind: 'opened', what: 'statement', entity: 'statement', entityId: 3 })).status, 204);
  assert.equal(newest(srv.db).summary, 'Opened the statement: Commission statement #3');
});

// Review fix: an export of ONE record (P7's candidate profile and interview sheet PDFs, P2's invoice PDF and print)
// keeps the record on its row, names it in the summary and follows the record's own access rule.
test('POST /audit/events export of a record: P7\'s candidate profile and interview sheet PDFs — named, filed under the candidate, recruitment roles only', async () => {
  const profile = { kind: 'export', format: 'pdf', what: 'candidate profile', entity: 'candidate', entityId: candidateId, filename: 'candidate-sam-brown.pdf' };
  const n0 = count(srv.db);
  assert.equal((await recruiter.post('/audit/events', profile)).status, 204);
  const r = newest(srv.db);
  assert.equal(r.summary, 'Exported the candidate profile as PDF: Sam Brown');
  assert.equal(r.kind, 'export');
  assert.equal(r.action, 'EVENT export');
  assert.equal(r.entity, 'candidate');
  assert.equal(r.entityId, candidateId);
  assert.equal(r.userId, fx().users.recruiter);
  assert.deepEqual(JSON.parse(r.afterJson!), { what: 'candidate profile', format: 'pdf', rows: null, filename: 'candidate-sam-brown.pdf', record: 'Sam Brown' });
  assert.equal((await recruiter.post('/audit/events', profile)).status, 204);
  assert.equal(count(srv.db), n0 + 2, 'each export is a file: never merged like openings');
  const sheet = { kind: 'export', format: 'pdf', what: 'interview sheet', entity: 'candidate', entityId: candidateId, filename: 'interview-sam-brown-2026-10-15.pdf' };
  assert.equal((await leader.post('/audit/events', sheet)).status, 204);
  assert.equal(newest(srv.db).summary, 'Exported the interview sheet as PDF: Sam Brown');
  // the record's own rule: a rep cannot open candidates, so cannot report exporting one; a record must exist
  assert.equal((await rep.post('/audit/events', profile)).status, 403);
  assert.equal((await admin.post('/audit/events', { ...profile, entityId: 999_999 })).status, 404);
  assert.equal((await admin.post('/audit/events', { kind: 'export', format: 'pdf', what: 'candidate profile', entity: 'candidate' })).status, 404, 'a record needs its id');
  assert.equal(count(srv.db), n0 + 3, 'refused reports write nothing');
  // the trail finds it under the record and by the person's name
  const byRecord = (await admin.get(`/audit?entity=candidate&entityId=${candidateId}&kind=export`)).json as AuditPage;
  assert.equal(byRecord.total, 3);
  const byName = (await admin.get('/audit?q=Sam%20Brown&kind=export')).json as AuditPage;
  assert.equal(byName.total, 3);
  // the record's History panel lists its changes only (kind=change,automatic,client), as for openings
  const history = (await admin.get(`/audit/candidate/${candidateId}?kind=change,automatic,client`)).json as AuditEntryDetail[];
  assert.ok(history.every((h) => h.kind !== 'export'));
});

test('POST /audit/events export of a record: P2\'s invoice PDF and print — whose invoice it is, the pay run\'s rule', async () => {
  const pdf = { kind: 'export', format: 'pdf', what: 'invoice LM-SB-2026-000001', filename: 'LM-SB-2026-000001.pdf', entity: 'invoice', entityId: invoiceId };
  assert.equal((await rep.post('/audit/events', pdf)).status, 204, 'their own invoice');
  let r = newest(srv.db);
  assert.equal(r.summary, 'Exported the invoice LM-SB-2026-000001 as PDF: Remy Rep w/c 5 Oct');
  assert.equal(r.entity, 'invoice');
  assert.equal(r.entityId, invoiceId);
  assert.equal(r.kind, 'export');
  const print = { kind: 'export', format: 'print', what: 'invoice LM-SB-2026-000001', entity: 'invoice', entityId: invoiceId };
  assert.equal((await leader.post('/audit/events', print)).status, 204, 'their team');
  r = newest(srv.db);
  assert.equal(r.summary, 'Printed the invoice LM-SB-2026-000001: Remy Rep w/c 5 Oct');
  assert.equal(r.userId, fx().users.leader);
  for (const c of [repB, recruiter]) assert.equal((await c.post('/audit/events', pdf)).status, 403);
  // a payslip printed as a pay run, and an export with no record are unchanged
  assert.equal((await admin.post('/audit/events', { kind: 'export', format: 'print', what: 'payslip', entity: 'payroll_run', entityId: runRepB })).status, 204);
  assert.equal(newest(srv.db).summary, 'Printed the payslip: Bo Rep w/c 5 Oct');
  assert.equal((await rep.post('/audit/events', { kind: 'export', format: 'csv', what: 'gauges-by-team', rows: 3, entity: null, entityId: null })).status, 204);
  r = newest(srv.db);
  assert.equal(r.summary, 'Exported Gauges by team as CSV: 3 rows');
  assert.equal(r.entity, 'export');
  assert.equal(r.entityId, null);
});

test('recordClientEvent called by a route (P3\'s statement PDF): a download is an export of the statement, an open an opening', () => {
  const me = { id: fx().users.admin, role: 'admin' } as Parameters<typeof recordClientEvent>[1];
  const label = 'BCN 5–11 Oct 2026';
  recordClientEvent(srv.db, me, { kind: 'export', format: 'pdf', what: 'BCN statement for 5–11 Oct 2026', filename: 'BCN 2026-10-05.pdf', entity: 'statement', entityId: 7 }, '127.0.0.1', label);
  let r = newest(srv.db);
  assert.equal(r.summary, 'Exported the BCN statement for 5–11 Oct 2026 as PDF', 'the statement is named once');
  assert.deepEqual([r.entity, r.entityId, r.kind, r.action], ['statement', 7, 'export', 'EVENT export']);
  assert.equal(JSON.parse(r.afterJson!).record, label);
  assert.equal(recordClientEvent(srv.db, me, { kind: 'opened', what: 'statement PDF', entity: 'statement', entityId: 7 }, '127.0.0.1', label), true);
  r = newest(srv.db);
  assert.equal(r.summary, 'Opened the statement PDF: BCN 5–11 Oct 2026');
  assert.equal(r.kind, 'opened');
  assert.equal(recordRowsSummary(), 'Exported the candidate profile as CSV: Sam Brown (1 row)');
});

test('POST /audit/events opened: the 5-minute merge ignores the case of `what`', async () => {
  const n0 = count(srv.db);
  const open = (what: string) => admin.post('/audit/events', { kind: 'opened', what, entity: 'candidate', entityId: candidateId });
  assert.equal((await open('Candidate Profile')).status, 204);
  assert.equal((await open('candidate profile')).status, 204);
  assert.equal((await open('CANDIDATE PROFILE')).status, 204);
  assert.equal(count(srv.db), n0 + 1, '"Candidate Profile" and "candidate profile" are the same opening');
});

test(`POST /audit/events: at most ${AUDIT_EVENTS_PER_MINUTE} a minute per person (429, a plain sentence); a counter of its own`, async () => {
  const rita = await srv.login('repA2');
  for (let i = 0; i < AUDIT_EVENTS_PER_MINUTE; i++) assert.equal((await rita.post('/audit/events', { kind: 'export', format: 'csv', what: `t${i}` })).status, 204);
  const refused = await rita.post('/audit/events', { kind: 'export', format: 'csv', what: 'one too many' });
  assert.equal(refused.status, 429);
  assert.equal(refused.json.error, AUDIT_EVENTS_LIMIT_MESSAGE);
  assert.equal(refused.headers.get('retry-after'), '60');
  assert.equal(rows(srv.db, `WHERE summary LIKE 'Exported One too many%'`).length, 0);
  assert.equal((await rep.post('/audit/events', { kind: 'export', what: 'someone else' })).status, 204, 'per person');
});

test('the report limit and the 1.2 write limit do not share a budget (and perMinute 0 turns both off)', async () => {
  let t = 1_000_000;
  const make = (opts: Parameters<typeof perUserWriteLimit>[0]) => {
    const app = express();
    app.use((req, _res, next) => {
      req.user = { id: 1 } as Json;
      next();
    });
    app.use(perUserWriteLimit({ ...opts, now: () => t }));
    app.use((_req, res) => void res.status(204).end());
    app.use(((err: { status?: number }, _req, res, _next) => void res.status(err.status ?? 500).end()) as express.ErrorRequestHandler);
    return app;
  };
  const serve = async (app: express.Express) => {
    const server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
  };
  const { server, base } = await serve(make({ perMinute: 3, auditEventsPerMinute: 2 }));
  try {
    const post = (p: string) => fetch(base + p, { method: 'POST' }).then((r) => r.status);
    assert.deepEqual([await post('/audit/events'), await post('/audit/events/'), await post('/AUDIT/EVENTS')], [204, 204, 429]);
    assert.deepEqual([await post('/checkins'), await post('/checkins'), await post('/checkins'), await post('/checkins')], [204, 204, 204, 429]);
    t += 60_000;
    assert.equal(await post('/audit/events'), 204, 'a minute later');
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
  const off = await serve(make({ perMinute: 0 }));
  try {
    for (let i = 0; i < AUDIT_EVENTS_PER_MINUTE + 5; i++) assert.equal(await fetch(`${off.base}/audit/events`, { method: 'POST' }).then((r) => r.status), 204);
  } finally {
    off.server.closeAllConnections();
    await new Promise<void>((r) => off.server.close(() => r()));
  }
  assert.equal(WRITE_LIMIT_PER_MINUTE, 60);
});

// ───────────────────────────── automatic steps, the client portal, the pay export, milestones ─────────────────────────────

test('automatic steps are filed under "Linear Hub" with kind automatic', async () => {
  recordSystemEvent(srv.db, { name: 'statements.fetch', summary: 'Fetched 2 statements from Gmail', entity: 'statement', entityId: 4, after: { count: 2, password: 'never' } });
  const r = newest(srv.db);
  assert.equal(r.userId, null);
  assert.equal(r.action, 'SYSTEM statements.fetch');
  assert.equal(r.kind, 'automatic');
  assert.ok(!r.afterJson!.includes('never'), 'snapshots are redacted as always');
  const page = (await admin.get('/audit?kind=automatic')).json as AuditPage;
  assert.ok(page.rows.length >= 1 && page.rows.every((x) => x.kind === 'automatic'));
  assert.equal(page.rows[0]!.userName, null);
  assert.equal(page.rows[0]!.userRole, null);
});

test('a client portal account\'s own actions are kind client; its sign-ins are sign-ins', async () => {
  // Release 1.4: a client account signs in with a two-step code too, so its sign-in is the code step's row
  const signIn = rows(srv.db, `WHERE user_id = (SELECT id FROM users WHERE employee_id = ?) AND action IN ('POST /auth/login', 'POST /auth/login/2fa')`, [FIXTURE_ACCOUNTS.client.employeeId]);
  assert.ok(signIn.length >= 1 && signIn.every((r) => r.kind === 'sign_in'));
  const changed = await client.post('/auth/pin', { pin: '6047', currentPin: FIXTURE_ACCOUNTS.client.pin });
  assert.equal(changed.status, 204, JSON.stringify(changed.json));
  const r = newest(srv.db);
  assert.equal(r.summary, 'Changed their PIN');
  assert.equal(r.kind, 'client');
  const page = (await admin.get('/audit?kind=client')).json as AuditPage;
  assert.ok(page.rows.some((x) => x.id === r.id && x.userRole === 'client'));
  // put the fixture PIN back so other tests' sign-ins keep working
  assert.equal((await client.post('/auth/pin', { pin: FIXTURE_ACCOUNTS.client.pin, currentPin: '6047' })).status, 204);
});

test('the payroll export (Xero / Sage CSV, recorded by its own route) is kind export', async () => {
  const res = await admin.get(`/finance/payroll/export?weekStart=${LAST_MONDAY}&format=xero`);
  assert.equal(res.status, 200);
  const r = newest(srv.db);
  assert.equal(r.action, 'GET /finance/payroll/export');
  assert.equal(r.kind, 'export');
});

test('PUT /learning/milestones/:userId/:key is recorded as a sentence (1.2 wrote a bare route); the same value again writes nothing', async () => {
  const url = `/learning/milestones/${fx().users.rep}/trained_personalities`;
  assert.equal((await admin.put(url, { value: 2 })).status, 200);
  const r = newest(srv.db);
  assert.equal(r.entity, 'learning');
  assert.equal(r.entityId, fx().users.rep);
  assert.match(r.summary, /^Updated a progression milestone for Remy Rep: “.+” set to 2$/);
  const n = count(srv.db);
  assert.equal((await admin.put(url, { value: 2 })).status, 200);
  assert.equal(count(srv.db), n, 'saved with the same value');
  assert.equal((await admin.put(url, { value: 3 })).status, 200);
  assert.match(newest(srv.db).summary, /: “.+” 2 → 3$/);
});

// ───────────────────────────── GET /audit: kinds and views ─────────────────────────────

test('GET /audit: every row carries its kind and the actor\'s role; kind= and view= filter; bad values 400', async () => {
  const everything = (await admin.get('/audit?limit=200')).json as AuditPage;
  assert.ok(everything.rows.length > 10);
  for (const r of everything.rows) {
    assert.ok(AUDIT_EVENT_KINDS.includes(r.kind!), `${r.action} → ${r.kind}`);
    assert.ok('userRole' in r);
  }
  const kinds = new Set(everything.rows.map((r) => r.kind));
  for (const k of ['change', 'sign_in', 'export', 'opened', 'automatic', 'client']) assert.ok(kinds.has(k as never), `the trail has a ${k} row`);
  const total = (k: string) => ((admin.get(`/audit?${k}&limit=1`)) as Promise<{ json: AuditPage }>).then((r) => r.json.total);
  const all = await total('view=everything');
  assert.equal(all, everything.total, 'view=everything is the default');
  const byKind: number[] = [];
  for (const k of AUDIT_EVENT_KINDS) {
    const page = (await admin.get(`/audit?kind=${k}&limit=200`)).json as AuditPage;
    assert.ok(page.rows.every((r) => r.kind === k), k);
    byKind.push(page.total);
  }
  assert.equal(byKind.reduce((a, b) => a + b, 0), all, 'the kinds add up to everything');
  assert.equal(await total('view=changes'), byKind[0], 'view=changes is kind=change');
  assert.equal(await total('kind=export,opened'), byKind[2]! + byKind[3]!);
  const mine = (await admin.get(`/audit?kind=export&userId=${fx().users.rep}&limit=200`)).json as AuditPage;
  assert.ok(mine.rows.length >= 1 && mine.rows.every((r) => r.userId === fx().users.rep && r.kind === 'export'));
  for (const q of ['kind=nope', 'kind=change,nope', 'view=all', 'view=changes&kind=change']) assert.equal((await admin.get(`/audit?${q}`)).status, 400, q);
  assert.equal((await admin.get('/audit?entity=invoice')).status, 200, 'the 1.3 entities filter too');
  assert.equal((await admin.get('/audit?kind=')).status, 200, 'an empty kind is no filter');
});

test('GET /audit and its filters: administrators only; a client 403 (portal only); anonymous 401', async () => {
  for (const c of [leader, recruiter, rep]) assert.equal((await c.get('/audit?kind=sign_in')).status, 403);
  const denied = await client.get('/audit');
  assert.equal(denied.status, 403);
  assert.equal(denied.json.clientPortalOnly, true);
  assert.equal((await srv.anon().get('/audit?view=changes')).status, 401);
});

// ───────────────────────────── GET /audit/people ─────────────────────────────

test('GET /audit/people: everyone the trail can name, client accounts included (admin); others 403, a client 403, anonymous 401', async () => {
  const res = await admin.get('/audit/people');
  assert.equal(res.status, 200);
  const people = res.json as AuditPerson[];
  const clientId = Number(get<{ id: number }>(srv.db, `SELECT id FROM users WHERE role = 'client'`)!.id);
  assert.ok(people.some((p) => p.id === clientId && p.role === 'client'));
  assert.ok(people.some((p) => p.id === fx().users.rep && p.role === 'rep' && p.name === 'Remy Rep' && p.status === 'active'));
  assert.equal(people.length, Number(get<{ n: number }>(srv.db, `SELECT COUNT(*) AS n FROM users`)!.n));
  // what the Person filter shows, nothing more: no employee IDs, no client access codes
  assert.deepEqual(Object.keys(people[0]!).sort(), ['id', 'name', 'role', 'status']);
  assert.ok(!JSON.stringify(people).includes(FIXTURE_ACCOUNTS.client.employeeId) && !JSON.stringify(people).includes(FIXTURE_ACCOUNTS.rep.employeeId));
  for (const c of [leader, recruiter, rep]) assert.equal((await c.get('/audit/people')).status, 403);
  assert.equal((await client.get('/audit/people')).json.clientPortalOnly, true);
  assert.equal((await srv.anon().get('/audit/people')).status, 401);
});

// ───────────────────────────── GET /audit/person/:userId ─────────────────────────────

test('GET /audit/person/:userId: what that person did, newest first, with their last sign-in and failed attempts (admin)', async () => {
  // a failed attempt on Remy's account
  assert.equal((await srv.anon().post('/auth/login', { email: FIXTURE_ACCOUNTS.rep.email, employeeId: 'NOT-HIS' })).status, 401);
  const res = await admin.get(`/audit/person/${fx().users.rep}?limit=200`);
  assert.equal(res.status, 200);
  const a = res.json as AuditPersonActivity;
  assert.equal(a.person.id, fx().users.rep);
  assert.equal(a.person.name, 'Remy Rep');
  assert.equal(a.total, rows(srv.db, 'WHERE user_id = ?', [fx().users.rep]).length);
  assert.ok(a.rows.every((r) => r.userId === fx().users.rep));
  assert.deepEqual(a.rows.map((r) => r.id), [...a.rows.map((r) => r.id)].sort((x, y) => y - x), 'newest first');
  assert.ok(a.lastSignInAt && a.lastActiveAt && a.lastActiveAt >= a.lastSignInAt);
  assert.equal(a.failedSignIns, 1);
  assert.equal(a.rows[0]!.summary, 'Failed sign-in: wrong employee ID');
  // someone else's try on Remy's account is not Remy being active: "Last active" stays on what Remy did
  const attempt = a.rows[0]!;
  assert.equal(a.lastActiveAt, a.rows.find((r) => r.id !== attempt.id)!.at);
  run(srv.db, `UPDATE audit_log SET at = ? WHERE id = ?`, [new Date(Date.now() + 60_000).toISOString(), attempt.id]);
  const later = (await admin.get(`/audit/person/${fx().users.rep}?limit=200`)).json as AuditPersonActivity;
  assert.equal(later.rows[0]!.id, attempt.id, 'still listed on the timeline, newest first');
  assert.notEqual(later.lastActiveAt, later.rows[0]!.at);
  assert.equal(later.lastActiveAt, a.lastActiveAt);
  run(srv.db, `UPDATE audit_log SET at = ? WHERE id = ?`, [attempt.at, attempt.id]);
  const exports = (await admin.get(`/audit/person/${fx().users.rep}?kind=export`)).json as AuditPersonActivity;
  assert.ok(exports.total >= 1 && exports.rows.every((r: AuditEntryDetail) => r.kind === 'export'));
  const paged = (await admin.get(`/audit/person/${fx().users.rep}?limit=2&offset=1`)).json as AuditPersonActivity;
  assert.deepEqual(paged.rows.map((r) => r.id), a.rows.slice(1, 3).map((r) => r.id));
  // a client account has a timeline too (the Audit page links to it)
  const clientId = Number(get<{ id: number }>(srv.db, `SELECT id FROM users WHERE role = 'client'`)!.id);
  const c = (await admin.get(`/audit/person/${clientId}`)).json as AuditPersonActivity;
  assert.equal(c.person.role, 'client');
  assert.ok(c.total >= 1);
});

test('GET /audit/person/:userId: 404 unknown, 400 bad id or kind; other roles 403, a client 403, anonymous 401; never read as an entity', async () => {
  assert.equal((await admin.get('/audit/person/999999')).status, 404);
  assert.equal((await admin.get('/audit/person/abc')).status, 400);
  assert.equal((await admin.get(`/audit/person/${fx().users.rep}?kind=bogus`)).status, 400);
  for (const c of [leader, recruiter, rep]) assert.equal((await c.get(`/audit/person/${fx().users.rep}`)).status, 403);
  assert.equal((await rep.get(`/audit/person/${fx().users.rep}`)).status, 403, 'not even your own: the office reads the trail');
  assert.equal((await client.get(`/audit/person/${fx().users.rep}`)).json.clientPortalOnly, true);
  assert.equal((await srv.anon().get(`/audit/person/${fx().users.rep}`)).status, 401);
  // the record history still answers for real entities
  assert.equal((await admin.get(`/audit/user/${fx().users.rep}`)).status, 200);
  assert.equal((await admin.get(`/audit/person/${fx().users.rep}`)).json.person.id, fx().users.rep);
});
