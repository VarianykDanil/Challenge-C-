/**
 * U3 audit-trail: the recording middleware (snapshots, summaries, pay runs moved by gauge writes, redaction, failures
 * write nothing), GET /audit (admin only, filters, paging), GET /audit/:entity/:entityId (admin; leaders their own
 * team's gauge entries), announcement read receipts and the two-year purge.
 *
 * The business clock is pinned to Thu 15 Oct 2026 15:00 (London): the fixture's last completed pay week is Mon 5 –
 * Sun 11 Oct. Audit times are the real clock.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AuditEntryDetail, AuditPage } from '@lm/shared';
import { all, get, openDb, run, type Db } from '../db/connection.ts';
import { createSchema } from '../db/schema.ts';
import { auditMiddleware, purgeAuditLog, recordAudit } from '../lib/audit.ts';
import { matchAuditRoute } from '../lib/auditSpecs.ts';
import { setBusinessClock, toBusinessISO } from '../lib/dates.ts';
import { londonMidnightUtc } from '../routes/audit.ts';
import { addEvent, addGauge, startTestServer, type Json, type TestClient, type TestServer } from './helpers.ts';

const TODAY = '2026-10-15';
const LAST_MONDAY = '2026-10-05';
setBusinessClock(new Date(`${TODAY}T15:00:00`)); // TZ=Europe/London in the server test script

let srv: TestServer;
let admin: TestClient;
let leader: TestClient;
let recruiter: TestClient;
let rep: TestClient;
let repB: TestClient;
const fx = () => srv.fixture!;
/** Remy's gauge entry on Wed 7 Oct (last completed week), written directly. */
let lastWeekEntry = 0;
let lastWeekEvent = 0;

const auditRows = (db: Db, where = '', params: (string | number)[] = []) =>
  all<{ id: number; userId: number | null; action: string; entity: string | null; entityId: number | null; summary: string; beforeJson: string | null; afterJson: string | null; ip: string | null }>(
    db,
    `SELECT id, user_id AS userId, action, entity, entity_id AS entityId, summary, before_json AS beforeJson, after_json AS afterJson, ip
     FROM audit_log ${where} ORDER BY id`,
    params,
  );
