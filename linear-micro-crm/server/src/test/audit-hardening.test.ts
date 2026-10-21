/**
 * Release 1.2 review fixes for the audit trail (security review S2 and S6):
 *  - S2: a leader's view of a gauge entry's history never shows another team's private details (notes, check-in
 *    time), even when the entry has been moved onto the leader's team since (the reviewer's probe5 scenario);
 *  - S6: writes that change nothing write no audit row (check-in replays whatever their body carries, a teach-back
 *    saved with the same text, a pitch saved unchanged, sign-in settings saved with the same values, a self-check
 *    retake that changes no field, a repeated sign-off or one taken back where there was none); long text in snapshots
 *    is stored as { length, sha256, head }; the per-person write limit.
 *
 * The business clock is pinned to Thu 15 Oct 2026 15:00 (London). Audit times and the write limit use the real clock.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { LESSON_KEYS, type AuditEntryDetail, type AuditPage, type UserWithTeam } from '@lm/shared';
import { get, run, type Db } from '../db/connection.ts';
import { AUDIT_LONG_TEXT_HEAD, AUDIT_LONG_TEXT_MIN, compactLongText, isAuditLongText } from '../lib/audit.ts';
import { matchAuditRoute, type AuditCall } from '../lib/auditSpecs.ts';
import { setBusinessClock } from '../lib/dates.ts';
import { WRITE_LIMIT_MESSAGE, WRITE_LIMIT_PER_MINUTE, isWriteLimited, perUserWriteLimit } from '../middleware/writeLimit.ts';
import { startTestServer, type Json, type TestClient, type TestServer } from './helpers.ts';

const TODAY = '2026-10-15';
const YESTERDAY = '2026-10-14';
setBusinessClock(new Date(`${TODAY}T15:00:00`)); // TZ=Europe/London in the server test script

let srv: TestServer;
let admin: TestClient;
let leader: TestClient;
let rep: TestClient;
let repA2: TestClient;
const fx = () => srv.fixture!;
const LESSON = LESSON_KEYS[0]!;
const G = { stops: 40, table: 12, presentations: 6, closes: 3, taps: 2, sales: 1 };

const auditCount = (db: Db, where = '', params: (string | number)[] = []) =>
  Number(get<{ n: number }>(db, `SELECT COUNT(*) AS n FROM audit_log ${where}`, params)!.n);
const newest = (db: Db) =>
  get<{ action: string; summary: string; beforeJson: string | null; afterJson: string | null }>(
    db,
    `SELECT action, summary, before_json AS beforeJson, after_json AS afterJson FROM audit_log ORDER BY id DESC LIMIT 1`,
  )!;
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

before(async () => {
  srv = await startTestServer({ today: TODAY });
  [admin, leader, rep, repA2] = await Promise.all([srv.login('admin'), srv.login('leader'), srv.login('rep'), srv.login('repA2')]);
});

after(async () => {
  await srv.close();
  setBusinessClock(null);
});

// ───────────────────────────── S2: moved entries ─────────────────────────────

test('S2: a leader reading a moved entry\'s history never sees the other team\'s notes or check-in time', async () => {
  const f = fx();
  // admin logs Bo (team B) at team B's event with a private note and a check-in time ...
  const g = await admin.post('/gauges', { eventId: f.events.yesterdayB, userId: f.users.repB, date: YESTERDAY, ...G, notes: 'PRIVATE-B-NOTE', checkedInAt: `${YESTERDAY}T09:41` });
  assert.equal(g.status, 201, JSON.stringify(g.json));
  assert.equal((await leader.get(`/audit/gauge_entry/${g.json.id}`)).status, 403, 'team B entry: no history for team A\'s leader');
  // ... then moves it to Remy (team A) at team A's event
  const m = await admin.patch(`/gauges/${g.json.id}`, { eventId: f.events.yesterdayA, userId: f.users.rep, notes: null, checkedInAt: null });
  assert.equal(m.status, 200, JSON.stringify(m.json));
  // a note on team A is the leader's to see
  assert.equal((await admin.patch(`/gauges/${g.json.id}`, { notes: 'TEAM-A-NOTE', checkedInAt: `${YESTERDAY}T10:05` })).status, 200);

  const h = await leader.get(`/audit/gauge_entry/${g.json.id}`);
  assert.equal(h.status, 200);
  const text = JSON.stringify(h.json);
  assert.ok(!text.includes('PRIVATE-B-NOTE'), `team B's note leaked: ${text}`);
  assert.ok(!text.includes('09:41'), `team B's check-in time leaked: ${text}`);
  assert.ok(text.includes('TEAM-A-NOTE'), 'team A details stay visible');
  assert.ok(text.includes('10:05'));
  const rows = h.json as AuditEntryDetail[];
  assert.equal(rows.length, 3);
  const [edit, move, create] = rows;
  // the create: Bo's snapshot, numbers only
  assert.equal((create!.after as Json).notes, null);
  assert.equal((create!.after as Json).checkedInAt, null);
  assert.equal((create!.after as Json).sales, 1, 'the numbers are kept');
  assert.ok(!create!.diff.some((d) => d.field === 'notes' || d.field === 'checkedInAt'));
  // the move: the diff and the summary are rebuilt from what the leader may see
  assert.ok(move!.diff.some((d) => d.field === 'userName'));
  assert.ok(!move!.diff.some((d) => d.field === 'notes' || d.field === 'checkedInAt'));
  assert.match(move!.summary, /^Edited gauges: Bo Rep, 14 Oct at Team B 2026-10-14: person Bo Rep → Remy Rep, event /);
  // the edit on team A is untouched
  assert.ok(edit!.diff.some((d) => d.field === 'notes' && d.after === 'TEAM-A-NOTE'));

  // admins still see everything
  const adminText = JSON.stringify((await admin.get(`/audit/gauge_entry/${g.json.id}`)).json);
  assert.ok(adminText.includes('PRIVATE-B-NOTE') && adminText.includes('09:41'));
});

test('S2: a leader\'s own team\'s history is unchanged (stored summary, full snapshots)', async () => {
  const f = fx();
  const own = await leader.post('/gauges', { eventId: f.events.yesterdayA, userId: f.users.repA2, date: YESTERDAY, ...G, notes: 'RITA-NOTE', checkedInAt: `${YESTERDAY}T08:58` });
  assert.equal(own.status, 201, JSON.stringify(own.json));
  const stored = newest(srv.db);
  const rows = (await leader.get(`/audit/gauge_entry/${own.json.id}`)).json as AuditEntryDetail[];
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.summary, stored.summary);
  assert.equal((rows[0]!.after as Json).notes, 'RITA-NOTE');
  assert.match(String((rows[0]!.after as Json).checkedInAt), /T08:58/);
});

// ───────────────────────────── S6: writes that change nothing ─────────────────────────────

test('S6: a check-in replay ("already recorded") writes no audit row', async () => {
  const f = fx();
  const first = await rep.post('/checkins', { eventId: f.events.todayA });
  assert.equal(first.status, 201, JSON.stringify(first.json));
  const n = auditCount(srv.db, `WHERE entity = 'check_in'`);
  assert.equal(n, 1);
  for (let i = 0; i < 5; i++) assert.equal((await rep.post('/checkins', { eventId: f.events.todayA })).status, 200);
  assert.equal(auditCount(srv.db, `WHERE entity = 'check_in'`), n, 'replays answered "already recorded" add nothing');
});

test('S6: a teach-back saved with the same text writes no audit row; a changed text does', async () => {
  const f = fx();
  // passed the self-check (written directly: this test is about the teach-back, whatever the quiz body looks like)
  run(srv.db, `INSERT INTO learning_progress (user_id, lesson_key, learned_at, quiz_score, quiz_total, updated_at) VALUES (?, ?, ?, 3, 3, ?)`, [
    f.users.rep, LESSON, `${TODAY}T10:00:00`, `${TODAY}T10:00:00`,
  ]);
  const text = 'You stop people with a smile and a simple question, then you listen.';
  assert.equal((await rep.post(`/learning/progress/${LESSON}/teachback`, { text })).status, 200);
  const n = auditCount(srv.db, `WHERE entity = 'learning'`);
  assert.equal(n, 1);
  assert.equal((await rep.post(`/learning/progress/${LESSON}/teachback`, { text })).status, 200);
  assert.equal((await rep.post(`/learning/progress/${LESSON}/teachback`, { text: `  ${text}  ` })).status, 200, 'trimmed, so the same text');
  assert.equal(auditCount(srv.db, `WHERE entity = 'learning'`), n);
  assert.equal((await rep.post(`/learning/progress/${LESSON}/teachback`, { text: `${text} Then I ask for the sale.` })).status, 200);
  assert.equal(auditCount(srv.db, `WHERE entity = 'learning'`), n + 1);
});

test('S6: a repeated sign-off that keeps the first signer writes no audit row', async () => {
  const f = fx();
  const url = `/learning/progress/${f.users.rep}/${LESSON}/signoff`;
  assert.equal((await leader.post(url, { signedOff: true })).status, 200);
  const n = auditCount(srv.db, `WHERE entity = 'learning'`);
  assert.equal((await admin.post(url, { signedOff: true })).status, 200);
  assert.equal(auditCount(srv.db, `WHERE entity = 'learning'`), n);
});

test('S6: a check-in replay writes no audit row whatever its body carries (no date, a stray userId)', async () => {
  const f = fx();
  const checkIns = () => auditCount(srv.db, `WHERE entity = 'check_in'`);
  // (a) an offline replay for an earlier day that sends checkedInAt but no date: the route takes the day from the time
  const offline = { eventId: f.events.yesterdayA, checkedInAt: `${YESTERDAY}T09:30`, source: 'offline' };
  const n0 = checkIns();
  assert.equal((await rep.post('/checkins', offline)).status, 201);
  assert.equal(checkIns(), n0 + 1);
  assert.match(newest(srv.db).summary, /^Checked in: Remy Rep at .+, 14 Oct 09:30$/);
  for (let i = 0; i < 3; i++) assert.equal((await rep.post('/checkins', offline)).status, 200);
  for (let i = 0; i < 2; i++) assert.equal((await rep.post('/checkins', { ...offline, date: YESTERDAY })).status, 200);
  assert.equal(checkIns(), n0 + 1, 'replays without (or with) the date add nothing');
  // (b) a stray userId in the body: the route ignores it (always the signed-in person); so does the trail
  const n1 = checkIns();
  for (let i = 0; i < 3; i++) assert.equal((await rep.post('/checkins', { eventId: f.events.todayA, userId: f.users.leader })).status, 200);
  assert.equal(checkIns(), n1, 'a stray userId does not turn a replay into a new row');
  // the leader's own first check-in is still recorded once, for the leader, with no before
  assert.equal((await leader.post('/checkins', { eventId: f.events.todayA, userId: f.users.rep })).status, 201);
  assert.equal(checkIns(), n1 + 1);
  const row = newest(srv.db);
  assert.match(row.summary, /^Checked in: Lee Leader at /);
  assert.equal(row.beforeJson, null);
  assert.equal((await leader.post('/checkins', { eventId: f.events.todayA })).status, 200);
  assert.equal(checkIns(), n1 + 1);
});

test('S6: taking back a sign-off: recorded when there was one, nothing when there was none', async () => {
  const f = fx();
  const learning = () => auditCount(srv.db, `WHERE entity = 'learning'`);
  // nothing signed off, no progress row at all: 200 and no row
  const none = `/learning/progress/${f.users.repA2}/${LESSON_KEYS[2]!}/signoff`;
  const n0 = learning();
  assert.equal((await leader.post(none, { signedOff: false })).status, 200);
  assert.equal((await admin.post(none, { signedOff: false })).status, 200);
  assert.equal(learning(), n0, 'a take-back where there was no sign-off adds nothing');
  // Remy's sign-off from the test above: taken back once (recorded, and worded as a take-back), then again (nothing)
  const url = `/learning/progress/${f.users.rep}/${LESSON}/signoff`;
  assert.equal((await leader.post(url, { signedOff: false })).status, 200);
  assert.equal(learning(), n0 + 1);
  const row = newest(srv.db);
  assert.match(row.summary, /^Took back a teach-back sign-off: Remy Rep, /);
  assert.ok(JSON.parse(row.beforeJson!).signedOffAt && JSON.parse(row.afterJson!).signedOffAt === null);
  assert.equal((await leader.post(url, { signedOff: false })).status, 200);
  assert.equal(learning(), n0 + 1, 'nothing left to take back');
});

test('S6: a self-check retake that changes no stored field writes no audit row (registry)', () => {
  const f = fx();
  const db = srv.db;
  const key = LESSON_KEYS[1]!;
  const path = `/learning/progress/${key}/quiz`;
  const match = matchAuditRoute('POST', path)!;
  assert.ok(match);
  const me = { id: f.users.repA2 } as UserWithTeam;
  const call: AuditCall = { method: 'POST', path, params: match.params, body: {}, me };
  const done = (c: AuditCall) => ({ ...c, status: 200, response: {} });
  // first attempt (failed): a new row → recorded
  let state = match.spec.before!(db, call);
  run(db, `INSERT INTO learning_progress (user_id, lesson_key, quiz_score, quiz_total, updated_at) VALUES (?, ?, 1, 3, ?)`, [me.id, key, `${TODAY}T11:00:00`]);
  assert.equal(match.spec.after(db, done(call), state).length, 1);
  // the same failed score again: only updated_at moved → nothing to record
  state = match.spec.before!(db, call);
  run(db, `UPDATE learning_progress SET quiz_score = 1, updated_at = ? WHERE user_id = ? AND lesson_key = ?`, [`${TODAY}T11:05:00`, me.id, key]);
  assert.deepEqual(match.spec.after(db, done(call), state), []);
  // a better score → recorded
  state = match.spec.before!(db, call);
  run(db, `UPDATE learning_progress SET quiz_score = 2 WHERE user_id = ? AND lesson_key = ?`, [me.id, key]);
  assert.equal(match.spec.after(db, done(call), state).length, 1);
});

test('S6: a pitch saved unchanged writes no audit row', async () => {
  const body = { title: 'Fixture pitch', body: 'Hi there, have you got a minute?\n(Pause - 1 Second)\n\nWhat we do is…' };
  assert.equal((await admin.put('/pitches/FXC', body)).status, 201);
  const n = auditCount(srv.db, `WHERE entity = 'pitch'`);
  assert.equal(n, 1);
  assert.equal((await admin.put('/pitches/FXC', body)).status, 200);
  assert.equal((await leader.put('/pitches/fxc', body)).status, 200, 'another person, same words');
  assert.equal(auditCount(srv.db, `WHERE entity = 'pitch'`), n);
  assert.equal((await admin.put('/pitches/FXC', { ...body, title: 'Fixture pitch v2' })).status, 200);
  assert.equal(auditCount(srv.db, `WHERE entity = 'pitch'`), n + 1);
  assert.equal(newest(srv.db).summary, 'Edited the FXC pitch: title Fixture pitch → Fixture pitch v2');
});

test('S6: sign-in settings saved with the same values write no audit row; the before is what is stored', async () => {
  const n0 = auditCount(srv.db, `WHERE entity = 'settings'`);
  assert.equal((await admin.put('/auth/security-settings', { sessionIdleHours: 12 })).status, 200, 'the default');
  assert.equal(auditCount(srv.db, `WHERE entity = 'settings'`), n0);
  assert.equal((await admin.put('/auth/security-settings', { sessionIdleHours: 10 })).status, 200);
  assert.equal(auditCount(srv.db, `WHERE entity = 'settings'`), n0 + 1);
  assert.equal(newest(srv.db).summary, 'Changed sign-in settings: sign out after idle (hours) 12 → 10');
  assert.equal((await admin.put('/auth/security-settings', { sessionIdleHours: 10, requirePin: false })).status, 200);
  assert.equal(auditCount(srv.db, `WHERE entity = 'settings'`), n0 + 1);
  // changed behind the trail's back (no audit row): the next change still starts from what is stored
  run(srv.db, `UPDATE meta SET value = '9' WHERE key = 'ext:pin:session-idle-hours'`);
  srv.resetCache();
  assert.equal((await admin.put('/auth/security-settings', { sessionIdleHours: 12 })).status, 200);
  assert.equal(newest(srv.db).summary, 'Changed sign-in settings: sign out after idle (hours) 9 → 12');
});

// ───────────────────────────── S6: long text ─────────────────────────────

test('S6: long text is stored as { length, sha256, head } (over 2,000 characters only, at any depth)', () => {
  const long = `Start. ${'y'.repeat(AUDIT_LONG_TEXT_MIN)}`;
  const exact = 'z'.repeat(AUDIT_LONG_TEXT_MIN);
  const out = compactLongText({ body: long, exact, n: 3, nested: { notes: long }, list: [long, 'short'], none: null }) as Json;
  assert.deepEqual(out.body, { length: long.length, sha256: sha(long), head: long.slice(0, AUDIT_LONG_TEXT_HEAD) });
  assert.equal(out.exact, exact, '2,000 characters exactly are kept as they are');
  assert.equal(out.n, 3);
  assert.deepEqual(out.nested.notes, out.body);
  assert.deepEqual(out.list, [out.body, 'short']);
  assert.equal(out.none, null);
  assert.ok(isAuditLongText(out.body));
  assert.ok(!isAuditLongText({ length: 3 }) && !isAuditLongText('text') && !isAuditLongText(null));
});

test('S6: a long pitch script: stored compactly, the diff still says it changed, the summary names it', async () => {
  const script1 = `Hi, have you got a minute?\n(Pause - 1 Second)\n\n${'We fund research into breast cancer. '.repeat(80)}`;
  const script2 = `${script1}\nThank you for your time.`;
  assert.equal((await admin.put('/pitches/FXC', { title: 'Long one', body: script1 })).status, 200);
  assert.equal((await admin.put('/pitches/FXC', { title: 'Long one', body: script2 })).status, 200);
  const stored = get<{ body: string }>(srv.db, `SELECT body FROM campaign_pitches WHERE campaign_id = ?`, [fx().campaignId])!.body;
  assert.ok(stored.length > AUDIT_LONG_TEXT_MIN);
  const row = newest(srv.db);
  assert.equal(row.summary, 'Edited the FXC pitch: script', 'a pitch\'s text is its script, as the audit views label it');
  assert.ok(row.afterJson!.length < 1000, `after_json is small: ${row.afterJson!.length} characters`);
  const after = JSON.parse(row.afterJson!);
  assert.deepEqual(after.body, { length: stored.length, sha256: sha(stored), head: stored.slice(0, AUDIT_LONG_TEXT_HEAD) });
  assert.equal(after.title, 'Long one');

  const page = (await admin.get('/audit?entity=pitch&limit=1')).json as AuditPage;
  const diff = page.rows[0]!.diff;
  assert.deepEqual(diff.map((d) => d.field), ['body']);
  assert.ok(isAuditLongText(diff[0]!.before) && isAuditLongText(diff[0]!.after));
  assert.notEqual((diff[0]!.before as Json).sha256, (diff[0]!.after as Json).sha256);

  // the same long script again: nothing changed, nothing recorded
  const n = auditCount(srv.db, `WHERE entity = 'pitch'`);
  assert.equal((await admin.put('/pitches/FXC', { title: 'Long one', body: script2 })).status, 200);
  assert.equal(auditCount(srv.db, `WHERE entity = 'pitch'`), n);
});

// ───────────────────────────── S6: the per-person write limit ─────────────────────────────

test('S6: which writes the per-person limit covers', () => {
  for (const [method, path] of [
    ['POST', '/learning/progress/five-steps/quiz'],
    ['POST', '/learning/progress/five-steps/teachback'],
    ['POST', '/learning/progress/12/five-steps/signoff'],
    ['POST', '/LEARNING/progress/five-steps/quiz'],
    ['PUT', '/pitches/BCN'],
    ['POST', '/checkins'],
    ['POST', '/checkins/'],
    ['POST', '/auth/pin'],
    ['POST', '/auth/pin/remove'],
    ['POST', '/gauges/bulk'],
  ] as const) assert.ok(isWriteLimited(method, path), `${method} ${path}`);
  for (const [method, path] of [
    ['GET', '/learning/progress'],
    ['GET', '/pitches/BCN'],
    ['PUT', '/learning/milestones/3/offices'],
    ['DELETE', '/checkins/4'],
    ['POST', '/checkinsx'],
    ['POST', '/auth/login'],
    ['POST', '/auth/pinx'],
    ['POST', '/gauges'],
    ['PATCH', '/gauges/7'],
  ] as const) assert.ok(!isWriteLimited(method, path), `${method} ${path}`);
});

test(`S6: the ${WRITE_LIMIT_PER_MINUTE + 1}st limited write in a minute is refused (429, a plain sentence); others are not held up`, async () => {
  const f = fx();
  const statuses: number[] = [];
  for (let i = 0; i < WRITE_LIMIT_PER_MINUTE; i++) statuses.push((await repA2.post('/checkins', { eventId: f.events.todayA })).status);
  assert.deepEqual([...new Set(statuses)].sort(), [200, 201]);
  const refused = await repA2.post('/checkins', { eventId: f.events.todayA });
  assert.equal(refused.status, 429);
  assert.deepEqual(refused.json, { error: WRITE_LIMIT_MESSAGE });
  assert.equal(refused.headers.get('retry-after'), '60');
  assert.equal((await repA2.put('/pitches/FXC', { title: 'x', body: 'y' })).status, 429, 'one budget across the limited routes');
  assert.equal((await repA2.get('/checkins?eventId=' + f.events.todayA)).status, 200, 'reads are never limited');
  assert.equal((await repA2.post('/gauges', { eventId: f.events.todayA, userId: f.users.repA2, date: TODAY, ...G })).status, 201, 'unlisted writes are not limited');
  assert.equal((await rep.post('/checkins', { eventId: f.events.todayA })).status, 200, 'another person has their own budget');
  assert.equal((await srv.anon().post('/checkins', { eventId: f.events.todayA })).status, 401, 'signed out: 401 as before');
});

test('S6: the write limit counts per person in a one-minute window, refusals do not count, and it can be turned off', async () => {
  let now = 1_000_000;
  const app = express();
  app.use((req, _res, next) => {
    const id = Number(req.headers['x-user'] ?? 0);
    if (id) req.user = { id } as UserWithTeam;
    next();
  });
  app.use(perUserWriteLimit({ perMinute: 2, now: () => now }));
  app.use(express.Router().post('/checkins', (_req, res) => void res.status(204).end()));
  const off = express();
  off.use((req, _res, next) => void ((req.user = { id: 1 } as UserWithTeam), next()));
  off.use(perUserWriteLimit({ perMinute: 0 }));
  off.use(express.Router().post('/checkins', (_req, res) => void res.status(204).end()));
  app.use(((err, _req, res, _next) => void res.status(err.status ?? 500).json({ error: err.message })) as express.ErrorRequestHandler);
  const servers = [http.createServer(app), http.createServer(off)];
  await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.listen(0, '127.0.0.1', () => resolve()))));
  const [base, baseOff] = servers.map((s) => `http://127.0.0.1:${(s.address() as AddressInfo).port}`);
  const post = (user: number, b = base) => fetch(`${b}/checkins`, { method: 'POST', headers: { 'x-user': String(user) } }).then((r) => r.status);
  try {
    assert.deepEqual([await post(1), await post(1), await post(1), await post(2)], [204, 204, 429, 204]);
    now += 59_000;
    assert.equal(await post(1), 429, 'still inside the minute');
    now += 1_000;
    assert.deepEqual([await post(1), await post(1), await post(1)], [204, 204, 429], 'a fresh minute');
    const many: number[] = [];
    for (let i = 0; i < 5; i++) many.push(await post(1, baseOff));
    assert.deepEqual(many, [204, 204, 204, 204, 204], 'perMinute 0 turns it off');
  } finally {
    for (const s of servers) {
      s.closeAllConnections();
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
  }
});
