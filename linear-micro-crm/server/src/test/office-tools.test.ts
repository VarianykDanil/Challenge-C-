/**
 * U5 office-tools — GET /search (command palette) and GET /finance/payroll/export (Xero / Sage CSV) on the small
 * fixture (known names, so scoping can be asserted exactly), plus shape and caps on the full demo seed.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { PAY_EXPORT_HEADERS, SEARCH_KIND_LIMITS, SEARCH_MAX_RESULTS, type SearchResponse, type SearchResult } from '@lm/shared';
import { all, get, run, type Db } from '../db/connection.ts';
import { currentDataVersion } from '../lib/cache.ts';
import { addDays, mondayOf, todayISO } from '../lib/dates.ts';
import { addEvent, addGauge, startTestServer, type TestClient, type TestServer } from './helpers.ts';

let srv: TestServer;
let admin: TestClient;
let leader: TestClient;
let recruiter: TestClient;
let rep: TestClient;
let repB: TestClient;
const ids = { leftUser: 0, candidate: 0, hiredCandidate: 0, eventA: 0, eventB: 0, inactiveCampaign: 0, percentUser: 0 };
const lastMonday = addDays(mondayOf(todayISO()), -7);

const fx = () => srv.fixture!;

function addUser(db: Db, first: string, last: string, status: 'active' | 'on_leave' | 'left', teamId: number | null, employeeId: string): number {
  return run(
    db,
    `INSERT INTO users (employee_id, email, first_name, last_name, role, position, team_id, pay_plan_id, start_date, status, phone, avatar_color, city)
     VALUES (?, ?, ?, ?, 'rep', 'field_rep', ?, ?, '2025-01-06', ?, NULL, '#0EA5E9', 'Salford')`,
    [employeeId, `${first.toLowerCase()}.${last.toLowerCase().replace(/[^a-z]/g, '')}@fixture.test`, first, last, teamId, fx().plans.rep, status],
  ).lastInsertRowid;
}

function addCandidate(db: Db, first: string, last: string, stage: string): number {
  const at = `${addDays(todayISO(), -10)}T09:00:00.000Z`;
  return run(
    db,
    `INSERT INTO candidates (first_name, last_name, email, city, source, stage, position_applied, applied_at, stage_updated_at)
     VALUES (?, ?, ?, 'Stockport', 'indeed', ?, 'trainee', ?, ?)`,
    [first, last, `${first.toLowerCase()}@mail.example`, stage, at, at],
  ).lastInsertRowid;
}

function addRun(db: Db, userId: number, weekStart: string, status: string, gross: number, reference: string): void {
  run(
    db,
    `INSERT INTO payroll_runs (user_id, week_start, week_end, days_worked, sales, team_sales, base_pay, commission, bonus, overrides, deductions, gross, due_date, paid_date, status, reference)
     VALUES (?, ?, ?, 4, 8, 0, 240, ?, 0, 0, 0, ?, ?, ?, ?, ?)`,
    [userId, weekStart, addDays(weekStart, 6), gross - 240, gross, addDays(weekStart, 11), status === 'paid' ? addDays(weekStart, 10) : null, status, reference],
  );
}

before(async () => {
  srv = await startTestServer();
  const db = srv.db;
  const { teams, users, campaignId } = fx();
  ids.leftUser = addUser(db, 'Lorna', 'Gone', 'left', teams.a, 'FX-0900');
  ids.percentUser = addUser(db, 'Percy', '100%_Real', 'active', teams.b, 'FX-0901');
  ids.candidate = addCandidate(db, 'Zara', 'Quill', 'interview');
  ids.hiredCandidate = addCandidate(db, 'Zack', 'Quill', 'hired');
  ids.eventA = addEvent(db, { campaignId, teamId: teams.a, date: addDays(todayISO(), 3), status: 'scheduled', name: 'Zebra Crossing Roadshow' });
  ids.eventB = addEvent(db, { campaignId, teamId: teams.b, date: addDays(todayISO(), 3), status: 'scheduled', name: 'Zebra Park Fair' });
  ids.inactiveCampaign = run(
    db,
    `INSERT INTO campaigns (name, code, sector, type, payout_per_sale, rep_commission_per_sale, color, active, start_date, description)
     VALUES ('Old Energy Deal', 'OED', 'energy', 'b2c', 50, 10, '#64748B', 0, '2024-01-01', NULL)`,
  ).lastInsertRowid;
  // Last week's runs: two to pay (one pending, one failed), one already paid; a formula-looking reference.
  addRun(db, users.rep, lastMonday, 'pending', 600, 'PAY-FX-REMY');
  addRun(db, users.repA2, lastMonday, 'failed', 450.5, '=HYPERLINK("x")');
  addRun(db, users.repB, lastMonday, 'paid', 700, 'PAY-FX-BO');
  // An older week, so the filter by week is visible.
  addRun(db, users.rep, addDays(lastMonday, -7), 'pending', 300, 'PAY-FX-REMY-OLD');
  srv.resetCache();
  void campaignId;
  admin = await srv.login('admin');
  leader = await srv.login('leader');
  recruiter = await srv.login('recruiter');
  rep = await srv.login('rep');
  repB = await srv.login('repB');
});

after(async () => {
  await srv?.close();
});

async function search(client: TestClient, q: string): Promise<SearchResult[]> {
  const r = await client.get(`/search?q=${encodeURIComponent(q)}`);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return (r.json as SearchResponse).results;
}

const titles = (rs: SearchResult[], kind?: SearchResult['kind']) => rs.filter((r) => !kind || r.kind === kind).map((r) => r.title);

// ── GET /search ─────────────────────────────────────────────────────────────

test('search: signed out → 401', async () => {
  assert.equal((await srv.anon().get('/search?q=remy')).status, 401);
});

test('search: a query under two characters (or none, or repeated) answers no results, echoing the normalised query', async () => {
  for (const q of ['', 'r', '  r  ']) {
    const r = await admin.get(`/search?q=${encodeURIComponent(q)}`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { q: q.trim(), results: [] });
  }
  const twice = await admin.get('/search?q=remy&q=rita');
  assert.deepEqual(twice.json, { q: '', results: [] });
  assert.deepEqual((await admin.get('/search')).json, { q: '', results: [] });
});

test('search: result shape — kind, id, title, subtitle, in-app href, colour', async () => {
  const rs = await search(admin, 'remy');
  const remy = rs.find((r) => r.kind === 'person' && r.id === fx().users.rep);
  assert.ok(remy, JSON.stringify(rs));
  assert.equal(remy.title, 'Remy Rep');
  assert.equal(remy.href, `/team/${fx().users.rep}`);
  assert.equal(typeof remy.subtitle, 'string');
  assert.match(remy.subtitle!, /Field Representative · Team A/);
  assert.equal(remy.color, '#4F46E5');
});

test('search: every word must match, in any order', async () => {
  assert.deepEqual(titles(await search(rep, 'rep remy'), 'person'), ['Remy Rep']);
  assert.deepEqual(titles(await search(rep, 'remy zzz'), 'person'), []);
});

test('search: titles that start with the query first, then a word that starts with it, then the rest', async () => {
  // "re": Remy Rep starts with it; Rae Recruiter, Bo Rep and Rita Rep have a word that does (then by surname, first
  // name); Percy 100%_Real only contains it.
  const rs = (await search(admin, 're')).filter((r) => r.kind === 'person');
  assert.deepEqual(titles(rs), ['Remy Rep', 'Rae Recruiter', 'Bo Rep', 'Rita Rep', 'Percy 100%_Real']);
  assert.deepEqual(rs.map((r) => r.rank), [0, 1, 1, 1, 2]);
});

test('search: e-mail matches on the part before the @ only (the shared domain matches nobody)', async () => {
  assert.deepEqual(titles(await search(admin, 'fixture.test'), 'person'), []);
  assert.deepEqual(titles(await search(admin, 'remy.rep'), 'person'), ['Remy Rep']);
});

test('search: LIKE wildcards in the query match themselves', async () => {
  assert.deepEqual(titles(await search(admin, '0%'), 'person'), ['Percy 100%_Real']);
  assert.deepEqual(titles(await search(admin, '%_r'), 'person'), ['Percy 100%_Real']);
  assert.deepEqual(titles(await search(admin, '%%'), 'person'), [], '% is not a wildcard');
  assert.deepEqual(titles(await search(admin, 'r_m'), 'person'), [], '_ is not a single-character wildcard');
});

test('search: employee IDs are searchable by admins only', async () => {
  assert.deepEqual(titles(await search(admin, 'FX-0004'), 'person'), ['Remy Rep']);
  for (const c of [leader, recruiter, rep]) assert.deepEqual(titles(await search(c, 'FX-0004'), 'person'), []);
});

test('search: people who have left are found by admins only, and say so', async () => {
  const forAdmin = (await search(admin, 'lorna')).filter((r) => r.kind === 'person');
  assert.equal(forAdmin.length, 1);
  assert.match(forAdmin[0]!.subtitle!, /Left$/);
  for (const c of [leader, recruiter, rep]) assert.deepEqual(titles(await search(c, 'lorna'), 'person'), []);
});

test('search: reps find only their own team\'s events; everyone else every team\'s', async () => {
  assert.deepEqual(titles(await search(rep, 'zebra'), 'event'), ['Zebra Crossing Roadshow']);
  assert.deepEqual(titles(await search(repB, 'zebra'), 'event'), ['Zebra Park Fair']);
  for (const c of [admin, leader, recruiter]) assert.deepEqual(titles(await search(c, 'zebra'), 'event').sort(), ['Zebra Crossing Roadshow', 'Zebra Park Fair']);
  const ev = (await search(rep, 'zebra')).find((r) => r.kind === 'event')!;
  assert.equal(ev.href, `/events/${ids.eventA}`);
  assert.match(ev.subtitle!, /Team A/);
  assert.equal(ev.color, '#DB2777', 'the campaign colour');
});

test('search: events match on campaign code and team name too; upcoming before past', async () => {
  const rs = (await search(leader, 'fxc team a')).filter((r) => r.kind === 'event');
  assert.ok(rs.length >= 1 && rs.length <= SEARCH_KIND_LIMITS.event);
  const dates = rs.map((r) => all<{ date: string }>(srv.db, 'SELECT date FROM events WHERE id = ?', [r.id])[0]!.date);
  const today = todayISO();
  const firstPast = dates.findIndex((d) => d < today);
  if (firstPast >= 0) assert.ok(dates.slice(firstPast).every((d) => d < today), `upcoming first: ${dates.join(', ')}`);
  const upcoming = dates.filter((d) => d >= today);
  assert.deepEqual(upcoming, [...upcoming].sort(), 'upcoming soonest first');
});

test('search: candidates for recruiters, leaders and admins only; open ones before closed ones', async () => {
  for (const c of [admin, leader, recruiter]) {
    const rs = (await search(c, 'quill')).filter((r) => r.kind === 'candidate');
    assert.deepEqual(rs.map((r) => r.id), [ids.candidate, ids.hiredCandidate]);
    assert.equal(rs[0]!.href, `/recruitment/${ids.candidate}`);
    assert.match(rs[0]!.subtitle!, /^Interview · Trainee · Stockport$/);
  }
  assert.deepEqual((await search(rep, 'quill')).filter((r) => r.kind === 'candidate'), []);
});

test('search: campaigns — leaders and admins open the Campaigns page (inactive ones too); reps and recruiters the pitch of active ones', async () => {
  for (const c of [admin, leader]) {
    const rs = (await search(c, 'energy')).filter((r) => r.kind === 'campaign');
    assert.deepEqual(rs.map((r) => r.id), [ids.inactiveCampaign]);
    assert.equal(rs[0]!.href, '/campaigns');
    assert.equal(rs[0]!.subtitle, 'OED · Energy · Inactive');
  }
  for (const c of [rep, recruiter]) {
    assert.deepEqual((await search(c, 'energy')).filter((r) => r.kind === 'campaign'), [], 'inactive campaigns are not offered');
    const rs = (await search(c, 'fxc')).filter((r) => r.kind === 'campaign');
    assert.equal(rs.length, 1);
    assert.equal(rs[0]!.rank, 0, 'the code starts with the query');
    assert.equal(rs[0]!.href, '/learning/pitch/FXC');
    assert.equal(rs[0]!.subtitle, 'FXC · Pitch');
  }
});

test('search: cached per user for 20 s (second read is a HIT; another user is a MISS)', async () => {
  const a = await leader.get('/search?q=team');
  const b = await leader.get('/search?q=team');
  assert.equal(a.headers.get('x-cache'), 'MISS');
  assert.equal(b.headers.get('x-cache'), 'HIT');
  assert.deepEqual(a.json, b.json);
  assert.equal((await admin.get('/search?q=team')).headers.get('x-cache'), 'MISS');
});

// ── GET /finance/payroll/export ─────────────────────────────────────────────

test('export: admin only (leader, recruiter, rep → 403; signed out → 401)', async () => {
  const url = `/finance/payroll/export?weekStart=${lastMonday}&format=xero`;
  assert.equal((await srv.anon().get(url)).status, 401);
  for (const c of [leader, recruiter, rep]) assert.equal((await c.get(url)).status, 403);
  assert.equal((await admin.get(url)).status, 200);
});

test('export: 400 for a missing or non-Monday week, an unknown format or runs value', async () => {
  for (const q of [
    'format=xero',
    `weekStart=${addDays(lastMonday, 1)}&format=xero`,
    'weekStart=2026-02-30&format=xero',
    `weekStart=${lastMonday}`,
    `weekStart=${lastMonday}&format=csv`,
    `weekStart=${lastMonday}&format=xero&runs=some`,
  ]) {
    const r = await admin.get(`/finance/payroll/export?${q}`);
    assert.equal(r.status, 400, q);
  }
});

test('export (xero): the week\'s runs still to pay, by surname, as an attachment with Xero headers', async () => {
  const r = await admin.get(`/finance/payroll/export?weekStart=${lastMonday}&format=xero`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type')!, /^text\/csv; charset=utf-8/);
  assert.equal(r.headers.get('content-disposition'), `attachment; filename="linear-hub-payroll-xero-${lastMonday}.csv"`);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal(r.headers.get('x-total-count'), '2');
  const lines = String(r.json).split('\r\n');
  assert.equal(lines[0], PAY_EXPORT_HEADERS.xero.join(','));
  assert.equal(lines.length, 4, 'header + 2 runs + final CRLF');
  const uk = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
  // Rep, Remy and Rep, Rita: same surname, then first name. The paid run (Bo) and the older week are left out.
  assert.equal(lines[1], `Remy Rep,FX-0004,${uk(lastMonday)},${uk(addDays(lastMonday, 6))},600.00,240.00,360.00,0.00,0.00,0.00,PAY-FX-REMY`);
  assert.ok(lines[2]!.startsWith('Rita Rep,FX-0005,'), lines[2]);
  assert.ok(lines[2]!.includes(',450.50,240.00,210.50,'), lines[2]);
  assert.ok(lines[2]!.endsWith(`,"'=HYPERLINK(""x"")"`), `formula guarded: ${lines[2]}`);
});

test('export (sage, runs=all): every run of the week with Sage headers', async () => {
  const r = await admin.get(`/finance/payroll/export?weekStart=${lastMonday}&format=sage&runs=all`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('x-total-count'), '3');
  const lines = String(r.json).split('\r\n');
  assert.equal(lines[0], PAY_EXPORT_HEADERS.sage.join(','));
  assert.deepEqual(lines.slice(1, 4).map((l) => l.split(',')[0]), ['Bo Rep', 'Remy Rep', 'Rita Rep']);
});

test('export: a week without runs answers the header line alone', async () => {
  const r = await admin.get(`/finance/payroll/export?weekStart=${addDays(lastMonday, -70)}&format=sage`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('x-total-count'), '0');
  assert.equal(String(r.json), `${PAY_EXPORT_HEADERS.sage.join(',')}\r\n`);
});

test('export: when the runs exist already it changes nothing — the runs are byte-for-byte the same afterwards', async () => {
  const snap = () => JSON.stringify(all(srv.db, 'SELECT * FROM payroll_runs ORDER BY id'));
  const before = snap();
  await admin.get(`/finance/payroll/export?weekStart=${lastMonday}&format=xero&runs=all`);
  assert.equal(snap(), before);
});

test('export: a week that has just closed gets its pending runs first, as GET /finance/payroll; the cached views are cleared then, and only then', async () => {
  const fresh = await startTestServer();
  try {
    const { users, teams, campaignId } = fresh.fixture!;
    const monday = addDays(mondayOf(todayISO()), -7);
    const eventId = addEvent(fresh.db, { campaignId, teamId: teams.a, date: addDays(monday, 2) });
    addGauge(fresh.db, { eventId, userId: users.rep, date: addDays(monday, 2), stops: 50, sales: 3 });
    fresh.resetCache();
    const runs = () => Number(get<{ n: number }>(fresh.db, 'SELECT COUNT(*) AS n FROM payroll_runs')!.n);
    assert.equal(runs(), 0);
    const boss = await fresh.login('admin');
    // a cached view that does not create runs itself: cached now
    assert.equal((await boss.get('/leaderboard')).headers.get('x-cache'), 'MISS');
    assert.equal((await boss.get('/leaderboard')).headers.get('x-cache'), 'HIT');
    const v0 = currentDataVersion();
    const r = await boss.get(`/finance/payroll/export?weekStart=${monday}&format=xero`);
    assert.equal(r.status, 200);
    assert.ok(runs() > 0, 'the closed week\'s runs were created');
    assert.equal(r.headers.get('x-total-count'), String(runs()), 'and exported');
    assert.ok(currentDataVersion() > v0, 'the data version moved');
    assert.equal((await boss.get('/leaderboard')).headers.get('x-cache'), 'MISS', 'so cached views are rebuilt');
    // the same rows GET /finance/payroll lists for that week
    const listed = (await boss.get(`/finance/payroll?from=${monday}&to=${addDays(monday, 6)}`)).json as { reference: string }[];
    assert.deepEqual(listed.map((x) => x.reference).sort(), all<{ reference: string }>(fresh.db, 'SELECT reference FROM payroll_runs').map((x) => x.reference).sort());
    // a second export creates nothing and clears nothing
    assert.equal((await boss.get('/leaderboard')).headers.get('x-cache'), 'HIT');
    const before = JSON.stringify(all(fresh.db, 'SELECT * FROM payroll_runs ORDER BY id'));
    const v1 = currentDataVersion();
    assert.equal((await boss.get(`/finance/payroll/export?weekStart=${monday}&format=sage`)).status, 200);
    assert.equal(currentDataVersion(), v1);
    assert.equal(JSON.stringify(all(fresh.db, 'SELECT * FROM payroll_runs ORDER BY id')), before);
    assert.equal((await boss.get('/leaderboard')).headers.get('x-cache'), 'HIT');
  } finally {
    await fresh.close();
  }
});

// ── Full demo seed: shape and caps ──────────────────────────────────────────

test('demo seed: at most 20 results, per-kind caps, every href in-app, role kinds respected', async () => {
  const demo = await startTestServer({ seed: true });
  try {
    const dAdmin = await demo.login('admin');
    const dRep = await demo.login('rep');
    for (const q of ['an', 'ma', 'bcn', 'breast cancer']) {
      const rs = (await dAdmin.get(`/search?q=${encodeURIComponent(q)}`)).json.results as SearchResult[];
      assert.ok(rs.length <= SEARCH_MAX_RESULTS, q);
      for (const kind of ['person', 'event', 'candidate', 'campaign'] as const) assert.ok(rs.filter((r) => r.kind === kind).length <= SEARCH_KIND_LIMITS[kind], `${q} ${kind}`);
      for (const r of rs) assert.match(r.href, /^\/(team|events|recruitment|campaigns|learning\/pitch)(\/|$)/, r.href);
    }
    const bcn = (await dRep.get('/search?q=bcn')).json.results as SearchResult[];
    assert.ok(bcn.some((r) => r.kind === 'event'), 'the rep finds BCN events of their own team');
    assert.ok(bcn.every((r) => r.kind !== 'candidate'));
    assert.deepEqual(bcn.filter((r) => r.kind === 'campaign').map((r) => r.href), ['/learning/pitch/BCN']);
    const repTeam = (await dRep.get('/auth/me')).json.user.teamId as number;
    for (const r of bcn.filter((x) => x.kind === 'event')) {
      assert.equal(all<{ t: number }>(demo.db, 'SELECT team_id AS t FROM events WHERE id = ?', [r.id])[0]!.t, repTeam);
    }
    // The pay export of the latest materialised week has a line per run still to pay.
    const week = all<{ w: string; n: number }>(demo.db, `SELECT week_start AS w, COUNT(*) AS n FROM payroll_runs WHERE status IN ('pending','failed') GROUP BY week_start ORDER BY week_start DESC LIMIT 1`)[0];
    if (week) {
      const r = await dAdmin.get(`/finance/payroll/export?weekStart=${week.w}&format=xero`);
      assert.equal(r.status, 200);
      assert.equal(r.headers.get('x-total-count'), String(week.n));
      assert.equal(String(r.json).split('\r\n').length, week.n + 2);
    }
  } finally {
    await demo.close();
  }
});
