/**
 * Smart release 1.1 contract (p1): role matrix and payload shapes of the new endpoints and the optional fields on the
 * existing ones. Written to keep holding once p2–p9 replace the stub bodies: it checks shapes and scoping, never
 * stub values (except under LM_SMART=0, where every smart field must be null / empty / absent).
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { addDays, mondayOf, todayISO } from '../lib/dates.ts';
import { startTestServer, withSmart, type Json, type TestClient, type TestServer } from './helpers.ts';

let srv: TestServer;
let admin: TestClient;
let leader: TestClient;
let recruiter: TestClient;
let rep: TestClient;

before(async () => {
  srv = await startTestServer();
  [admin, leader, recruiter, rep] = await Promise.all([srv.login('admin'), srv.login('leader'), srv.login('recruiter'), srv.login('rep')]);
});
after(async () => {
  await srv.close();
});

const fx = () => srv.fixture!;
const isNullOrObject = (v: unknown) => v === null || (typeof v === 'object' && !Array.isArray(v));

function assertInsightsShape(j: Json): void {
  assert.equal(typeof j.generatedFor, 'string');
  assert.match(j.generatedFor, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(Object.keys(j.personal).sort(), ['baseline', 'direction', 'payForecast', 'streaks']);
  for (const k of ['baseline', 'direction', 'streaks', 'payForecast']) assert.ok(isNullOrObject(j.personal[k]), `personal.${k}`);
  assert.ok(Array.isArray(j.boardStreaks));
  for (const s of j.boardStreaks) assert.ok(Number.isInteger(s.userId) && typeof s.streak === 'number' && s.streak >= 5, 'board streak row');
  assert.ok('team' in j && 'company' in j);
}

test('GET /me/insights answers 200 for every role with the role-scoped parts', async () => {
  const [a, l, r, p] = await Promise.all([admin.get('/me/insights'), leader.get('/me/insights'), recruiter.get('/me/insights'), rep.get('/me/insights')]);
  for (const res of [a, l, r, p]) {
    assert.equal(res.status, 200);
    assertInsightsShape(res.json);
    assert.equal(res.json.generatedFor, todayISO());
  }
  // reps and recruiters: never anyone else's check-ins
  for (const res of [r, p]) {
    assert.equal(res.json.team, null);
    assert.equal(res.json.company, null);
  }
  // leader: own team only, never themself; no company list
  assert.ok(Array.isArray(l.json.team.checkIns));
  for (const c of l.json.team.checkIns) {
    assert.equal(c.teamId, fx().teams.a);
    assert.notEqual(c.userId, fx().users.leader);
  }
  assert.equal(l.json.company, null);
  // admin: the company list, never themself; no team list
  assert.ok(Array.isArray(a.json.company.checkIns));
  for (const c of a.json.company.checkIns) assert.notEqual(c.userId, fx().users.admin);
  assert.equal(a.json.team, null);
  // board streaks: recruiters none; reps and leaders only their own team
  assert.deepEqual(r.json.boardStreaks, []);
  const teamA = new Set([fx().users.leader, fx().users.rep, fx().users.repA2]);
  for (const s of [...p.json.boardStreaks, ...l.json.boardStreaks]) assert.ok(teamA.has(s.userId), 'own-team streaks only');
  // recruiters have no pay forecast (rep / leader only)
  assert.equal(r.json.personal.payForecast, null);
});

test('GET /me/insights is cached per user: MISS then HIT within 20 s, never another user\'s view', async () => {
  srv.resetCache();
  const first = await rep.get('/me/insights');
  assert.equal(first.headers.get('x-cache'), 'MISS');
  const second = await rep.get('/me/insights');
  assert.equal(second.headers.get('x-cache'), 'HIT');
  assert.deepEqual(second.json, first.json);
  assert.equal((await leader.get('/me/insights')).headers.get('x-cache'), 'MISS');
  assert.equal((await srv.anon().get('/me/insights')).status, 401);
});

test('GET /me/attention: an AttentionFeed for every role, cached', async () => {
  srv.resetCache();
  for (const c of [admin, leader, recruiter, rep]) {
    const r = await c.get('/me/attention');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.json.items) && r.json.items.length <= 20);
    assert.ok(!Number.isNaN(Date.parse(r.json.generatedAt)));
    for (const it of r.json.items) {
      assert.equal(typeof it.key, 'string');
      // the 1.1 kinds, plus 'system' (administrators: backups, the app key on paper), which the fixture always has
      assert.ok(['gauges', 'pay', 'payroll', 'events', 'recruitment', 'security', 'system'].includes(it.kind), it.kind);
      assert.ok(['info', 'warning', 'danger'].includes(it.severity));
      assert.ok(typeof it.title === 'string' && typeof it.body === 'string' && it.href.startsWith('/'));
    }
    assert.equal(r.headers.get('x-cache'), 'MISS');
    assert.equal((await c.get('/me/attention')).headers.get('x-cache'), 'HIT');
  }
  // a rep never receives team-wide, payroll or recruitment items
  const mine = (await rep.get('/me/attention')).json.items as Json[];
  assert.ok(mine.every((i) => !/^(gauges:gap|events:empty|payroll:|recruitment:)/.test(i.key)));
  assert.equal((await srv.anon().get('/me/attention')).status, 401);
});

test('GET /me/digest: the last completed week by default, any date normalised to its Monday, unfinished weeks 400', async () => {
  srv.resetCache();
  const lastMonday = addDays(mondayOf(todayISO()), -7);
  for (const c of [admin, leader, recruiter, rep]) {
    const r = await c.get('/me/digest');
    assert.equal(r.status, 200);
    assert.equal(r.json.weekStart, lastMonday);
    assert.equal(r.json.weekEnd, addDays(lastMonday, 6));
    assert.equal(typeof r.json.title, 'string');
    assert.equal(typeof r.json.text, 'string');
    assert.ok(Array.isArray(r.json.bullets));
    for (const b of r.json.bullets) assert.ok(typeof b.text === 'string' && typeof b.private === 'boolean');
    assert.ok(!/[<*#]/.test(r.json.text), 'plain text only');
  }
  assert.equal((await rep.get('/me/digest')).json.role, 'rep');
  const wednesday = addDays(lastMonday, -5); // the Wednesday of the week before
  const norm = await rep.get(`/me/digest?week=${wednesday}`);
  assert.equal(norm.status, 200);
  assert.equal(norm.json.weekStart, addDays(lastMonday, -7));
  assert.equal((await rep.get(`/me/digest?week=${todayISO()}`)).status, 400, 'the week in progress has not finished');
  assert.equal((await rep.get(`/me/digest?week=${addDays(todayISO(), 14)}`)).status, 400, 'a future week');
  assert.equal((await rep.get('/me/digest?week=2019-06-03')).status, 400, 'before 2020');
  assert.equal((await rep.get('/me/digest?week=nope')).status, 400, 'not a date');
  const again = await leader.get('/me/digest');
  assert.equal((await leader.get('/me/digest')).headers.get('x-cache'), 'HIT');
  assert.equal(again.status, 200);
});

test('GET /events/forecast: admin / leader 200 { forecast }, rep / recruiter 403, bad params 400, own team for leaders', async () => {
  const q = (teamId: number) => `/events/forecast?campaignId=${fx().campaignId}&teamId=${teamId}&type=private_site&targetSales=12`;
  for (const c of [admin, leader]) {
    const r = await c.get(q(fx().teams.a));
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.json), ['forecast']);
    assert.ok(isNullOrObject(r.json.forecast));
  }
  assert.equal((await admin.get(q(fx().teams.b))).status, 200, 'admin: any team');
  assert.equal((await leader.get(q(fx().teams.b))).status, 403, "leader: not another team's");
  assert.equal((await rep.get(q(fx().teams.a))).status, 403);
  assert.equal((await recruiter.get(q(fx().teams.a))).status, 403);
  assert.equal((await admin.get(`/events/forecast?campaignId=${fx().campaignId}&teamId=${fx().teams.a}`)).status, 400, 'type missing');
  assert.equal((await admin.get(`/events/forecast?campaignId=x&teamId=1&type=private_site`)).status, 400, 'bad id');
  assert.equal((await admin.get(`/events/forecast?campaignId=1&teamId=1&type=moon`)).status, 400, 'bad type');
  assert.equal((await admin.get(`/events/forecast?campaignId=1&teamId=1&type=b2b&targetSales=501`)).status, 400, 'target cap');
  const created = (await admin.post('/campaigns', { name: 'Brand new', code: 'BNW', sector: 'energy', type: 'b2c', payoutPerSale: 80, repCommissionPerSale: 30, color: '#0EA5E9', active: true, startDate: todayISO(), description: null })).json;
  const fresh = await admin.get(`/events/forecast?campaignId=${created.id}&teamId=${fx().teams.a}&type=retail`);
  assert.equal(fresh.status, 200);
  assert.equal(fresh.json.forecast, null, 'no history → no forecast');
  // the literal path is not swallowed by /events/:id
  assert.equal((await admin.get(`/events/${fx().events.todayA}`)).status, 200);
});

test('existing payloads keep their shape; smart fields are optional and typed', async () => {
  const events = await leader.get(`/events?from=${addDays(todayISO(), -1)}&to=${addDays(todayISO(), 1)}`);
  assert.equal(events.status, 200);
  assert.ok(events.json.length >= 3);
  for (const e of events.json) {
    assert.ok(e.forecast === undefined || isNullOrObject(e.forecast));
    if (e.status === 'completed' || e.status === 'cancelled') assert.equal(e.forecast ?? null, null, 'no forecast on past events');
  }
  const detail = await rep.get(`/events/${fx().events.tomorrowA}`);
  assert.equal(detail.status, 200);
  assert.ok(Array.isArray(detail.json.entries) && detail.json.ratios);
  assert.ok(detail.json.forecast === undefined || isNullOrObject(detail.json.forecast));

  const board = await admin.get('/leaderboard?period=week');
  assert.equal(board.status, 200);
  for (const row of board.json) assert.ok(row.streak === undefined || typeof row.streak === 'number');

  const me = await rep.get('/finance/me');
  assert.equal(me.status, 200);
  assert.ok('forecast' in me.json && isNullOrObject(me.json.forecast));
  assert.ok('nextPayAmount' in me.json && 'runs' in me.json && 'totals' in me.json);
  assert.equal((await recruiter.get('/finance/me')).json.forecast, null, 'recruiters have no forecast');

  for (const c of [leader, rep, recruiter]) {
    const runs = await c.get('/finance/payroll');
    assert.equal(runs.status, 200);
    assert.ok(runs.json.every((r: Json) => !('flags' in r)), 'flags are admin only');
  }
  const adminRuns = await admin.get('/finance/payroll?status=pending,failed');
  assert.equal(adminRuns.status, 200);
  for (const r of adminRuns.json) assert.ok(r.flags === undefined || Array.isArray(r.flags));
});

test('LM_SMART=0: every smart field is null, empty or absent', async () => {
  await withSmart('0', async () => {
    srv.resetCache();
    for (const c of [admin, leader, recruiter, rep]) {
      const r = await c.get('/me/insights');
      assert.equal(r.status, 200);
      assertInsightsShape(r.json);
      assert.deepEqual(r.json.personal, { baseline: null, direction: null, streaks: null, payForecast: null });
      assert.deepEqual(r.json.boardStreaks, []);
      assert.equal(r.json.team, null);
      assert.equal(r.json.company, null);
      assert.deepEqual((await c.get('/me/attention')).json.items, []);
      const d = await c.get('/me/digest');
      assert.equal(d.status, 200);
      assert.deepEqual(d.json.bullets, []);
      assert.equal(d.json.text, '');
    }
    const f = await admin.get(`/events/forecast?campaignId=${fx().campaignId}&teamId=${fx().teams.a}&type=private_site`);
    assert.deepEqual(f.json, { forecast: null });
    const events = await admin.get('/events');
    assert.ok(events.json.every((e: Json) => !('forecast' in e)));
    assert.ok(!('forecast' in (await admin.get(`/events/${fx().events.tomorrowA}`)).json));
    assert.ok((await admin.get('/leaderboard?period=quarter')).json.every((r: Json) => !('streak' in r)));
    assert.equal((await rep.get('/finance/me')).json.forecast, null);
    assert.ok((await admin.get('/finance/payroll?status=pending,failed')).json.every((r: Json) => !('flags' in r)));
  });
  srv.resetCache();
});
