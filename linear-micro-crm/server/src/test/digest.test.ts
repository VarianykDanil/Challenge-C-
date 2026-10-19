/**
 * p9-week-in-review-digest: GET /me/digest on the full demo seed, last completed week. The seed shifts with the date,
 * so these checks compare the digest with the endpoints behind the tiles (same week, same caller) and check scoping —
 * never seeded names or numbers.
 *
 * The business clock is pinned to 15:00 today (London) so event statuses are settled whatever the hour of the run.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { gbp, plural } from '@lm/shared';
import { all, get } from '../db/connection.ts';
import { addDays, mondayOf, setBusinessClock, toISODate } from '../lib/dates.ts';
import { startTestServer, withSmart, type Json, type TestClient, type TestServer } from './helpers.ts';

const TODAY = toISODate(new Date());
setBusinessClock(new Date(`${TODAY}T15:00:00`)); // TZ=Europe/London in the server test script

const MONDAY = addDays(mondayOf(TODAY), -7);
const SUNDAY = addDays(MONDAY, 6);

let srv: TestServer;
let admin: TestClient;
let leader: TestClient;
let recruiter: TestClient;
let rep: TestClient;

before(async () => {
  srv = await startTestServer({ seed: true, today: TODAY });
  [admin, leader, recruiter, rep] = await Promise.all([srv.login('admin'), srv.login('leader'), srv.login('recruiter'), srv.login('rep')]);
});

after(async () => {
  await srv.close();
  setBusinessClock(null);
});

const texts = (d: Json): string[] => d.bullets.map((b: Json) => b.text as string);
const shareable = (d: Json): string[] => d.bullets.filter((b: Json) => !b.private).map((b: Json) => b.text as string);
const fullNames = () => all<{ id: number; name: string; teamId: number | null }>(srv.db, `SELECT id, first_name || ' ' || last_name AS name, team_id AS teamId FROM users`);

test('every role: the last completed week, 5–8 bullets, text = title + shareable bullets only, plain text', async () => {
  for (const c of [admin, leader, recruiter, rep]) {
    const r = await c.get('/me/digest');
    assert.equal(r.status, 200);
    const d = r.json;
    assert.equal(d.weekStart, MONDAY);
    assert.equal(d.weekEnd, SUNDAY);
    assert.ok(d.bullets.length >= 5 && d.bullets.length <= 8, `${d.role}: ${d.bullets.length} bullets`);
    assert.equal(d.text, [d.title, ...shareable(d).map((t) => `• ${t}`)].join('\n'));
    for (const b of d.bullets.filter((x: Json) => x.private)) assert.ok(!d.text.includes(b.text), `${d.role}: private line in text`);
    assert.ok(!/[<*#]/.test(d.text), `${d.role}: no '<', '*' or '#'`);
    assert.ok(!/NaN|undefined|null/.test(d.text), `${d.role}: no NaN / undefined / null`);
  }
});

test("rep: the sales figure equals the rep's own row of GET /gauges/summary for that week", async () => {
  const me = (await rep.get('/auth/me')).json.user;
  const d = (await rep.get('/me/digest')).json;
  const summary = await rep.get(`/gauges/summary?groupBy=user&userId=${me.id}&from=${MONDAY}&to=${SUNDAY}`);
  assert.equal(summary.status, 200);
  const row = (summary.json as Json[]).find((r) => String(r.key) === String(me.id));
  const sales = row ? Number(row.sales) : 0;
  const stops = row ? Number(row.stops) : 0;
  const first = texts(d)[0]!;
  if (sales > 0 || stops > 0) assert.ok(first.startsWith(`You made ${plural(sales, 'sale')} — `), first);
  else assert.equal(first, 'No gauges logged this week — 0 sales.');
  // the pay line is private, and nobody else's name appears anywhere in the rep's digest
  assert.ok(d.bullets.some((b: Json) => b.private && /pay/i.test(b.text)), 'a private pay line');
  const others = fullNames().filter((u) => u.id !== me.id);
  for (const u of others) assert.ok(!texts(d).some((t) => t.includes(u.name)), `rep digest names ${u.name}`);
});

test("admin: revenue equals totals.revenue of GET /finance/summary for that week; payroll lines are private", async () => {
  const d = (await admin.get('/me/digest')).json;
  const fin = await admin.get(`/finance/summary?from=${MONDAY}&to=${SUNDAY}`);
  assert.equal(fin.status, 200);
  const line = texts(d).find((t) => t.startsWith('Revenue '));
  assert.ok(line, 'a revenue line');
  assert.ok(line!.startsWith(`Revenue ${gbp(fin.json.totals.revenue)} — `), `${line} vs ${fin.json.totals.revenue}`);
  // company sales are the same week's gauge total
  const sales = Number(get<{ s: number }>(srv.db, `SELECT COALESCE(SUM(sales), 0) AS s FROM gauge_entries WHERE date BETWEEN ? AND ?`, [MONDAY, SUNDAY])!.s);
  assert.ok(texts(d)[0]!.includes(plural(sales, 'sale')), texts(d)[0]);
  const payroll = d.bullets.filter((b: Json) => /payroll|transfer/i.test(b.text));
  assert.ok(payroll.length >= 1 && payroll.every((b: Json) => b.private), 'payroll is private');
  assert.ok(!/payroll/i.test(d.text));
  // failed transfers: the same runs as the Runs to pay card (GET /finance/payroll?status=failed, its default window)
  const failed = (await admin.get('/finance/payroll?status=failed')).json as Json[];
  const failedLine = texts(d).find((t) => /failed transfer/.test(t));
  if (failed.length === 0) assert.equal(failedLine, undefined);
  else assert.equal(failedLine, `${plural(failed.length, 'failed transfer')} to send again, ${gbp(failed.reduce((a, r) => a + r.gross, 0))} in all.`);
});

test('leader: the text never contains a check-in name; named people are on their own team; the count is private', async () => {
  const me = (await leader.get('/auth/me')).json.user;
  const d = (await leader.get('/me/digest')).json;
  const checkIns = ((await leader.get('/me/insights')).json.team?.checkIns ?? []) as Json[];
  for (const p of checkIns) assert.ok(!d.text.includes(p.userName), `check-in name ${p.userName} in shareable text`);
  for (const p of checkIns) assert.ok(!texts(d).some((t) => t.includes(p.userName)), `check-in name ${p.userName} in any line`);
  for (const u of fullNames()) {
    if (d.text.includes(u.name)) assert.equal(u.teamId, me.teamId, `${u.name} is not on the leader's team`);
  }
  const countLine = d.bullets.find((b: Json) => /check-in list/.test(b.text));
  assert.ok(countLine?.private, 'the check-in count is a private line');
  assert.ok(countLine.text.startsWith(checkIns.length === 0 ? 'Nobody' : plural(checkIns.length, 'person', 'people')), countLine.text);
  // team sales = the team's gauge total for the week
  const sales = Number(get<{ s: number }>(srv.db, `SELECT COALESCE(SUM(g.sales), 0) AS s FROM gauge_entries g JOIN users u ON u.id = g.user_id WHERE u.team_id = ? AND g.date BETWEEN ? AND ?`, [me.teamId, MONDAY, SUNDAY])!.s);
  assert.ok(texts(d)[0]!.startsWith(`${me.teamName} made ${plural(sales, 'sale')} — `), texts(d)[0]);
});

test('recruiter: no gauge bullets; applications match GET /recruitment/summary for the week', async () => {
  const d = (await recruiter.get('/me/digest')).json;
  for (const t of texts(d)) assert.ok(!/\b(stops?|sales?|conversion|gauges?|revenue|pay|payroll)\b/i.test(t), t);
  const summary = (await recruiter.get(`/recruitment/summary?from=${MONDAY}&to=${SUNDAY}`)).json;
  assert.ok(texts(d)[0]!.startsWith(`${plural(summary.applied, 'application')} — `), texts(d)[0]);
  assert.ok(texts(d)[2]!.startsWith(`${plural(summary.hired, 'hire')} — `), texts(d)[2]);
  // the same overdue figure as the recruiter's "Overdue actions" tile (recruitmentSummary.overdueActions)
  const today = (await recruiter.get('/recruitment/summary')).json.overdueActions as number;
  assert.ok(texts(d)[3]!.startsWith(today === 0 ? 'No open candidate' : `${plural(today, 'open candidate')} `), texts(d)[3]);
});

test('a week that has not finished, a future week and a week before 2020 → 400', async () => {
  for (const week of [TODAY, addDays(TODAY, 7), addDays(TODAY, 60), '2019-12-30']) {
    const r = await rep.get(`/me/digest?week=${week}`);
    assert.equal(r.status, 400, week);
  }
  const older = await rep.get(`/me/digest?week=${addDays(MONDAY, -10)}`);
  assert.equal(older.status, 200);
  assert.equal(older.json.weekStart, addDays(MONDAY, -14), 'any date normalises to its Monday');
});

test('a repeat call carries X-Cache: HIT with the same body; the digest writes no gauge row', async () => {
  srv.resetCache();
  const gauges = () => Number(get<{ n: number }>(srv.db, 'SELECT COUNT(*) AS n FROM gauge_entries')!.n);
  const before = gauges();
  for (const c of [admin, leader, recruiter, rep]) {
    const first = await c.get(`/me/digest?week=${MONDAY}`);
    assert.equal(first.headers.get('x-cache'), 'MISS');
    const second = await c.get(`/me/digest?week=${MONDAY}`);
    assert.equal(second.headers.get('x-cache'), 'HIT');
    assert.deepEqual(second.json, first.json);
  }
  assert.equal(gauges(), before);
});

test('deterministic: the same week gives the same digest after the cache is cleared', async () => {
  const a = (await leader.get('/me/digest')).json;
  srv.resetCache();
  const b = (await leader.get('/me/digest')).json;
  assert.deepEqual(b, a);
});

test('LM_SMART=0 → the empty digest: title only, no bullets, empty text', async () => {
  await withSmart('0', async () => {
    srv.resetCache();
    const r = await admin.get('/me/digest');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.bullets, []);
    assert.equal(r.json.text, '');
    assert.match(r.json.title, /^Your week in review · w\/c \d{1,2} [A-Z][a-z]{2}$/);
  });
  srv.resetCache();
});

test('release close-out: GET /api/health reports version 1.1.0', async () => {
  const r = await srv.anon().get('/health');
  assert.equal(r.status, 200);
  assert.equal(r.json.version, '1.1.0');
});
