/**
 * End-to-end smoke test: boots the API on a fresh, seeded temporary database, signs in as each demo
 * account and exercises every endpoint. Prints a PASS/FAIL table and exits non-zero on any failure.
 */
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createApp } from './app.ts';
import { all, get, openDb, run } from './db/connection.ts';
import { materialisePayrollRuns } from './db/maintenance.ts';
import { getUser } from './db/queries.ts';
import { createSchema } from './db/schema.ts';
import { seed } from './db/seed.ts';
import { AVATAR_PALETTE } from './db/seed-data.ts';
import { addDays, dayOfWeek, mondayOf, normaliseCheckIn, nowHHMM, previousToDateRange, startOfMonth, startOfQuarter, sundayOf, todayISO } from './lib/dates.ts';
import { nextPay } from './lib/pay.ts';

/** WCAG contrast ratio of white text on a hex background. */
function contrastWithWhite(hex: string): number {
  const ch = (i: number) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 1.05 / (0.2126 * ch(1) + 0.7152 * ch(3) + 0.0722 * ch(5) + 0.05);
}

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

class Client {
  private cookie = '';
  constructor(private base: string, readonly label: string) {}

  async req(method: string, url: string, body?: unknown): Promise<{ status: number; json: Json; headers: Headers }> {
    const res = await fetch(this.base + url, {
      method,
      headers: { 'content-type': 'application/json', ...(this.cookie ? { cookie: this.cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) {
      const m = /lm_session=([^;]*)/.exec(setCookie);
      this.cookie = m && m[1] ? `lm_session=${m[1]}` : '';
    }
    const text = await res.text();
    let json: Json = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = text;
      }
    }
    return { status: res.status, json, headers: res.headers };
  }
  get = (url: string) => this.req('GET', url);
  post = (url: string, body?: unknown) => this.req('POST', url, body);
  patch = (url: string, body?: unknown) => this.req('PATCH', url, body);
  del = (url: string) => this.req('DELETE', url);
}

interface Result { name: string; pass: boolean; detail: string }
const results: Result[] = [];

class AssertionError extends Error {}
function ok(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new AssertionError(msg);
}
function eq<T>(actual: T, expected: T, what: string): void {
  if (actual !== expected) throw new AssertionError(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function status(r: { status: number; json: Json }, expected: number, what: string): void {
  if (r.status !== expected) throw new AssertionError(`${what}: expected HTTP ${expected}, got ${r.status} ${JSON.stringify(r.json)?.slice(0, 200)}`);
}

async function check(name: string, fn: () => Promise<string | void>): Promise<void> {
  try {
    const detail = await fn();
    results.push({ name, pass: true, detail: detail ?? '' });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    results.push({ name, pass: false, detail: detail.slice(0, 300) });
  }
}

async function main(): Promise<void> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'linear-smoke-'));
  const db = openDb(path.join(dir, 'smoke.sqlite'));
  createSchema(db);
  const t0 = performance.now();
  const seedTime = nowHHMM(); // today's events seeded as 'live' only when they had started by now
  const stats = seed(db);
  console.log(`Seeded temp DB in ${Math.round(performance.now() - t0)}ms: ${stats.users} users, ${stats.events} events, ${stats.gauges} gauges, ${stats.candidates} candidates`);

  const app = createApp(db);
  const server = app.listen(0);
  await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}/api`;

  const anon = new Client(base, 'anon');
  const admin = new Client(base, 'admin');
  const leader = new Client(base, 'leader');
  const recruiter = new Client(base, 'recruiter');
  const rep = new Client(base, 'rep');

  const today = todayISO();
  const monday = mondayOf(today);
  const weekAgo = addDays(today, -7);
  const twelveWeeksAgo = addDays(monday, -84);
  // On a Monday before 07:00 no event of the week has started yet, so "sold this week" assertions are relaxed.
  const noDataYet = dayOfWeek(today) === 1 && seedTime < '07:00';
  const positive = (n: number, what: string) => ok(n > 0 || noDataYet, what);

  // ── public & auth ──
  await check('GET /health (no auth)', async () => {
    const r = await anon.get('/health');
    status(r, 200, 'health');
    eq(r.json.ok, true, 'ok');
    ok(typeof r.json.version === 'string', 'version string');
    ok(typeof r.json.seededAt === 'string' && r.json.seededAt.length > 0, 'seededAt set');
  });
  await check('401 without a session', async () => {
    status(await anon.get('/auth/me'), 401, 'auth/me');
    status(await anon.get('/users'), 401, 'users');
    status(await anon.get('/me/dashboard'), 401, 'dashboard');
  });
  await check('GET /auth/demo-accounts', async () => {
    const r = await anon.get('/auth/demo-accounts');
    status(r, 200, 'demo');
    eq(r.json.accounts.length, 4, 'four accounts');
    eq(r.json.accounts.map((a: Json) => a.role).join(','), 'admin,leader,recruiter,rep', 'roles');
    eq(r.json.accounts[0].email, 'danil@linear-mcr.co.uk', 'admin email');
    process.env.LM_DEMO_ACCOUNTS = '0';
    try {
      const off = await anon.get('/auth/demo-accounts');
      status(off, 200, 'demo off');
      eq(off.json.accounts.length, 0, 'LM_DEMO_ACCOUNTS=0 hides the accounts');
    } finally {
      delete process.env.LM_DEMO_ACCOUNTS;
    }
  });
  await check('normaliseCheckIn converts zoned values to Europe/London wall clock (any process TZ)', async () => {
    eq(normaliseCheckIn('2026-10-15T09:30:00.000Z'), '2026-10-15T10:30:00', 'BST: UTC 09:30 → 10:30');
    eq(normaliseCheckIn('2026-01-15T09:30:00.000Z'), '2026-01-15T09:30:00', 'GMT: UTC 09:30 → 09:30');
    eq(normaliseCheckIn('2026-10-15T23:30:00+02:00'), '2026-10-15T22:30:00', 'offset input');
    eq(normaliseCheckIn('2026-10-15T10:30'), '2026-10-15T10:30:00', 'naive kept verbatim');
    eq(normaliseCheckIn(''), null, 'empty → null');
    return `process TZ=${process.env.TZ ?? '(unset)'}`;
  });
  await check('previousToDateRange = same to-date span of the previous period', async () => {
    const cases: [Parameters<typeof previousToDateRange>[0], string, string, string, string][] = [
      ['week', '2026-10-12', '2026-10-15', '2026-10-05', '2026-10-08'],
      ['month', '2026-10-01', '2026-10-15', '2026-09-01', '2026-09-15'],
      ['month', '2026-03-01', '2026-03-31', '2026-02-01', '2026-02-28'],
      ['quarter', '2026-10-01', '2026-10-15', '2026-07-01', '2026-07-15'],
    ];
    for (const [period, from, to, pf, pt] of cases) {
      const p = previousToDateRange(period, { from, to });
      eq(`${p.from}..${p.to}`, `${pf}..${pt}`, `${period} ${from}..${to}`);
    }
  });
  await check('POST /auth/login validation & mismatch', async () => {
    const bad = await anon.post('/auth/login', {});
    status(bad, 400, 'empty body');
    eq(bad.json.error, 'Validation failed', 'validation error');
    ok(Array.isArray(bad.json.details), 'details array');
    status(await anon.post('/auth/login', { email: 'danil@linear-mcr.co.uk', employeeId: 'LM-9999' }), 401, 'mismatch');
    status(await anon.post('/auth/login', { email: 'nobody@linear-mcr.co.uk', employeeId: 'LM-0001' }), 401, 'unknown email');
  });
  await check('POST /auth/login rate limit: 8 failures per ip+email in 15 min, 9th → 429', async () => {
    const email = 'brute.force@linear-mcr.co.uk';
    for (let i = 1; i <= 8; i++) status(await anon.post('/auth/login', { email, employeeId: `LM-9${String(i).padStart(3, '0')}` }), 401, `attempt ${i}`);
    const r = await anon.post('/auth/login', { email, employeeId: 'LM-9009' });
    status(r, 429, '9th attempt');
    ok(/^Too many attempts, try again in \d+ minutes?$/.test(r.json.error), `error text (${r.json.error})`);
    status(await anon.post('/auth/login', { email: 'JORDAN.LEE@linear-mcr.co.uk', employeeId: 'LM-0010' }), 200, 'other email from the same IP unaffected');
    status(await anon.post('/auth/logout'), 204, 'logout');
  });
  await check('Session cookie: HttpOnly + Lax; Secure only on HTTPS or COOKIE_SECURE=1', async () => {
    const plain = new Client(base, 'cookie');
    const r = await plain.post('/auth/login', { email: 'jordan.lee@linear-mcr.co.uk', employeeId: 'LM-0010' });
    status(r, 200, 'login');
    const sc = r.headers.get('set-cookie') ?? '';
    ok(/HttpOnly/i.test(sc) && /SameSite=Lax/i.test(sc) && !/;\s*Secure/i.test(sc), `plain http: HttpOnly, Lax, no Secure (${sc})`);
    process.env.COOKIE_SECURE = '1';
    try {
      const forced = await new Client(base, 'cookie2').post('/auth/login', { email: 'jordan.lee@linear-mcr.co.uk', employeeId: 'LM-0010' });
      ok(/;\s*Secure/i.test(forced.headers.get('set-cookie') ?? ''), 'COOKIE_SECURE=1 → Secure');
    } finally {
      delete process.env.COOKIE_SECURE;
    }
    status(await plain.post('/auth/logout'), 204, 'logout');
  });
  const logins: [Client, string, string, string][] = [
    [admin, 'DANIL@linear-mcr.co.uk', 'lm-0001', 'admin'],
    [leader, 'amelia.hart@linear-mcr.co.uk', 'LM-0002', 'leader'],
    [recruiter, 'priya.shah@linear-mcr.co.uk', 'LM-0003', 'recruiter'],
    [rep, 'jordan.lee@linear-mcr.co.uk', 'LM-0010', 'rep'],
  ];
  for (const [client, email, employeeId, role] of logins) {
    await check(`POST /auth/login as ${role}`, async () => {
      const r = await client.post('/auth/login', { email, employeeId });
      status(r, 200, 'login');
      eq(r.json.user.role, role, 'role');
      const me = await client.get('/auth/me');
      status(me, 200, 'me');
      eq(me.json.user.email.toLowerCase(), email.toLowerCase(), 'me email');
      return `${me.json.user.firstName} ${me.json.user.lastName}`;
    });
  }

  // ── dashboard ──
  await check('GET /me/dashboard (admin, week/month/quarter)', async () => {
    const r = await admin.get('/me/dashboard');
    status(r, 200, 'dashboard');
    eq(r.json.range, 'week', 'default range');
    eq(r.json.from, monday, 'from = Monday');
    eq(r.json.to, today, 'to = today');
    ok(r.json.company !== null, 'company present for admin');
    positive(r.json.company.revenue, 'company revenue > 0');
    positive(r.json.company.totals.sales, 'company sales > 0');
    ok(r.json.company.byCampaign.length === 4, 'byCampaign has 4 campaigns');
    eq(r.json.team, null, 'owner has no team');
    ok(r.json.upcomingEvents.length > 0 && r.json.upcomingEvents.length <= 5, 'upcoming events 1..5');
    ok(r.json.announcements.length <= 5 && r.json.announcements[0].pinned === true, 'pinned announcement first');
    eq(r.json.previous.from, addDays(monday, -7), 'week compares with the same days last week (from)');
    eq(r.json.previous.to, addDays(today, -7), 'week compares with the same days last week (to)');
    ok(r.json.company.payrollOnTimeWindow === 'range' || r.json.company.payrollOnTimeWindow === 'last12Weeks', 'payrollOnTimeWindow reported');
    ok(r.json.company.payrollOnTimeRate > 0.7 && r.json.company.payrollOnTimeRate <= 1, 'payrollOnTimeRate plausible');
    for (const range of ['month', 'quarter']) {
      const rr = await admin.get(`/me/dashboard?range=${range}`);
      status(rr, 200, range);
      eq(rr.json.range, range, 'range echo');
      ok(rr.json.company.trend.length > 0, `${range} trend`);
      const prevStart = range === 'month' ? startOfMonth(addDays(rr.json.from, -1)) : startOfQuarter(addDays(rr.json.from, -1));
      eq(rr.json.previous.from, prevStart, `${range} previous starts at the previous period`);
      ok(rr.json.previous.to < rr.json.from, `${range} previous ends before this period`);
      if (range === 'quarter') eq(rr.json.company.trend[0].date, rr.json.from, 'weekly trend starts at the quarter start, not the Monday before it');
    }
    status(await admin.get('/me/dashboard?range=year'), 400, 'invalid range');
    return `company sales this week: ${r.json.company.totals.sales}, revenue £${r.json.company.revenue}`;
  });
  await check('GET /me/dashboard (leader Amelia has team + company + own sales)', async () => {
    const r = await leader.get('/me/dashboard');
    status(r, 200, 'dashboard');
    ok(r.json.team !== null && r.json.team.teamName === 'Northern Lights', 'team Northern Lights');
    positive(r.json.team.totals.sales, 'team sales this week > 0');
    positive(r.json.team.leaderboard.length, 'team leaderboard');
    ok(r.json.company !== null, 'company present for leader');
    positive(r.json.personal.totals.sales, 'Amelia sold this week');
    positive(r.json.personal.earningsToDate, 'earnings estimate > 0');
    ok(r.json.personal.nextPayday !== null, 'next payday');
    ok(r.json.personal.punctualityRate === null || r.json.personal.punctualityRate >= 0.9, `demo leader is on time this week (${r.json.personal.punctualityRate})`);
    ok(r.json.upcomingEvents.every((e: Json) => e.teamName === 'Northern Lights'), 'upcoming events are own team');
    return `Amelia: ${r.json.personal.totals.sales} sales / ${r.json.personal.days} days, team ${r.json.team.totals.sales}`;
  });
  await check('GET /me/dashboard (rep Jordan: team, no company, ranked)', async () => {
    const r = await rep.get('/me/dashboard');
    status(r, 200, 'dashboard');
    ok(r.json.team !== null, 'team present');
    eq(r.json.company, null, 'no company for rep');
    positive(r.json.personal.totals.sales, 'Jordan sold this week');
    ok(noDataYet || (r.json.personal.rank !== null && r.json.personal.rankOutOf > 0), 'rank present');
    ok(r.json.personal.punctualityRate === null || r.json.personal.punctualityRate >= 0.9, `demo rep is on time this week (${r.json.personal.punctualityRate})`);
    const board = await rep.get('/leaderboard?period=week');
    eq(r.json.personal.rankOutOf, board.json.length, 'rep rank is team-scoped: same population as their leaderboard');
    eq(board.json.find((x: Json) => x.userId === 10)?.rank ?? null, r.json.personal.rank, 'same rank as on the team board');
    ok(r.json.personal.trend.length >= 1, 'trend');
    ok(r.json.personal.punctualityRate === null || (r.json.personal.punctualityRate >= 0 && r.json.personal.punctualityRate <= 1), 'punctuality 0..1');
    return `Jordan: ${r.json.personal.totals.sales} sales, rank ${r.json.personal.rank}/${r.json.personal.rankOutOf}`;
  });
  await check('GET /me/dashboard (recruiter: no team, no company, recruiter position & plan)', async () => {
    const r = await recruiter.get('/me/dashboard');
    status(r, 200, 'dashboard');
    eq(r.json.team, null, 'team');
    eq(r.json.company, null, 'company');
    ok(r.json.personal.nextPayday !== null, 'recruiter has payroll');
    eq(r.json.user.position, 'recruiter', 'position recruiter');
    eq(r.json.user.payPlanName, 'Office recruiter plan', 'office recruiter plan');
    const fm = await recruiter.get('/finance/me?weeks=6');
    status(fm, 200, 'finance/me');
    ok(fm.json.runs.length > 0 && fm.json.runs.every((p: Json) => p.daysWorked === 5 && p.basePay === 475 && p.commission === 0), 'Mon–Fri × £95, no commission');
    ok(fm.json.runs.every((p: Json) => p.bonus === (p.sales >= 2 ? 100 : 0)), 'bonus £100 in weeks with ≥ 2 hires ("sales" = hires)');
    return `${fm.json.runs.filter((p: Json) => p.bonus > 0).length} bonus week(s) of ${fm.json.runs.length}`;
  });
  await check('Seed realism: venues, B2B weekdays, one site per person per day, offers ≤ 21d, interviews, palette, live timing', async () => {
    eq(get<Json>(db, `SELECT COUNT(*) AS n FROM (SELECT date, venue FROM events WHERE status <> 'cancelled' GROUP BY date, venue HAVING COUNT(*) > 1)`)!.n, 0, 'no two crews at one venue on the same day');
    eq(get<Json>(db, `SELECT COUNT(*) AS n FROM events WHERE type = 'b2b' AND strftime('%w', date) IN ('0', '6')`)!.n, 0, 'B2B events are Mon–Fri');
    eq(get<Json>(db, `SELECT COUNT(*) AS n FROM (SELECT user_id, date FROM gauge_entries GROUP BY user_id, date HAVING COUNT(*) > 1)`)!.n, 0, 'nobody is logged at two events on one day');
    eq(get<Json>(db, `SELECT COUNT(*) AS n FROM candidates WHERE stage = 'offer' AND stage_updated_at < ?`, [new Date(Date.now() - 21 * 86_400_000).toISOString()])!.n, 0, 'no offer older than 21 days');
    eq(get<Json>(db, `SELECT COUNT(*) AS n FROM interviews i JOIN candidates c ON c.id = i.candidate_id WHERE i.outcome = 'pending' AND c.stage IN ('hired', 'rejected', 'withdrawn')`)!.n, 0, 'no pending interviews for closed candidates');
    eq(get<Json>(db, `SELECT COUNT(*) AS n FROM interviews WHERE outcome = 'pending' AND scheduled_at < ?`, [new Date().toISOString()])!.n, 0, 'pending interviews are in the future');
    const slots = all<Json>(db, `SELECT scheduled_at AS at FROM interviews`).map((r) => new Date(r.at));
    ok(slots.every((d) => d.getDay() >= 1 && d.getDay() <= 5 && d.getHours() >= 9 && (d.getHours() < 17 || (d.getHours() === 17 && d.getMinutes() <= 30))), 'interviews Mon–Fri 09:00–17:30');
    ok(AVATAR_PALETTE.every((c) => contrastWithWhite(c) >= 4.5), 'avatar palette ≥ 4.5:1 against white initials');
    eq(get<Json>(db, `SELECT COUNT(*) AS n FROM gauge_entries g JOIN events e ON e.id = g.event_id WHERE e.date = ? AND e.status = 'scheduled'`, [today])!.n, 0, 'no gauges before an event starts');
    eq(get<Json>(db, `SELECT COUNT(*) AS n FROM events WHERE date = ? AND status = 'live' AND start_time > ?`, [today, nowHHMM()])!.n, 0, "today's live events have started");
    eq(get<Json>(db, `SELECT COUNT(*) AS n FROM gauge_entries WHERE checked_in_at > ?`, [`${today}T${nowHHMM()}`])!.n, 0, 'no check-ins in the future');
    eq(get<Json>(db, `SELECT COUNT(*) AS n FROM users WHERE position = 'recruiter' AND role <> 'recruiter'`)!.n, 0, 'recruiter position only for recruiters');
    eq(get<Json>(db, `SELECT COUNT(*) AS n FROM gauge_entries WHERE user_id = 10 AND date >= ? AND sales = 0`, [monday])!.n, 0, 'demo rep has no zero-sales day this week');
    ok(noDataYet || get<Json>(db, `SELECT COUNT(*) AS n FROM gauge_entries WHERE user_id = 10 AND date >= ?`, [monday])!.n > 0, 'demo rep has gauges this week');
    return `${slots.length} interviews, ${AVATAR_PALETTE.length} palette colours`;
  });

  // ── people ──
  let newUserId = 0;
  let leaverId = 0;
  await check('GET /users filters', async () => {
    const r = await admin.get('/users');
    status(r, 200, 'list');
    ok(r.json.length >= 25, 'at least 25 active users');
    ok(r.json.every((u: Json) => u.status === 'active'), 'default status=active');
    ok(r.json.every((u: Json) => typeof u.payPlanName === 'string'), 'payPlanName joined');
    const all = await admin.get('/users?status=all');
    ok(all.json.length > r.json.length, 'status=all includes leavers');
    const q = await admin.get('/users?q=jordan');
    ok(q.json.some((u: Json) => u.employeeId === 'LM-0010'), 'q finds Jordan');
    const leaders = await admin.get('/users?role=leader');
    ok(leaders.json.length >= 4 && leaders.json.every((u: Json) => u.role === 'leader'), 'role filter');
    const team = await admin.get('/users?teamId=1');
    ok(team.json.every((u: Json) => u.teamId === 1), 'teamId filter');
    status(await admin.get('/users?role=wizard'), 400, 'invalid role');
    return `${r.json.length} active / ${all.json.length} total`;
  });
  await check('employeeId is only visible to admins and the person themselves', async () => {
    const list = await rep.get('/users?status=all');
    status(list, 200, 'rep list');
    ok(list.json.every((u: Json) => (u.id === 10 ? u.employeeId === 'LM-0010' : u.employeeId === '')), 'rep sees only own employeeId in the directory');
    eq((await rep.get('/users/1')).json.employeeId, '', 'rep: admin employeeId blank');
    eq((await leader.get('/users/10')).json.employeeId, '', 'leader: rep employeeId blank');
    eq((await recruiter.get('/users/1')).json.employeeId, '', 'recruiter: admin employeeId blank');
    eq((await rep.get('/users/10/performance')).json.user.employeeId, 'LM-0010', 'own performance keeps it');
    eq((await leader.get('/users/10/performance')).json.user.employeeId, '', 'performance of someone else blanks it');
    eq((await admin.get('/users/10')).json.employeeId, 'LM-0010', 'admin sees it');
    eq((await rep.get('/auth/me')).json.user.employeeId, 'LM-0010', 'auth/me keeps it');
    eq((await rep.get('/users?q=LM-0001&status=all')).json.length, 0, 'q does not match employee IDs for non-admins');
    ok((await admin.get('/users?q=LM-0001')).json.some((u: Json) => u.id === 1), 'q matches employee IDs for admins');
    const team = await leader.get('/finance/payroll');
    ok(team.json.length > 0 && team.json.every((p: Json) => (p.userId === 2 ? p.employeeId === 'LM-0002' : p.employeeId === '')), 'payroll rows blank other people\'s IDs');
    const slip = await leader.get(`/finance/payroll/${team.json.find((p: Json) => p.userId !== 2).id}`);
    status(slip, 200, 'payslip');
    eq(slip.json.employeeId, '', 'payslip blanks the ID for the leader');
  });
  await check('Date ranges are bounded (max 400 days, not before 2020) and limit is capped at 500', async () => {
    const big = await rep.get(`/users/10/performance?from=2020-01-01&to=${today}`);
    status(big, 400, 'too large');
    eq(big.json.error, 'Date range too large (max 400 days)', 'error text');
    status(await rep.get('/users/10/performance?from=2019-12-31&to=2020-01-05'), 400, 'before 2020');
    status(await admin.get(`/finance/summary?from=2020-01-01&to=${today}`), 400, 'finance summary too large');
    status(await admin.get(`/gauges/summary?groupBy=day&from=2020-01-01&to=${today}`), 400, 'gauges summary too large');
    status(await recruiter.get(`/recruitment/summary?from=2020-01-01&to=${today}`), 400, 'recruitment summary too large');
    status(await admin.get(`/events?from=2020-01-01&to=${today}`), 400, 'events too large');
    status(await rep.get(`/users/10/performance?from=${addDays(today, -399)}&to=${today}`), 200, '399-day span accepted');
    const capped = await admin.get(`/gauges?from=${twelveWeeksAgo}&to=${today}&limit=5000`);
    status(capped, 200, 'limit accepted');
    eq(capped.json.length, 500, 'limit capped at 500');
  });
  await check('GET /users/:id & performance (read-only for all; check-ins/notes stripped outside own team)', async () => {
    const r = await rep.get('/users/10');
    status(r, 200, 'get');
    eq(r.json.teamName, 'Northern Lights', 'team name');
    status(await rep.get('/users/99999'), 404, 'missing user');
    const range = `from=${twelveWeeksAgo}&to=${today}`;
    const perf = await rep.get(`/users/10/performance?${range}`);
    status(perf, 200, 'performance');
    ok(perf.json.totals.sales > 0 && perf.json.days > 0, 'totals');
    ok(typeof perf.json.ratios.overallConversion === 'number', 'ratios');
    ok(perf.json.trend.length > 60, 'daily trend covers range');
    ok(perf.json.byCampaign.length > 0, 'byCampaign');
    ok(perf.json.recentEntries.length === 10, 'recentEntries 10');
    ok(perf.json.recentEntries.some((e: Json) => e.checkedInAt !== null), 'own entries keep check-in times');
    const stripped = (entries: Json[]) => entries.length > 0 && entries.every((e: Json) => e.checkedInAt === null && e.notes === null);
    const mate = await rep.get(`/users/9/performance?${range}`);
    status(mate, 200, 'rep reads a teammate');
    ok(stripped(mate.json.recentEntries), "teammate's check-ins/notes stripped");
    const other = await rep.get(`/users/16/performance?${range}`);
    status(other, 200, 'rep reads another team (read-only)');
    ok(stripped(other.json.recentEntries), "other team's check-ins/notes stripped");
    const recr = await recruiter.get(`/users/10/performance?${range}`);
    status(recr, 200, 'recruiter reads a rep');
    ok(stripped(recr.json.recentEntries), 'stripped for the recruiter');
    const ldrOwn = await leader.get(`/users/10/performance?${range}`);
    ok(ldrOwn.json.recentEntries.some((e: Json) => e.checkedInAt !== null), 'leader sees own team members\' check-ins');
    const ldrOther = await leader.get(`/users/16/performance?${range}`);
    ok(stripped(ldrOther.json.recentEntries), "leader: other team's details stripped");
    ok((await admin.get(`/users/16/performance?${range}`)).json.recentEntries.some((e: Json) => e.checkedInAt !== null), 'admin sees everything');
    return `Jordan 12w: ${perf.json.totals.sales} sales over ${perf.json.days} days`;
  });
  await check('POST/PATCH /users (admin only, 409 on duplicates)', async () => {
    status(await rep.post('/users', {}), 403, 'rep forbidden');
    const body = {
      employeeId: 'LM-0900', email: 'test.user@linear-mcr.co.uk', firstName: 'Test', lastName: 'User', role: 'rep', position: 'trainee',
      teamId: 2, startDate: today, status: 'active', phone: null, city: 'Manchester',
    };
    const r = await admin.post('/users', body);
    status(r, 201, 'create');
    eq(r.json.teamName, 'Deansgate', 'team joined');
    ok(/^#[0-9A-Fa-f]{6}$/.test(r.json.avatarColor), 'avatar colour assigned');
    newUserId = r.json.id;
    status(await admin.post('/users', body), 409, 'duplicate');
    status(await admin.post('/users', { ...body, employeeId: 'LM-0901', email: 'not-an-email' }), 400, 'validation');
    const p = await admin.patch(`/users/${newUserId}`, { position: 'field_rep', city: 'Salford' });
    status(p, 200, 'patch');
    eq(p.json.position, 'field_rep', 'patched position');
    status(await admin.patch('/users/99999', { city: 'X' }), 404, 'patch missing');
  });
  await check('PATCH status=left revokes sessions; admins cannot deactivate themselves', async () => {
    const body = {
      employeeId: 'LM-0910', email: 'smoke.leaver@linear-mcr.co.uk', firstName: 'Smoke', lastName: 'Leaver', role: 'rep', position: 'trainee',
      teamId: 1, startDate: today, status: 'active', phone: null, city: 'Manchester',
    };
    const created = await admin.post('/users', body);
    status(created, 201, 'create');
    leaverId = created.json.id;
    const leaver = new Client(base, 'leaver');
    status(await leaver.post('/auth/login', { email: body.email, employeeId: body.employeeId }), 200, 'login');
    status(await leaver.get('/auth/me'), 200, 'session works while active');
    status(await admin.patch(`/users/${leaverId}`, { status: 'left' }), 200, 'patch left');
    eq(get<Json>(db, `SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?`, [leaverId])!.n, 0, 'sessions deleted on deactivation');
    status(await leaver.get('/auth/me'), 401, 'existing session rejected');
    status(await leaver.get('/me/dashboard'), 401, 'dashboard rejected');
    status(await leaver.post('/auth/login', { email: body.email, employeeId: body.employeeId }), 401, 'login rejected');
    // a session that survived the delete is still rejected (and removed) by authenticate
    run(db, `INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES ('stale-left-token', ?, ?, ?)`, [leaverId, new Date().toISOString(), new Date(Date.now() + 86_400_000).toISOString()]);
    const stale = await fetch(`${base}/auth/me`, { headers: { cookie: 'lm_session=stale-left-token' } });
    eq(stale.status, 401, 'stale session of a left user is rejected');
    eq(get<Json>(db, `SELECT COUNT(*) AS n FROM sessions WHERE token = 'stale-left-token'`)!.n, 0, 'and deleted');
    const self = await admin.patch('/users/1', { status: 'left' });
    status(self, 400, 'admin cannot deactivate themselves');
    eq((await admin.get('/users/1')).json.status, 'active', 'admin still active');
    status(await admin.get('/auth/me'), 200, 'admin session intact');
  });
  await check('GET /teams', async () => {
    const r = await rep.get('/teams');
    status(r, 200, 'teams');
    eq(r.json.length, 4, 'four teams');
    const nl = r.json.find((t: Json) => t.name === 'Northern Lights');
    eq(nl.leaderName, 'Amelia Hart', 'leader name');
    ok(nl.memberCount >= 5, 'member count');
  });

  // ── campaigns ──
  await check('GET/POST/PATCH /campaigns', async () => {
    const r = await rep.get('/campaigns');
    status(r, 200, 'list');
    eq(r.json.length, 4, 'four campaigns');
    ok(r.json.every((c: Json) => c.active === true), 'active boolean');
    status(await rep.post('/campaigns', {}), 403, 'rep forbidden');
    const c = await admin.post('/campaigns', {
      name: 'Test Water', code: 'TWT', sector: 'other', type: 'b2c', payoutPerSale: 80, repCommissionPerSale: 30, color: '#123456', startDate: today, description: null,
    });
    status(c, 201, 'create');
    status(await admin.post('/campaigns', { name: 'Dup', code: 'twt', sector: 'other', type: 'b2c', payoutPerSale: 1, repCommissionPerSale: 1, color: '#123456' }), 409, 'duplicate code');
    const p = await admin.patch(`/campaigns/${c.json.id}`, { active: false });
    status(p, 200, 'patch');
    eq(p.json.active, false, 'deactivated');
    const inactive = await admin.get('/campaigns?active=false');
    ok(inactive.json.some((x: Json) => x.id === c.json.id), 'filter active=false');
    eq((await admin.get('/campaigns?active=true')).json.length, 4, 'active=true');
  });

  // ── events ──
  let futureNlEvent: Json = null;
  let createdEventId = 0;
  await check('GET /events (defaults, filters, rep scoping)', async () => {
    const r = await admin.get('/events');
    status(r, 200, 'list');
    ok(r.json.length > 20, 'default range has events');
    ok(r.json.every((e: Json, i: number, a: Json[]) => i === 0 || a[i - 1].date <= e.date), 'sorted by date');
    ok(r.json.every((e: Json) => e.date >= weekAgo && e.date <= addDays(today, 21)), 'default range window');
    ok(r.json.every((e: Json) => typeof e.totals?.sales === 'number' && typeof e.repCount === 'number'), 'meta shape');
    const f = await admin.get('/events?teamId=1&status=scheduled');
    ok(f.json.length > 0 && f.json.every((e: Json) => e.teamId === 1 && e.status === 'scheduled'), 'team+status filter');
    futureNlEvent = f.json[0];
    const repList = await rep.get(`/events?from=${weekAgo}&to=${addDays(today, 21)}&teamId=2`);
    ok(repList.json.length > 0 && repList.json.every((e: Json) => e.teamId === 1), 'rep only sees own team');
    const todays = await admin.get(`/events?from=${today}&to=${today}`);
    ok(todays.json.length > 0, 'events today');
    ok(todays.json.every((e: Json) => e.status === 'cancelled' || (e.status === 'live' ? e.startTime <= nowHHMM() : e.status === 'scheduled' && e.startTime > seedTime)), 'today: live only once the start time has passed, scheduled before');
    status(await admin.get('/events?from=2026-13-01'), 400, 'bad date');
    return `${r.json.length} events in default window`;
  });
  await check('GET /events/:id with entries & ratios', async () => {
    const past = await admin.get(`/events?from=${weekAgo}&to=${addDays(today, -1)}&teamId=1&status=completed`);
    ok(past.json.length > 0, 'past events');
    const r = await admin.get(`/events/${past.json[0].id}`);
    status(r, 200, 'get');
    ok(Array.isArray(r.json.entries) && r.json.entries.length > 0, 'entries');
    ok(typeof r.json.ratios.stopToTable === 'number', 'ratios');
    eq(r.json.repCount, r.json.entries.length, 'repCount matches entries');
    status(await admin.get('/events/99999'), 404, 'missing');
    ok(r.json.entries.some((e: Json) => e.checkedInAt !== null), 'admin sees check-ins');
    const own = await rep.get(`/events/${past.json[0].id}`);
    status(own, 200, 'rep reads own team event');
    ok(own.json.entries.every((e: Json) => e.userId === 10 || (e.checkedInAt === null && e.notes === null)), "teammates' check-ins/notes stripped for a rep");
    const foreign = (await admin.get(`/events?teamId=2&status=completed&from=${twelveWeeksAgo}&to=${today}`)).json[0];
    const fr = await rep.get(`/events/${foreign.id}`);
    status(fr, 200, "rep can read another team's event (read-only)");
    ok(fr.json.entries.length > 0 && fr.json.entries.every((e: Json) => e.checkedInAt === null && e.notes === null), 'all entries stripped');
    const lr = await leader.get(`/events/${past.json[0].id}`);
    ok(lr.json.entries.some((e: Json) => e.checkedInAt !== null), "leader sees own team's check-ins");
  });
  await check('POST/PATCH/DELETE /events permissions', async () => {
    const body = {
      campaignId: 1, teamId: 1, name: 'Smoke stand', venue: 'Trafford Centre', city: 'Manchester', type: 'retail',
      date: addDays(today, 10), startTime: '10:00', endTime: '18:00', targetSales: 12, notes: null,
    };
    status(await rep.post('/events', body), 403, 'rep forbidden');
    status(await leader.post('/events', { ...body, teamId: 2 }), 403, 'leader other team');
    const r = await leader.post('/events', body);
    status(r, 201, 'leader own team');
    eq(r.json.status, 'scheduled', 'default status');
    eq(r.json.campaignCode, 'BCN', 'campaign meta');
    createdEventId = r.json.id;
    status(await leader.post('/events', { ...body, endTime: '09:00' }), 400, 'end before start');
    const p = await leader.patch(`/events/${createdEventId}`, { targetSales: 15, notes: 'Bring banners' });
    status(p, 200, 'patch');
    eq(p.json.targetSales, 15, 'patched target');
    status(await leader.del(`/events/${createdEventId}`), 403, 'leader cannot delete');
    status(await admin.del(`/events/${createdEventId}`), 204, 'admin delete');
    status(await admin.get(`/events/${createdEventId}`), 404, 'gone');
  });

  // ── gauges ──
  let gaugeId = 0;
  let pastNlEvent: Json = null;
  let cancelledNlEvent: Json = null;
  await check('Gauge fixtures: a completed and a cancelled Northern Lights event (admin)', async () => {
    // yesterday stays inside the current pay week except on a Monday, when today's live event is used instead
    const date = dayOfWeek(today) === 1 ? today : addDays(today, -1);
    const fixture = { campaignId: 1, teamId: 1, name: 'Smoke completed stand', venue: 'Arndale', city: 'Manchester', type: 'retail', date, startTime: '10:00', endTime: '18:00', targetSales: 12, notes: null };
    const r = await admin.post('/events', fixture);
    status(r, 201, 'completed event');
    const expected = date < today ? 'completed' : fixture.startTime <= nowHHMM() ? 'live' : 'scheduled';
    eq(r.json.status, expected, 'status derived from date and start time');
    pastNlEvent = r.json;
    const c = await admin.post('/events', { ...fixture, name: 'Smoke cancelled stand', date: addDays(today, -3), status: 'cancelled' });
    status(c, 201, 'cancelled event');
    eq(c.json.status, 'cancelled', 'cancelled');
    cancelledNlEvent = c.json;
    return `${pastNlEvent.date} (${pastNlEvent.status})`;
  });
  await check('GET /gauges (defaults, rep scoping)', async () => {
    const r = await admin.get('/gauges');
    status(r, 200, 'list');
    ok(r.json.length > 0 && r.json.every((g: Json) => g.date >= monday && g.date <= today), 'default range this week');
    ok(r.json.every((g: Json, i: number, a: Json[]) => i === 0 || a[i - 1].date >= g.date), 'newest first');
    ok(typeof r.json[0].table === 'number' && typeof r.json[0].campaignName === 'string', 'meta shape');
    const withCheckIn = r.json.find((g: Json) => g.checkedInAt !== null);
    ok(withCheckIn && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(withCheckIn.checkedInAt), 'seeded checkedInAt is naive local time (no zone)');
    const mine = await rep.get(`/gauges?from=${twelveWeeksAgo}&to=${today}&limit=50`);
    ok(mine.json.length > 0 && mine.json.length <= 50 && mine.json.every((g: Json) => g.userId === 10), 'rep sees own only');
    status(await rep.get('/gauges?userId=2'), 403, 'rep cannot query others');
    const byEvent = await leader.get(`/gauges?eventId=${r.json[0].eventId}`);
    ok(byEvent.json.length > 0, 'eventId filter ignores default range');
  });
  await check('POST /gauges upsert (201 then 200), invalid funnel 400', async () => {
    ok(pastNlEvent, 'need a completed Northern Lights event');
    const body = { eventId: pastNlEvent.id, userId: 10, date: pastNlEvent.date, stops: 60, table: 20, presentations: 10, closes: 4, taps: 3, sales: 2, checkedInAt: `${pastNlEvent.date}T${pastNlEvent.startTime}:00Z`, notes: 'smoke' };
    const r1 = await rep.post('/gauges', body);
    status(r1, 201, 'create');
    eq(r1.json.sales, 2, 'sales');
    eq(r1.json.userName, 'Jordan Lee', 'user meta');
    ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(r1.json.checkedInAt), 'zoned check-in stored as naive local time');
    const naive = await rep.post('/gauges', { ...body, checkedInAt: `${pastNlEvent.date}T10:03` });
    eq(naive.json.checkedInAt, `${pastNlEvent.date}T10:03:00`, 'naive check-in kept verbatim (seconds padded)');
    gaugeId = r1.json.id;
    // omitted keys keep the stored values, explicit nulls clear them
    const { checkedInAt: _ci, notes: _no, ...numbersOnly } = body;
    const kept = await rep.post('/gauges', numbersOnly);
    status(kept, 200, 'omitted');
    eq(kept.json.notes, 'smoke', 'omitted notes kept');
    eq(kept.json.checkedInAt, `${pastNlEvent.date}T10:03:00`, 'omitted check-in kept');
    const cleared = await rep.post('/gauges', { ...body, checkedInAt: null, notes: null });
    status(cleared, 200, 'explicit nulls');
    eq(cleared.json.checkedInAt, null, 'checkedInAt cleared');
    eq(cleared.json.notes, null, 'notes cleared');
    status(await rep.post('/gauges', { ...body, id: gaugeId }), 200, 'id of the same entry → plain upsert');
    status(await rep.post('/gauges', { ...body, id: gaugeId + 100_000 }), 409, 'id of a different entry → 409 (use PATCH)');
    const r2 = await rep.post('/gauges', { ...body, sales: 3, taps: 3 });
    status(r2, 200, 'update');
    eq(r2.json.id, gaugeId, 'same row');
    eq(r2.json.sales, 3, 'updated sales');
    const bad = await rep.post('/gauges', { ...body, sales: 5, taps: 3 });
    status(bad, 400, 'invalid funnel');
    eq(bad.json.error, 'Invalid funnel', 'error text');
    ok(Array.isArray(bad.json.details) && bad.json.details.length > 0, 'details list');
    status(await rep.post('/gauges', { ...body, stops: -1 }), 400, 'negative');
    status(await rep.post('/gauges', { ...body, userId: 9 }), 403, 'rep cannot submit for others');
    status(await recruiter.post('/gauges', body), 403, 'recruiter cannot submit');
    const otherTeam = (await admin.get('/events?teamId=2&status=scheduled')).json[0];
    status(await rep.post('/gauges', { ...body, eventId: otherTeam.id, date: otherTeam.date }), 403, 'rep other-team event');
    status(await leader.post('/gauges', { ...body, userId: 9, notes: 'leader entry' }), 201, 'leader for team member');
  });
  await check('POST/PATCH /gauges integrity: event date, cancelled, future, inactive user, other team', async () => {
    const body = { eventId: pastNlEvent.id, userId: 10, date: pastNlEvent.date, stops: 30, table: 10, presentations: 5, closes: 2, taps: 1, sales: 1 };
    const wrongDate = await rep.post('/gauges', { ...body, date: addDays(pastNlEvent.date, -1) });
    status(wrongDate, 400, 'date must equal the event date');
    eq(wrongDate.json.error, "Gauges are recorded against the event's date", 'error text');
    status(await rep.post('/gauges', { ...body, eventId: cancelledNlEvent.id, date: cancelledNlEvent.date }), 409, 'cancelled event');
    status(await admin.post('/gauges', { ...body, eventId: cancelledNlEvent.id, date: cancelledNlEvent.date }), 409, 'cancelled event (admin too)');
    status(await rep.post('/gauges', { ...body, eventId: futureNlEvent.id, date: futureNlEvent.date }), 400, 'future event');
    status(await admin.post('/gauges', { ...body, eventId: futureNlEvent.id, date: futureNlEvent.date }), 400, 'future event (admin too)');
    status(await leader.post('/gauges', { ...body, userId: leaverId }), 400, 'inactive (left) user');
    const otherTeam = (await admin.get(`/events?teamId=2&status=completed&from=${twelveWeeksAgo}&to=${today}`)).json[0];
    ok(otherTeam, 'need a completed team-2 event');
    status(await leader.post('/gauges', { ...body, userId: 2, eventId: otherTeam.id, date: otherTeam.date }), 403, "leader cannot log at another team's event");
    status(await leader.post('/gauges', { ...body, userId: 9, eventId: otherTeam.id, date: otherTeam.date }), 403, "leader cannot log a member at another team's event");
    status(await rep.patch(`/gauges/${gaugeId}`, { date: addDays(pastNlEvent.date, -1) }), 400, 'PATCH cannot move the date off the event');
    status(await rep.patch(`/gauges/${gaugeId}`, { eventId: futureNlEvent.id, date: futureNlEvent.date }), 400, 'PATCH cannot move the entry to a future event');
  });
  await check('PATCH/DELETE /gauges', async () => {
    const p = await rep.patch(`/gauges/${gaugeId}`, { sales: 1, notes: 'patched' });
    status(p, 200, 'patch');
    eq(p.json.sales, 1, 'patched sales');
    eq(p.json.notes, 'patched', 'patched notes');
    eq((await rep.patch(`/gauges/${gaugeId}`, { notes: null })).json.notes, null, 'PATCH null clears notes');
    status(await rep.patch(`/gauges/${gaugeId}`, { sales: 99 }), 400, 'patch invalid funnel');
    status(await rep.del(`/gauges/${gaugeId}`), 403, 'rep cannot delete');
    status(await leader.del(`/gauges/${gaugeId}`), 204, 'leader deletes');
    status(await leader.del(`/gauges/${gaugeId}`), 404, 'already gone');
  });
  await check('GET /gauges/summary groupBy user|team|campaign|day|week', async () => {
    const range = `from=${twelveWeeksAgo}&to=${today}`;
    for (const g of ['user', 'team', 'campaign']) {
      const r = await admin.get(`/gauges/summary?groupBy=${g}&${range}`);
      status(r, 200, g);
      ok(r.json.length > 0, `${g} rows`);
      ok(r.json.every((row: Json, i: number, a: Json[]) => i === 0 || a[i - 1].sales >= row.sales), `${g} sorted by sales desc`);
      ok(typeof r.json[0].ratios.overallConversion === 'number' && typeof r.json[0].salesPerDay === 'number', `${g} shape`);
    }
    const day = await admin.get(`/gauges/summary?groupBy=day&${range}`);
    ok(day.json.every((row: Json, i: number, a: Json[]) => i === 0 || a[i - 1].key < row.key), 'day chronological');
    const week = await admin.get(`/gauges/summary?groupBy=week&${range}`);
    ok(week.json.length >= 12 && week.json.every((row: Json) => dayOfWeek(row.key) === 1), 'week keys are Mondays');
    const teamRows = await rep.get(`/gauges/summary?groupBy=user&${range}`);
    ok(teamRows.json.length > 0 && teamRows.json.length < 12, 'rep summary is scoped to own team');
    status(await admin.get('/gauges/summary?groupBy=planet'), 400, 'invalid groupBy');
    return `${week.json.length} weeks`;
  });

  // ── leaderboard ──
  await check('GET /leaderboard', async () => {
    for (const period of ['week', 'month', 'quarter']) {
      const r = await admin.get(`/leaderboard?period=${period}`);
      status(r, 200, period);
      ok(r.json.length > 0 && r.json.length <= 200, 'row count (≤ 200)');
      eq(Number(r.headers.get('x-total-count')), r.json.length, 'X-Total-Count = ranked people');
      if (period === 'quarter') ok(r.json.length > 25, 'quarter board lists everyone ranked, not just the top 25');
      ok(r.json.every((row: Json, i: number, a: Json[]) => row.rank <= i + 1 && (i === 0 || a[i - 1].rank <= row.rank)), 'competition ranks (ties share)');
      eq(r.json[0].rank, 1, 'first row is rank 1');
      ok(r.json.every((row: Json, i: number, a: Json[]) => i === 0 || a[i - 1].sales >= row.sales), 'sorted by sales');
    }
    const conv = await admin.get('/leaderboard?period=month&metric=conversion');
    ok(conv.json.every((row: Json, i: number, a: Json[]) => i === 0 || a[i - 1].conversion >= row.conversion), 'sorted by conversion');
    const month = await admin.get('/leaderboard?period=month');
    ok(month.json.some((row: Json) => row.movement !== null), 'movement computed vs previous month');
    const repBoard = await rep.get('/leaderboard?period=month&teamId=3');
    ok(repBoard.json.every((row: Json) => row.teamId === 1), 'rep forced to own team');
    status(await admin.get('/leaderboard?period=decade'), 400, 'invalid period');
    return `#1 this month: ${month.json[0].userName} (${month.json[0].sales})`;
  });

  // ── payroll materialisation & next pay (direct calls against the same database) ──
  const lastCompletedMonday = addDays(monday, -7);
  const RUN_COLUMNS = `user_id AS userId, days_worked AS daysWorked, sales, team_sales AS teamSales, due_date AS dueDate, status, reference`;
  await check('materialisePayrollRuns rebuilds a completed week by the seed rules (via GET /finance/payroll guard)', async () => {
    const seeded = all<Json>(db, `SELECT ${RUN_COLUMNS}, gross + deductions AS gross FROM payroll_runs WHERE week_start = ? ORDER BY user_id`, [lastCompletedMonday]);
    ok(seeded.length > 20, 'seed has runs for the last completed week');
    ok(seeded.some((r: Json) => r.teamSales > 0), 'includes leaders with overrides');
    run(db, `DELETE FROM payroll_runs WHERE week_start = ?`, [lastCompletedMonday]);
    eq(materialisePayrollRuns(db, addDays(lastCompletedMonday, 6)), 0, 'nothing is created while the week is still in progress');
    const r = await admin.get(`/finance/payroll?from=${lastCompletedMonday}&to=${lastCompletedMonday}`);
    status(r, 200, 'list');
    eq(r.json.length, seeded.length, 'GET /finance/payroll materialised the missing week');
    ok(r.json.every((p: Json) => p.status === 'pending' && p.paidDate === null), 'new runs are pending');
    const rebuilt = all<Json>(db, `SELECT ${RUN_COLUMNS}, gross FROM payroll_runs WHERE week_start = ? ORDER BY user_id`, [lastCompletedMonday]);
    eq(JSON.stringify(rebuilt), JSON.stringify(seeded), 'same users, days, sales, team sales, gross (before deductions), due date, status and reference');
    eq(materialisePayrollRuns(db), 0, 'idempotent');
    return `${rebuilt.length} runs for w/c ${lastCompletedMonday}`;
  });
  await check('nextPay returns the earliest unpaid run even when overdue (status untouched)', async () => {
    const jordan = getUser(db, 10)!;
    const pendingRun = get<Json>(db, `SELECT due_date AS dueDate, gross FROM payroll_runs WHERE user_id = 10 AND status = 'pending' ORDER BY due_date ASC LIMIT 1`);
    ok(pendingRun, 'Jordan has a pending run');
    const onDue = nextPay(db, jordan, pendingRun.dueDate);
    eq(onDue.nextPayday, pendingRun.dueDate, 'due today → that run');
    eq(onDue.nextPayAmount, pendingRun.gross, 'amount');
    const overdue = nextPay(db, jordan, addDays(pendingRun.dueDate, 3));
    eq(overdue.nextPayday, pendingRun.dueDate, 'overdue run is still the next pay');
    eq(overdue.nextPayAmount, pendingRun.gross, 'overdue amount');
    eq(get<Json>(db, `SELECT status FROM payroll_runs WHERE user_id = 10 AND due_date = ?`, [pendingRun.dueDate])!.status, 'pending', 'stored status not mutated');
    run(db, `UPDATE payroll_runs SET status = 'failed' WHERE user_id = 10 AND due_date = ?`, [pendingRun.dueDate]);
    eq(nextPay(db, jordan, addDays(pendingRun.dueDate, 10)).nextPayday, pendingRun.dueDate, 'a failed run still needs paying');
    run(db, `UPDATE payroll_runs SET status = 'pending' WHERE user_id = 10 AND due_date = ?`, [pendingRun.dueDate]);
    return `${pendingRun.dueDate} £${pendingRun.gross}`;
  });

  // ── finance ──
  let pendingRunId = 0;
  await check('GET /finance/payroll (scoping & filters)', async () => {
    const r = await admin.get('/finance/payroll');
    status(r, 200, 'admin list');
    ok(r.json.length > 100, 'plenty of runs');
    ok(r.json.every((p: Json, i: number, a: Json[]) => i === 0 || a[i - 1].weekStart >= p.weekStart), 'newest first');
    ok(r.json.every((p: Json) => p.weekStart >= twelveWeeksAgo), 'default last 12 weeks');
    ok(r.json.every((p: Json) => 'onTime' in p && typeof p.userName === 'string'), 'shape');
    const pending = await admin.get('/finance/payroll?status=pending');
    ok(pending.json.length > 0 && pending.json.every((p: Json) => p.status === 'pending' && p.paidDate === null), 'pending filter');
    pendingRunId = pending.json[0].id;
    const unpaid = await admin.get(`/finance/payroll?status=pending,failed&from=${twelveWeeksAgo}&to=${today}`);
    status(unpaid, 200, 'comma list');
    ok(unpaid.json.length > pending.json.length && unpaid.json.every((p: Json) => p.status === 'pending' || p.status === 'failed'), 'status=pending,failed returns both');
    status(await admin.get('/finance/payroll?status=pending,bogus'), 400, 'invalid member of the list');
    const failedRun = unpaid.json.find((p: Json) => p.status === 'failed');
    ok(failedRun, 'seed has a failed run in range');
    const repaid = await admin.post(`/finance/payroll/${failedRun.id}/pay`, {});
    status(repaid, 200, 'a failed run can be paid');
    ok(repaid.json.status === 'paid' || repaid.json.status === 'late', 'settled');
    const mine = await rep.get('/finance/payroll');
    ok(mine.json.length > 0 && mine.json.every((p: Json) => p.userId === 10), 'rep own only');
    status(await rep.get('/finance/payroll?userId=2'), 403, 'rep cannot see others');
    const team = await leader.get('/finance/payroll');
    ok(team.json.length > 0 && team.json.every((p: Json) => p.teamName === 'Northern Lights'), 'leader own team');
    status(await leader.get('/finance/payroll?userId=16'), 403, 'leader other team');
    const recr = await recruiter.get('/finance/payroll');
    ok(recr.json.length > 0 && recr.json.every((p: Json) => p.userId === 3), 'recruiter own only');
    return `${r.json.length} runs, ${pending.json.length} pending`;
  });
  await check('GET /finance/payroll/:id payslip & POST pay', async () => {
    const r = await admin.get(`/finance/payroll/${pendingRunId}`);
    status(r, 200, 'payslip');
    ok(r.json.plan && typeof r.json.plan.basePerDay === 'number', 'plan');
    ok(Array.isArray(r.json.entries), 'entries');
    const own = (await rep.get('/finance/payroll')).json[0];
    status(await rep.get(`/finance/payroll/${own.id}`), 200, 'rep own payslip');
    const foreign = (await admin.get('/finance/payroll?userId=16')).json[0];
    status(await rep.get(`/finance/payroll/${foreign.id}`), 403, 'rep foreign payslip');
    status(await leader.get(`/finance/payroll/${own.id}`), 200, 'leader reads own-team payslip');
    status(await leader.get(`/finance/payroll/${foreign.id}`), 403, 'leader cannot read other-team payslip');
    const exact = await rep.get(`/gauges?eventId=${own.id > 0 ? (await rep.get(`/gauges?from=${twelveWeeksAgo}&to=${today}&limit=1`)).json[0].eventId : 0}&userId=10&from=${(await rep.get(`/gauges?from=${twelveWeeksAgo}&to=${today}&limit=1`)).json[0].date}&to=${(await rep.get(`/gauges?from=${twelveWeeksAgo}&to=${today}&limit=1`)).json[0].date}`);
    eq(exact.json.length, 1, 'eventId+userId+from=to=date finds exactly the one entry');
    status(await rep.post(`/finance/payroll/${pendingRunId}/pay`, {}), 403, 'rep cannot pay');
    const paid = await admin.post(`/finance/payroll/${pendingRunId}/pay`, {});
    status(paid, 200, 'pay');
    ok(paid.json.status === 'paid' || paid.json.status === 'late', 'status settled');
    eq(paid.json.paidDate, today, 'paid today');
    eq(paid.json.onTime, paid.json.status === 'paid', 'onTime matches status');
    status(await admin.post(`/finance/payroll/${pendingRunId}/pay`, {}), 409, 'double pay');
    status(await admin.post('/finance/payroll/999999/pay', {}), 404, 'missing run');
    return `${paid.json.reference} → ${paid.json.status}`;
  });
  await check('GET /finance/summary (admin, leader scoped, rep 403)', async () => {
    status(await rep.get('/finance/summary'), 403, 'rep forbidden');
    status(await recruiter.get('/finance/summary'), 403, 'recruiter forbidden');
    const r = await admin.get('/finance/summary');
    status(r, 200, 'admin');
    ok(r.json.weeks.length >= 12 && r.json.weeks.every((w: Json) => dayOfWeek(w.weekStart) === 1), 'weekly rows on Mondays');
    ok(r.json.totals.revenue > 0 && r.json.totals.payroll > 0 && r.json.totals.expenses > 0, 'totals');
    eq(Math.round(r.json.totals.profit), Math.round(r.json.totals.revenue - r.json.totals.payroll - r.json.totals.expenses), 'profit = rev − pay − exp');
    eq(r.json.byCampaign.length, 4, 'four campaigns');
    ok(r.json.payroll.onTimeRate > 0.7 && r.json.payroll.onTimeRate <= 1, 'on-time rate plausible');
    ok(r.json.payroll.late > 0 && r.json.payroll.avgDaysLate > 0, 'late stats');
    ok(r.json.payroll.paid > r.json.payroll.late, 'paid counts every settled run (paid + late)');
    ok(r.json.payroll.runs - r.json.payroll.paid - r.json.payroll.pending >= 0, 'failed = runs − paid − pending is non-negative');
    eq(r.json.payroll.onTimeRate, Math.round(((r.json.payroll.paid - r.json.payroll.late) / r.json.payroll.paid) * 100) / 100, 'onTimeRate = (paid − late) / paid');
    ok(r.json.expensesByCategory.length >= 5, 'expense categories');
    const l = await leader.get(`/finance/summary?from=${twelveWeeksAgo}&to=${today}`);
    status(l, 200, 'leader');
    ok(l.json.totals.payroll < r.json.totals.payroll, 'leader view is team-scoped');
    // the week in progress has no runs yet → live estimate, flagged
    const current = r.json.weeks[r.json.weeks.length - 1];
    eq(current.weekStart, monday, 'default range ends with the current week');
    eq(current.estimated, true, 'current week payroll is a live estimate');
    ok(current.payroll > 0, 'estimate > 0 (the recruiter is paid Mon–Fri even before any event starts)');
    eq(r.json.to, sundayOf(today), 'default `to` is snapped to the Sunday of this week');
    ok(r.json.weeks.slice(0, -1).every((w: Json) => !w.estimated), 'completed weeks are settled payroll');
    // snapping: a mid-week window is widened to whole Mon–Sun pay weeks so revenue, payroll and expenses cover identical days
    const lastSunday = addDays(monday, -1);
    const snapped = await admin.get(`/finance/summary?from=${addDays(twelveWeeksAgo, 3)}&to=${addDays(lastSunday, -2)}`);
    status(snapped, 200, 'snapped');
    eq(snapped.json.from, twelveWeeksAgo, 'from snapped back to Monday');
    eq(snapped.json.to, lastSunday, 'to snapped forward to Sunday');
    eq(snapped.json.weeks.length, 12, '12 whole weeks');
    const firstWeek = snapped.json.weeks[0];
    const wholeWeek = (await admin.get(`/finance/summary?from=${twelveWeeksAgo}&to=${addDays(twelveWeeksAgo, 6)}`)).json.weeks[0];
    eq(firstWeek.revenue, wholeWeek.revenue, 'a straddled week reports its full revenue, not a partial slice');
    eq(firstWeek.payroll, wholeWeek.payroll, 'and its full payroll');
    // byCampaign commission is the pay-plan commission reps actually earn → equals payroll commission for complete weeks
    const commission = snapped.json.byCampaign.reduce((a: number, c: Json) => a + c.commission, 0);
    const paidCommission = (await admin.get(`/finance/payroll?from=${twelveWeeksAgo}&to=${lastSunday}`)).json.reduce((a: number, p: Json) => a + p.commission, 0);
    ok(Math.abs(commission - paidCommission) < 0.01, `byCampaign commission ${commission} = payroll commission ${paidCommission}`);
    ok(snapped.json.byCampaign.every((c: Json) => Math.abs(c.margin - (c.revenue - c.commission)) < 0.01), 'margin = revenue − commission');
    return `12w revenue £${r.json.totals.revenue}, profit £${r.json.totals.profit}, on-time ${r.json.payroll.onTimeRate}, this week est. £${current.payroll}`;
  });
  await check('GET /finance/pay-plans, /finance/me', async () => {
    const plans = await rep.get('/finance/pay-plans');
    status(plans, 200, 'plans');
    eq(plans.json.length, 1, 'non-admins get only their own plan');
    eq(plans.json[0].id, (await rep.get('/auth/me')).json.user.payPlanId, 'own plan');
    eq((await admin.get('/finance/pay-plans')).json.length, 7, 'admin gets all seven plans');
    eq((await leader.get('/finance/pay-plans')).json.length, 1, 'leader: own plan only');
    const me = await rep.get('/finance/me?weeks=8');
    status(me, 200, 'me');
    ok(me.json.runs.length > 0 && me.json.runs.length <= 8, 'runs in window');
    ok(me.json.totals.gross > 0 && me.json.totals.commission > 0, 'totals');
    ok(me.json.totals.onTimeRate === null || me.json.totals.onTimeRate <= 1, 'onTimeRate');
    ok(typeof me.json.nextPayday === 'string', 'next payday');
    ok(me.json.nextPayAmount > 0, 'next pay amount');
    return `Jordan 8w gross £${me.json.totals.gross}, next payday ${me.json.nextPayday} £${me.json.nextPayAmount}`;
  });
  await check('GET/POST/DELETE /finance/expenses (admin only)', async () => {
    status(await rep.get('/finance/expenses'), 403, 'rep');
    status(await leader.get('/finance/expenses'), 403, 'leader');
    const r = await admin.get('/finance/expenses');
    status(r, 200, 'list');
    ok(r.json.length > 50, 'many expenses');
    const venue = await admin.get('/finance/expenses?category=venue&campaignId=1');
    ok(venue.json.length > 0 && venue.json.every((x: Json) => x.category === 'venue' && x.campaignId === 1), 'filters');
    const c = await admin.post('/finance/expenses', { date: today, category: 'marketing', amount: 120.5, description: 'Smoke leaflets' });
    status(c, 201, 'create');
    eq(c.json.amount, 120.5, 'amount');
    status(await admin.post('/finance/expenses', { date: today, category: 'nope', amount: 1, description: 'x' }), 400, 'bad category');
    status(await admin.del(`/finance/expenses/${c.json.id}`), 204, 'delete');
    status(await admin.del(`/finance/expenses/${c.json.id}`), 404, 'gone');
  });

  // ── recruitment ──
  let candidateId = 0;
  await check('GET /recruitment/candidates (roles, filters)', async () => {
    status(await rep.get('/recruitment/candidates'), 403, 'rep forbidden');
    const r = await recruiter.get('/recruitment/candidates');
    status(r, 200, 'list');
    ok(r.json.length > 80, 'many candidates');
    ok(r.json.every((c: Json, i: number, a: Json[]) => i === 0 || a[i - 1].stageUpdatedAt >= c.stageUpdatedAt), 'sorted by stageUpdatedAt desc');
    ok(r.json.every((c: Json) => typeof c.daysInPipeline === 'number' && 'ownerName' in c), 'meta shape');
    const open = await leader.get('/recruitment/candidates?open=true');
    ok(open.json.length > 5 && open.json.every((c: Json) => !['hired', 'rejected', 'withdrawn'].includes(c.stage)), 'open excludes terminal');
    const hired = await admin.get('/recruitment/candidates?stage=hired');
    ok(hired.json.length >= 8 && hired.json.every((c: Json) => c.hiredUserId !== null), 'hired linked to users');
    const src = await recruiter.get('/recruitment/candidates?source=indeed&ownerId=3');
    ok(src.json.length > 0 && src.json.every((c: Json) => c.source === 'indeed' && c.ownerId === 3), 'source+owner filter');
    const q = await recruiter.get(`/recruitment/candidates?q=${encodeURIComponent(hired.json[0].lastName)}`);
    ok(q.json.some((c: Json) => c.id === hired.json[0].id), 'q search');
    return `${r.json.length} candidates, ${open.json.length} open, ${hired.json.length} hired`;
  });
  await check('GET /recruitment/candidates/:id with history & interviews', async () => {
    const hired = (await recruiter.get('/recruitment/candidates?stage=hired')).json[0];
    const r = await recruiter.get(`/recruitment/candidates/${hired.id}`);
    status(r, 200, 'get');
    ok(r.json.history.length >= 6 && r.json.history[0].toStage === 'applied', 'full history');
    ok(r.json.history.every((h: Json, i: number, a: Json[]) => i === 0 || a[i - 1].changedAt <= h.changedAt), 'history chronological');
    ok(Array.isArray(r.json.interviews) && r.json.interviews.length > 0, 'interviews');
    status(await recruiter.get('/recruitment/candidates/999999'), 404, 'missing');
  });
  await check('POST /recruitment/candidates, PATCH, stage moves, hire creates user', async () => {
    const c = await recruiter.post('/recruitment/candidates', { firstName: 'Smoke', lastName: 'Tester', email: 'smoke.tester@example.com', source: 'referral', referredById: 10, city: 'Manchester' });
    status(c, 201, 'create');
    eq(c.json.stage, 'applied', 'stage applied');
    eq(c.json.ownerId, 3, 'owner defaults to me');
    eq(c.json.referredByName, 'Jordan Lee', 'referrer joined');
    candidateId = c.json.id;
    const detail = await recruiter.get(`/recruitment/candidates/${candidateId}`);
    eq(detail.json.history.length, 1, 'applied stage change recorded');
    status(await recruiter.post('/recruitment/candidates', { firstName: 'X' }), 400, 'validation');
    const p = await recruiter.patch(`/recruitment/candidates/${candidateId}`, { rating: 4, notes: 'Strong phone screen', nextAction: 'Book interview', nextActionAt: new Date().toISOString() });
    status(p, 200, 'patch');
    eq(p.json.rating, 4, 'rating');
    status(await recruiter.patch(`/recruitment/candidates/${candidateId}`, { stage: 'offer' }), 400, 'stage via PATCH rejected');
    const s1 = await leader.post(`/recruitment/candidates/${candidateId}/stage`, { stage: 'screening', note: 'Good call' });
    status(s1, 200, 'leader moves stage');
    eq(s1.json.stage, 'screening', 'stage screening');
    status(await leader.post(`/recruitment/candidates/${candidateId}/stage`, { stage: 'screening' }), 409, 'same stage');
    const hiredRes = await recruiter.post(`/recruitment/candidates/${candidateId}/stage`, { stage: 'hired' });
    status(hiredRes, 200, 'hire');
    ok(hiredRes.json.hiredUserId > 0, 'hiredUserId set');
    const u = await admin.get(`/users/${hiredRes.json.hiredUserId}`);
    status(u, 200, 'user created');
    eq(u.json.role, 'rep', 'role rep');
    eq(u.json.position, 'trainee', 'position from application');
    ok(/^LM-\d{4}$/.test(u.json.employeeId), 'employee id');
    eq(u.json.email, 'smoke.tester@linear-mcr.co.uk', 'company email');
    status(await recruiter.post(`/recruitment/candidates/${candidateId}/stage`, { stage: 'rejected' }), 409, 'hired is final');
    eq(u.json.teamId, null, 'recruiter-owned candidate without a team choice → no team');
    // hire with an explicit team and entry position; the pay plan is always the server default for the position
    const c2 = await recruiter.post('/recruitment/candidates', { firstName: 'Smoke', lastName: 'Placed', email: 'smoke.placed@example.com', positionApplied: 'team_leader' });
    status(c2, 201, 'second candidate');
    status(await recruiter.post(`/recruitment/candidates/${c2.json.id}/stage`, { stage: 'hired', position: 'owner', teamId: 2 }), 400, 'position restricted to trainee/field_rep');
    status(await recruiter.post(`/recruitment/candidates/${c2.json.id}/stage`, { stage: 'hired', teamId: 999 }), 400, 'unknown team');
    const h2 = await recruiter.post(`/recruitment/candidates/${c2.json.id}/stage`, { stage: 'hired', teamId: 2, position: 'field_rep', payPlanId: 6 });
    status(h2, 200, 'hire with team & position');
    const u2 = await admin.get(`/users/${h2.json.hiredUserId}`);
    eq(u2.json.teamId, 2, 'team from the body');
    eq(u2.json.position, 'field_rep', 'position from the body (not the team_leader application)');
    eq(u2.json.payPlanName, 'Field rep plan', 'pay plan chosen by the server, body payPlanId ignored');
    eq(u2.json.startDate, today, 'starts today');
    eq(u2.json.role, 'rep', 'role rep');
    return `hired → ${u.json.employeeId} ${u.json.email}; ${u2.json.employeeId} → Deansgate field rep`;
  });
  await check('GET/POST/PATCH /recruitment/interviews', async () => {
    const r = await recruiter.get('/recruitment/interviews');
    status(r, 200, 'list');
    ok(r.json.length > 0, 'upcoming interviews in default window');
    ok(r.json.every((i: Json) => 'interviewerName' in i), 'interviewer joined');
    const future = r.json.filter((i: Json) => i.scheduledAt > new Date().toISOString());
    ok(future.length > 0, 'some interviews scheduled ahead');
    const at = new Date(Date.now() + 3 * 86_400_000).toISOString();
    const c = await recruiter.post('/recruitment/interviews', { candidateId, type: 'first', scheduledAt: at, interviewerId: 2 });
    status(c, 201, 'create');
    eq(c.json.outcome, 'pending', 'default outcome');
    eq(c.json.interviewerName, 'Amelia Hart', 'interviewer name');
    const p = await recruiter.patch(`/recruitment/interviews/${c.json.id}`, { outcome: 'passed', notes: 'Great' });
    status(p, 200, 'patch');
    eq(p.json.outcome, 'passed', 'outcome');
    const byCand = await recruiter.get(`/recruitment/interviews?candidateId=${candidateId}`);
    eq(byCand.json.length, 1, 'candidate filter');
    status(await recruiter.post('/recruitment/interviews', { candidateId: 999999, type: 'phone', scheduledAt: at }), 404, 'unknown candidate');
    return `${future.length} upcoming`;
  });
  await check('GET /recruitment/summary', async () => {
    const r = await recruiter.get('/recruitment/summary');
    status(r, 200, 'summary');
    eq(r.json.funnel.length, 6, 'six funnel stages');
    eq(r.json.funnel[0].stage, 'applied', 'funnel starts at applied');
    ok(r.json.funnel[0].count >= r.json.funnel[1].count, 'funnel monotonic at top');
    ok(r.json.weekly.length >= 12 && r.json.weekly.every((w: Json) => dayOfWeek(w.weekStart) === 1), 'weekly Mondays');
    ok(r.json.bySource.length >= 5, 'sources');
    ok(r.json.hired > 0 && r.json.applied > r.json.hired, 'hired/applied');
    ok(r.json.avgTimeToHireDays > 0, 'time to hire');
    ok(typeof r.json.overdueActions === 'number', 'overdue');
    ok(Object.keys(r.json.openByStage).length === 8, 'openByStage has all stages');
    return `${r.json.applied} applied, ${r.json.hired} hired, ${r.json.avgTimeToHireDays}d to hire, ${r.json.overdueActions} overdue`;
  });

  // ── announcements & misc ──
  await check('GET/POST /announcements', async () => {
    const r = await rep.get('/announcements');
    status(r, 200, 'list');
    ok(r.json.length >= 5 && r.json[0].pinned === true, 'pinned first');
    ok(r.json.every((a: Json) => typeof a.authorName === 'string'), 'author joined');
    status(await rep.post('/announcements', { title: 'x', body: 'y' }), 403, 'rep forbidden');
    const c = await leader.post('/announcements', { title: 'Smoke notice', body: 'Hello team' });
    status(c, 201, 'leader creates');
    eq(c.json.authorName, 'Amelia Hart', 'author');
    eq(c.json.pinned, false, 'not pinned');
  });
  await check('404 JSON for unknown /api route (signed in and anonymous)', async () => {
    const r = await admin.get('/nope');
    status(r, 404, 'not found');
    eq(r.json.error, 'Not found', 'json body');
    const a = await anon.get('/nope/deeper');
    status(a, 404, 'anonymous unknown route');
    eq(a.json.error, 'Not found', 'anonymous json body');
    status(await anon.get('/auth/unknown'), 404, 'unknown auth sub-route');
  });
  await check('POST /auth/logout then 401', async () => {
    status(await rep.post('/auth/logout'), 204, 'logout');
    status(await rep.get('/auth/me'), 401, 'session gone');
  });

  server.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });

  const width = Math.max(...results.map((r) => r.name.length));
  console.log('');
  for (const r of results) {
    console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name.padEnd(width)}  ${r.detail}`);
  }
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed${failed ? `, ${failed} FAILED` : ''}`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