const auditCount = (db: Db) => Number(get<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM audit_log')!.n);
const newest = (db: Db) => auditRows(db).at(-1)!;
const parse = (s: string | null) => (s ? JSON.parse(s) : null);

before(async () => {
  srv = await startTestServer({ today: TODAY });
  const f = fx();
  lastWeekEvent = addEvent(srv.db, { campaignId: f.campaignId, teamId: f.teams.a, date: '2026-10-07' });
  lastWeekEntry = addGauge(srv.db, { eventId: lastWeekEvent, userId: f.users.rep, date: '2026-10-07', stops: 50, sales: 2 });
  [admin, leader, recruiter, rep, repB] = await Promise.all([
    srv.login('admin'), srv.login('leader'), srv.login('recruiter'), srv.login('rep'), srv.login('repB'),
  ]);
  await admin.get('/finance/payroll'); // materialise last week's runs (a normal side effect of the finance routes)
});

after(async () => {
  await srv.close();
  setBusinessClock(null);
});

test('registry: literal and :param patterns, method-specific, read receipts skipped', () => {
  assert.equal(matchAuditRoute('POST', '/finance/payroll/12/pay')?.spec.pattern, '/finance/payroll/:id/pay');
  assert.deepEqual(matchAuditRoute('POST', '/finance/payroll/12/pay')?.params, { id: '12' });
  assert.equal(matchAuditRoute('POST', '/gauges/bulk')?.spec.pattern, '/gauges/bulk');
  assert.equal(matchAuditRoute('POST', '/gauges/')?.spec.pattern, '/gauges');
  assert.equal(matchAuditRoute('PATCH', '/gauges/9')?.spec.pattern, '/gauges/:id');
  assert.equal(matchAuditRoute('GET', '/gauges/9'), null);
  assert.equal(matchAuditRoute('PUT', '/pitches/BCN')?.params.campaignCode, 'BCN');
  assert.equal(matchAuditRoute('POST', '/announcements/4/read')?.spec.skip, true);
  assert.equal(matchAuditRoute('POST', '/nothing/here'), null);
});

test('sign-ins are recorded with the person who signed in; failed sign-ins and reads write nothing', async () => {
  const signIns = auditRows(srv.db, `WHERE summary = 'Signed in'`);
  assert.ok(signIns.length >= 5, 'one per login in before()');
  assert.ok(signIns.every((r) => r.userId !== null && r.entity === 'user' && r.entityId === r.userId && r.action === 'POST /auth/login'));
  const n = auditCount(srv.db);
  const bad = await srv.anon().post('/auth/login', { email: fx().accounts.rep.email, employeeId: 'WRONG-1' });
  assert.equal(bad.status, 401);
  await rep.get('/me/dashboard');
  await admin.get('/finance/payroll');
  await admin.get('/audit');
  assert.equal(auditCount(srv.db), n, 'no row for a failed sign-in or any GET');
});

test('gauges: create, edit and delete are recorded with snapshots, a diff and a readable summary', async () => {
  const f = fx();
  const created = await rep.post('/gauges', { eventId: f.events.todayA, userId: f.users.rep, date: TODAY, stops: 40, table: 14, presentations: 7, closes: 3, taps: 2, sales: 2 });
  assert.equal(created.status, 201);
  const c = newest(srv.db);
  assert.equal(c.action, 'POST /gauges');
  assert.equal(c.entity, 'gauge_entry');
  assert.equal(c.entityId, created.json.id);
  assert.equal(c.userId, f.users.rep);
  assert.equal(c.summary, `Logged gauges: Remy Rep, 15 Oct at Team A ${TODAY}, 2 sales`);
  assert.equal(c.beforeJson, null);
  assert.equal(parse(c.afterJson).sales, 2);

  const edited = await leader.patch(`/gauges/${created.json.id}`, { sales: 3, taps: 3, closes: 3 });
  assert.equal(edited.status, 200);
  const e = newest(srv.db);
  assert.equal(e.action, 'PATCH /gauges/:id');
  assert.equal(e.userId, f.users.leader);
  assert.equal(e.summary, `Edited gauges: Remy Rep, 15 Oct at Team A ${TODAY}: taps 2 → 3, sales 2 → 3`);
  assert.equal(parse(e.beforeJson).sales, 2);
  assert.equal(parse(e.afterJson).sales, 3);

  // the same key through POST (an upsert) is an edit, not a second entry
  const again = await rep.post('/gauges', { eventId: f.events.todayA, userId: f.users.rep, date: TODAY, stops: 42, table: 14, presentations: 7, closes: 3, taps: 3, sales: 3 });
  assert.equal(again.status, 200);
  assert.match(newest(srv.db).summary, /^Edited gauges: Remy Rep, 15 Oct at .*: stops 40 → 42$/);

  const del = await leader.del(`/gauges/${created.json.id}`);
  assert.equal(del.status, 204);
  const d = newest(srv.db);
  assert.equal(d.action, 'DELETE /gauges/:id');
  assert.equal(d.summary, `Deleted gauges: Remy Rep, 15 Oct at Team A ${TODAY} (3 sales)`);
  assert.equal(d.afterJson, null);
  assert.equal(parse(d.beforeJson).stops, 42);
});

test('failed writes (403, 400, 404) write nothing', async () => {
  const f = fx();
  const n = auditCount(srv.db);
  assert.equal((await rep.post('/gauges', { eventId: f.events.todayB, userId: f.users.repB, date: TODAY, stops: 1, table: 0, presentations: 0, closes: 0, taps: 0, sales: 0 })).status, 403);
  assert.equal((await rep.post('/gauges', { eventId: f.events.todayA, userId: f.users.rep, date: TODAY, stops: 1, table: 5, presentations: 0, closes: 0, taps: 0, sales: 0 })).status, 400);
  assert.equal((await admin.patch('/gauges/999999', { sales: 1 })).status, 404);
  assert.equal((await rep.post(`/finance/payroll/1/pay`, {})).status, 403);
  assert.equal(auditCount(srv.db), n);
});

test('pay: a gauge change in an unpaid week records the run it recalculated; paying records "Marked paid"; a later admin change flags "Adjusted after payment"', async () => {
  const f = fx();
  const runRow = () => get<{ id: number; gross: number; status: string }>(srv.db, `SELECT id, gross, status FROM payroll_runs WHERE user_id = ? AND week_start = ?`, [f.users.rep, LAST_MONDAY])!;
  const run0 = runRow();
  assert.ok(run0 && run0.status === 'pending', 'last week has a pending run');

  const edit = await leader.patch(`/gauges/${lastWeekEntry}`, { sales: 3, taps: 3, closes: 3, presentations: 6 });
  assert.equal(edit.status, 200);
  const recalculated = auditRows(srv.db, `WHERE entity = 'payroll_run' AND entity_id = ?`, [run0.id]).at(-1)!;
  assert.equal(recalculated.action, 'PATCH /gauges/:id');
  assert.equal(recalculated.userId, f.users.leader);
  const run1 = runRow();
  assert.ok(run1.gross > run0.gross);
  assert.equal(recalculated.summary, `Recalculated after a gauge change: Remy Rep w/c 5 Oct, £${run0.gross} → £${run1.gross}`);

  const paid = await admin.post(`/finance/payroll/${run1.id}/pay`, {});
  assert.equal(paid.status, 200);
  const p = newest(srv.db);
  assert.equal(p.action, 'POST /finance/payroll/:id/pay');
  assert.equal(p.entity, 'payroll_run');
  assert.equal(p.entityId, run1.id);
  assert.equal(p.userId, f.users.admin);
  assert.equal(p.summary, `Marked paid: Remy Rep w/c 5 Oct, £${run1.gross}`);
  assert.equal(parse(p.beforeJson).status, 'pending');
  assert.equal(parse(p.afterJson).status, 'paid');

  const adjust = await admin.patch(`/gauges/${lastWeekEntry}`, { notes: 'Corrected after the paper sheet came in' });
  assert.equal(adjust.status, 200);
  const flagged = auditRows(srv.db, `WHERE entity = 'payroll_run' AND entity_id = ?`, [run1.id]).at(-1)!;
  assert.equal(flagged.summary, `Adjusted after payment: Remy Rep w/c 5 Oct, paid £${run1.gross}; the gauges changed`);

  // the payslip history (admin) lists all three, newest first, with a field diff
  const history = await admin.get(`/audit/payroll_run/${run1.id}`);
  assert.equal(history.status, 200);
  const rows = history.json as AuditEntryDetail[];
  assert.deepEqual(rows.map((r) => r.summary.split(':')[0]), ['Adjusted after payment', 'Marked paid', 'Recalculated after a gauge change']);
  const paidRow = rows[1]!;
  assert.deepEqual(paidRow.diff.find((d) => d.field === 'status'), { field: 'status', before: 'pending', after: 'paid' });
  assert.equal(paidRow.userName, 'Ada Admin');
  assert.ok(typeof paidRow.ip === 'string', 'admins see the IP');
});

test('people, events and announcements: deactivate, role change, cancel and post read as sentences', async () => {
  const f = fx();
  assert.equal((await admin.patch(`/users/${f.users.repA2}`, { role: 'leader', position: 'team_leader' })).status, 200);
  assert.equal(newest(srv.db).summary, 'Updated Rita Rep: role rep → leader, position field rep → team leader');
  assert.equal((await admin.patch(`/users/${f.users.repA2}`, { status: 'left' })).status, 200);
  assert.equal(newest(srv.db).summary, 'Deactivated Rita Rep');
  assert.equal((await admin.patch(`/users/${f.users.repA2}`, { status: 'active', role: 'rep', position: 'field_rep' })).status, 200);
  assert.match(newest(srv.db).summary, /^Reactivated Rita Rep: role leader → rep/);

  assert.equal((await leader.patch(`/events/${f.events.tomorrowA}`, { targetSales: 14 })).status, 200);
  assert.equal(newest(srv.db).summary, `Updated event: Team A 2026-10-16, 16 Oct: target 10 → 14`);
  assert.equal((await leader.patch(`/events/${f.events.tomorrowA}`, { status: 'cancelled' })).status, 200);
  assert.equal(newest(srv.db).summary, `Cancelled event: Team A 2026-10-16, 16 Oct`);

  const ann = await leader.post('/announcements', { title: 'Rota for next week', body: 'Check the team chat.' });
  assert.equal(ann.status, 201);
  const a = newest(srv.db);
  assert.equal(a.summary, 'Posted announcement: “Rota for next week”');
  assert.equal(a.entity, 'announcement');
  assert.equal(a.entityId, ann.json.id);
});

test('nothing secret is stored: no session token, PIN, two-step secret or recovery code in any snapshot', async () => {
  const setup = await admin.post('/auth/2fa/setup', {});
  assert.equal(setup.status, 201);
  assert.equal(newest(srv.db).summary, 'Started setting up two-step verification');
  recordAudit(srv.db, { userId: null, action: 'TEST', summary: 'redaction check', after: { name: 'x', pin: '1234', nested: { recoveryCodes: ['a'], sessionToken: 't' } } });
  const stored = parse(newest(srv.db).afterJson);
  assert.deepEqual(stored, { name: 'x', pin: '[redacted]', nested: { recoveryCodes: '[redacted]', sessionToken: '[redacted]' } });
  const everything = auditRows(srv.db).map((r) => `${r.beforeJson ?? ''}${r.afterJson ?? ''}${r.summary}`).join('\n');
  for (const client of [admin, leader, rep]) {
    const token = client.cookie.replace('lm_session=', '');
    assert.ok(token.length > 10 && !everything.includes(token), 'no session token');
  }
  const secrets = all<{ s: string | null; p: string | null }>(srv.db, `SELECT totp_secret_enc AS s, totp_pending_enc AS p FROM users`);
  for (const s of secrets) for (const v of [s.s, s.p]) if (v) assert.ok(!everything.includes(v), 'no two-step secret');
  assert.ok(!/totp|secret/i.test(everything.replace(/two-step/g, '')), 'no secret-looking keys');
});

test('GET /audit: admin only; filters by person, entity, record, London dates and words; pages with a total', async () => {
  const f = fx();
  for (const c of [leader, recruiter, rep]) assert.equal((await c.get('/audit')).status, 403);
  const all1 = await admin.get('/audit?limit=500');
  assert.equal(all1.status, 200);
  const page = all1.json as AuditPage;
  assert.equal(page.total, auditCount(srv.db));
  assert.equal(page.rows.length, Math.min(200, page.total), 'limit capped at 200');
  const ids = page.rows.map((r) => r.id);
  assert.deepEqual(ids, [...ids].sort((a, b) => b - a), 'newest first');

  const byLeader = (await admin.get(`/audit?userId=${f.users.leader}`)).json as AuditPage;
  assert.ok(byLeader.total > 0 && byLeader.rows.every((r) => r.userId === f.users.leader && r.userName === 'Lee Leader'));
  const runs = (await admin.get('/audit?entity=payroll_run')).json as AuditPage;
  assert.ok(runs.total >= 3 && runs.rows.every((r) => r.entity === 'payroll_run'));
  const one = (await admin.get(`/audit?entity=gauge_entry&entityId=${lastWeekEntry}`)).json as AuditPage;
  assert.ok(one.total >= 2 && one.rows.every((r) => r.entityId === lastWeekEntry));
  const words = (await admin.get('/audit?q=marked%20PAID')).json as AuditPage;
  assert.ok(words.total >= 1 && words.rows.every((r) => /marked paid/i.test(r.summary)));
  assert.equal(((await admin.get('/audit?q=100%25_')).json as AuditPage).total, 0, 'LIKE wildcards are literal');
  const changesOnly = (await admin.get('/audit?signIns=0&limit=200')).json as AuditPage;
  const signIns = auditRows(srv.db, `WHERE action IN ('POST /auth/login', 'POST /auth/login/2fa', 'POST /auth/logout')`).length;
  assert.ok(signIns > 0);
  assert.equal(changesOnly.total, page.total - signIns, 'signIns=0 leaves sign-ins and sign-outs out');
  assert.ok(changesOnly.rows.every((r) => !r.action.startsWith('POST /auth/log')));
  assert.equal((await admin.get('/audit?signIns=maybe')).status, 400);

  const realToday = toBusinessISO(new Date()).slice(0, 10);
  assert.equal(((await admin.get(`/audit?from=${realToday}&to=${realToday}`)).json as AuditPage).total, page.total, 'everything happened today');
  assert.equal(((await admin.get('/audit?to=2020-01-01')).json as AuditPage).total, 0);

  const p1 = (await admin.get('/audit?limit=2')).json as AuditPage;
  const p2 = (await admin.get('/audit?limit=2&offset=2')).json as AuditPage;
  assert.equal(p1.rows.length, 2);
  assert.notEqual(p1.rows[0]!.id, p2.rows[0]!.id);
  assert.equal(p2.total, p1.total);

  assert.equal((await admin.get('/audit?entity=payroll')).status, 400);
  assert.equal((await admin.get('/audit?from=2026-13-01')).status, 400);
  assert.equal((await admin.get('/audit?from=2026-10-20&to=2026-10-01')).status, 400);
  assert.equal((await admin.get('/audit?limit=0')).status, 400);
});

test('GET /audit/:entity/:entityId: leaders see their own team\'s gauge entries (no IP), nothing else', async () => {
  const f = fx();
  const history = await leader.get(`/audit/gauge_entry/${lastWeekEntry}`);
  assert.equal(history.status, 200);
  const rows = history.json as AuditEntryDetail[];
  assert.ok(rows.length >= 2);
  assert.ok(rows.every((r) => r.ip === null && r.entity === 'gauge_entry' && r.entityId === lastWeekEntry));
  assert.ok(rows.some((r) => r.diff.some((d) => d.field === 'sales')));

  // a team B entry, and a deleted team A entry judged by its snapshot
  const bEvent = addEvent(srv.db, { campaignId: f.campaignId, teamId: f.teams.b, date: '2026-10-14' });
  const bEntry = await admin.post('/gauges', { eventId: bEvent, userId: f.users.repB, date: '2026-10-14', stops: 30, table: 10, presentations: 5, closes: 2, taps: 1, sales: 1 });
  assert.equal(bEntry.status, 201);
  assert.equal((await leader.get(`/audit/gauge_entry/${bEntry.json.id}`)).status, 403);
  assert.equal((await admin.get(`/audit/gauge_entry/${bEntry.json.id}`)).status, 200);
  const deleted = auditRows(srv.db, `WHERE entity = 'gauge_entry' AND action = 'DELETE /gauges/:id'`)[0]!;
  assert.equal((await leader.get(`/audit/gauge_entry/${deleted.entityId}`)).status, 200, 'a deleted entry of the team');

  for (const path of [`/audit/payroll_run/1`, `/audit/user/${f.users.rep}`]) assert.equal((await leader.get(path)).status, 403, path);
  for (const c of [rep, repB, recruiter]) assert.equal((await c.get(`/audit/gauge_entry/${lastWeekEntry}`)).status, 403);
  assert.equal((await admin.get('/audit/nonsense/1')).status, 400);
  assert.equal((await admin.get('/audit/gauge_entry/abc')).status, 400);
  assert.deepEqual((await admin.get('/audit/expense/999999')).json, []);
});

test('announcement read receipts: idempotent, never in the audit log, "Read by N of M" for admins and the author only', async () => {
  const f = fx();
  const ann = (await leader.post('/announcements', { title: 'Read me', body: 'Please' })).json;
  const n = auditCount(srv.db);
  assert.equal((await rep.post(`/announcements/${ann.id}/read`)).status, 204);
  assert.equal((await rep.post(`/announcements/${ann.id}/read`)).status, 204);
  assert.equal((await repB.post(`/announcements/${ann.id}/read`)).status, 204);
  assert.equal((await leader.post(`/announcements/${ann.id}/read`)).status, 204, "the author's own read is stored but never counted");
  assert.equal((await rep.post('/announcements/999999/read')).status, 404);
  assert.equal((await rep.post('/announcements/abc/read')).status, 400);
  assert.equal(auditCount(srv.db), n, 'read receipts are not audit rows');
  const firstRead = get<{ at: string }>(srv.db, `SELECT read_at AS at FROM announcement_reads WHERE announcement_id = ? AND user_id = ?`, [ann.id, f.users.rep])!.at;
  assert.ok(firstRead);

  const active = Number(get<{ n: number }>(srv.db, `SELECT COUNT(*) AS n FROM users WHERE status = 'active'`)!.n);
  const mine = (await leader.get('/announcements/reads')).json as Json[];
  assert.ok(mine.length >= 1);
  assert.ok(mine.every((s) => get<{ a: number }>(srv.db, `SELECT author_id AS a FROM announcements WHERE id = ?`, [s.announcementId])!.a === f.users.leader), 'only the ones they wrote');
  const stat = mine.find((s) => s.announcementId === ann.id);
  assert.equal(stat.readCount, 2);
  assert.equal(stat.audience, active - 1);
  assert.deepEqual(stat.readers.map((r: Json) => r.name).sort(), ['Bo Rep', 'Remy Rep']);

  const adminStats = (await admin.get(`/announcements/reads?ids=${ann.id}`)).json as Json[];
  assert.equal(adminStats.length, 1);
  assert.equal(adminStats[0].readCount, 2);
  assert.deepEqual((await rep.get('/announcements/reads')).json, [], 'reps wrote none');
  assert.equal((await admin.get('/announcements/reads?ids=1,x')).status, 400);
});

test('purge keeps two years', () => {
  const db = openDb(':memory:');
  try {
    createSchema(db);
    const now = new Date('2026-10-20T12:00:00Z');
    for (const at of ['2024-10-19T11:00:00.000Z', '2024-10-21T12:00:00.000Z', '2026-10-20T11:00:00.000Z']) {
      run(db, `INSERT INTO audit_log (at, user_id, action, summary) VALUES (?, NULL, 'TEST', 'x')`, [at]);
    }
    assert.equal(purgeAuditLog(db, now), 1);
    assert.equal(purgeAuditLog(db, now), 0);
    assert.equal(Number(get<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM audit_log')!.n), 2);
  } finally {
    db.close();
  }
});

test('London calendar days: summer and winter midnights in UTC', () => {
  assert.equal(londonMidnightUtc('2026-07-01'), '2026-06-30T23:00:00.000Z');
  assert.equal(londonMidnightUtc('2026-12-01'), '2026-12-01T00:00:00.000Z');
  assert.equal(londonMidnightUtc('2026-10-25'), '2026-10-24T23:00:00.000Z', 'the clocks go back at 02:00 BST that day');
});

test('unregistered writes are still recorded (method, route pattern, user); an audit failure never breaks the request', async () => {
  const db = openDb(':memory:');
  createSchema(db);
  const app = express();
  app.use(express.json());
  const api = express.Router();
  api.use((req, _res, next) => {
    req.user = { id: 7 } as Json;
    next();
  });
  api.use(auditMiddleware(db));
  const things = express.Router();
  things.post('/:id/zap', (_req, res) => {
    res.status(201).json({ ok: true });
  });
  things.delete('/:id', (_req, res) => {
    res.status(500).json({ error: 'boom' });
  });
  api.use('/things', things);
  app.use('/api', api);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  try {
    assert.equal((await fetch(`${base}/things/42/zap`, { method: 'POST' })).status, 201);
    const rows = auditRows(db);
    assert.equal(rows.length, 1);
    assert.deepEqual({ ...rows[0], id: 0, ip: null }, { id: 0, userId: 7, action: 'POST /things/:id/zap', entity: null, entityId: null, summary: 'POST /things/:id/zap', beforeJson: null, afterJson: null, ip: null });
    assert.equal((await fetch(`${base}/things/42`, { method: 'DELETE' })).status, 500);
    assert.equal(auditRows(db).length, 1, 'a 5xx writes nothing');
    db.exec('DROP TABLE audit_log');
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => void errors.push(args);
    try {
      const r = await fetch(`${base}/things/43/zap`, { method: 'POST' });
      assert.equal(r.status, 201, 'the request still succeeds');
      assert.deepEqual(await r.json(), { ok: true });
    } finally {
      console.error = original;
    }
    assert.equal(errors.length, 1, 'the failure is logged once');
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  }
});
