/**
 * End-to-end smoke test: boots the API on a fresh, seeded temporary database, signs in as each demo
 * account and exercises every endpoint. Prints a PASS/FAIL table and exits non-zero on any failure.
 */
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { round2 } from '@lm/shared';
import { contentSecurityPolicy, createApp } from './app.ts';
import { missingAddressesMessage, missingLocalAddresses, requestVia } from './test/requestVia.ts';
import { all, get, openDb, run } from './db/connection.ts';
import { bumpDataVersion } from './lib/cache.ts';
import { materialisePayrollRuns } from './db/maintenance.ts';
import { getUser } from './db/queries.ts';
import { SCHEMA_SQL, createSchema, tableColumns } from './db/schema.ts';
import { seed } from './db/seed.ts';
import { AVATAR_PALETTE } from './db/seed-data.ts';
import { configureAppSecret, decrypt, encrypt } from './lib/crypto.ts';
import { addDays, dayOfWeek, mondayOf, businessNow, normaliseCheckIn, nowHHMM, previousToDateRange, setBusinessClock, startOfMonth, startOfQuarter, sundayOf, todayISO } from './lib/dates.ts';
import { nextPay, weekPayFor } from './lib/pay.ts';
import { totp, totpCounter } from './lib/totp.ts';
import { purgeExpiredChallenges, reencryptLegacySecrets, resetCodeFailures } from './lib/twofactor.ts';
import { resetLoginFailures } from './routes/auth.ts';
import { sessionKey } from './lib/sessionKey.ts';
import { issueSetupCode } from './lib/setupCodes.ts';

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
  private readonly base: string;
  readonly label: string;
  /** when set, requests are sent from this source address (see `requestVia`) */
  private readonly localAddress: string | undefined;

  constructor(base: string, label: string, localAddress?: string) {
    this.base = base;
    this.label = label;
    this.localAddress = localAddress;
  }

  async req(method: string, url: string, body?: unknown): Promise<{ status: number; json: Json; headers: Headers }> {
    const headers = { 'content-type': 'application/json', ...(this.cookie ? { cookie: this.cookie } : {}) };
    const payload = body === undefined ? undefined : JSON.stringify(body);
    let res: { status: number; headers: Headers; text: string };
    if (this.localAddress) res = await requestVia(this.localAddress, method, this.base + url, headers, payload);
    else {
      const r = await fetch(this.base + url, { method, headers, body: payload });
      res = { status: r.status, headers: r.headers, text: await r.text() };
    }
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) {
      const m = /lm_session=([^;]*)/.exec(setCookie);
      this.cookie = m && m[1] ? `lm_session=${m[1]}` : '';
    }
    const text = res.text;
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

/**
 * The checks assume a working afternoon: today's demo events have started and the week has gauges. Pin the business
 * clock to 15:00 London on the most recent weekday (Monday to Friday) so the run gives the same result at 00:30 on a
 * Monday or on a Sunday evening. SMOKE_REAL_CLOCK=1 runs against the real clock instead.
 */
function pinSmokeClock(): string | null {
  if (process.env.SMOKE_REAL_CLOCK === '1') return null;
  const d = new Date();
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() - 1);
  d.setHours(15, 0, 0, 0); // local time; the smoke script pins TZ=Europe/London
  setBusinessClock(d);
  return d.toString();
}

async function main(): Promise<void> {
  const pinned = pinSmokeClock();
  if (pinned) console.log(`Business clock pinned to ${pinned} (SMOKE_REAL_CLOCK=1 for the real clock)`);
  const dir = mkdtempSync(path.join(os.tmpdir(), 'linear-smoke-'));
  const secretFile = path.join(dir, 'app-secret');
  configureAppSecret(secretFile); // never touch server/data/app-secret from the smoke run
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
  /**
   * A real administrator of the office's own (not the demo company) with two-step on. During the trial the one-tap demo
   * administrator only works on the demo company (lib/demoWrites.ts), so the checks that change the office's own
   * people, a campaign's pay, or reset a sign-in use this owner; a real one needs a fresh code for the sensitive ones.
   */
  const owner = new Client(base, 'owner');
  let ownerId = 0;
  let ownerSecret = '';
  const ownerCode = (): string => {
    run(db, `UPDATE users SET totp_last_counter = NULL WHERE id = ?`, [ownerId]);
    return totp(ownerSecret);
  };
  const signInOwner = async (): Promise<void> => {
    if (ownerId) return;
    ownerId = Number(run(
      db,
      `INSERT INTO users (employee_id, email, first_name, last_name, role, position, team_id, pay_plan_id, start_date, status, phone, avatar_color, city)
       SELECT 'LM-0990', 'smoke.owner@linearhub.example', 'Smoke', 'Owner', 'admin', 'owner', NULL, pay_plan_id, ?, 'active', NULL, '#0E7490', NULL FROM users WHERE id = 1`,
      [todayISO()],
    ).lastInsertRowid);
    bumpDataVersion();
    const setupCode = issueSetupCode(db, ownerId, { createdBy: null, reason: 'command' }).code;
    status(await owner.post('/auth/login', { email: 'smoke.owner@linearhub.example', employeeId: 'LM-0990', setupCode }), 200, 'owner signs in with a setup code');
    const setup = await owner.post('/auth/2fa/setup');
    status(setup, 201, 'owner: two-step setup');
    status(await owner.post('/auth/2fa/enable', { code: totp(setup.json.secret) }), 200, 'owner: two-step on');
    ownerSecret = setup.json.secret;
  };

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
    eq(r.json.accounts[0].email, 'morgan.blake@linearhub.example', 'admin email');
    // Release 1.3.1: the Sapiens team's seven blank demo sign-ins, after the four
    eq(r.json.demoTeams?.[0]?.name, 'Sapiens', 'Sapiens group');
    eq(r.json.demoTeams[0].accounts.map((a: Json) => a.employeeId).join(','), 'LM-0101,LM-0102,LM-0103,LM-0104,LM-0105,LM-0106,LM-0107', 'the seven, in order');
    process.env.LM_DEMO_ACCOUNTS = '0';
    try {
      const off = await anon.get('/auth/demo-accounts');
      status(off, 200, 'demo off');
      eq(off.json.accounts.length, 0, 'LM_DEMO_ACCOUNTS=0 hides the accounts');
      eq(off.json.demoTeams, undefined, 'and the Sapiens group');
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
    status(await anon.post('/auth/login', { email: 'morgan.blake@linearhub.example', employeeId: 'LM-9999' }), 401, 'mismatch');
    status(await anon.post('/auth/login', { email: 'nobody@linearhub.example', employeeId: 'LM-0001' }), 401, 'unknown email');
  });
  await check('POST /auth/login rate limit: 8 failures per ip+email in 15 min, 9th → 429', async () => {
    const email = 'brute.force@linearhub.example';
    for (let i = 1; i <= 8; i++) status(await anon.post('/auth/login', { email, employeeId: `LM-9${String(i).padStart(3, '0')}` }), 401, `attempt ${i}`);
    const r = await anon.post('/auth/login', { email, employeeId: 'LM-9009' });
    status(r, 429, '9th attempt');
    ok(/^Too many attempts, try again in \d+ minutes?$/.test(r.json.error), `error text (${r.json.error})`);
    status(await anon.post('/auth/login', { email: 'JORDAN.LEE@linearhub.example', employeeId: 'LM-0010' }), 200, 'other email from the same IP unaffected');
    status(await anon.post('/auth/logout'), 204, 'logout');
  });
  await check('Session cookie: HttpOnly + Lax; Secure only on HTTPS or COOKIE_SECURE=1', async () => {
    const plain = new Client(base, 'cookie');
    const r = await plain.post('/auth/login', { email: 'jordan.lee@linearhub.example', employeeId: 'LM-0010' });
    status(r, 200, 'login');
    const sc = r.headers.get('set-cookie') ?? '';
    ok(/HttpOnly/i.test(sc) && /SameSite=Lax/i.test(sc) && !/;\s*Secure/i.test(sc), `plain http: HttpOnly, Lax, no Secure (${sc})`);
    process.env.COOKIE_SECURE = '1';
    try {
      const forced = await new Client(base, 'cookie2').post('/auth/login', { email: 'jordan.lee@linearhub.example', employeeId: 'LM-0010' });
      ok(/;\s*Secure/i.test(forced.headers.get('set-cookie') ?? ''), 'COOKIE_SECURE=1 → Secure');
    } finally {
      delete process.env.COOKIE_SECURE;
    }
    status(await plain.post('/auth/logout'), 204, 'logout');
  });
  await check('App secret: generated once into a 0600 file next to the DB, reused on restart, LM_APP_SECRET overrides, legacy rows re-encrypted', async () => {
    const previous = process.env.LM_APP_SECRET;
    delete process.env.LM_APP_SECRET;
    try {
      configureAppSecret(secretFile);
      const ct = encrypt('hello');
      ok(existsSync(secretFile), 'file created on first use');
      eq(statSync(secretFile).mode & 0o777, 0o600, 'mode 0600');
      ok(/^[0-9a-f]{64}$/.test(readFileSync(secretFile, 'utf8').trim()), '32 random bytes, hex');
      configureAppSecret(secretFile); // simulate a restart: the key is read back, not regenerated
      eq(decrypt(ct), 'hello', 'persisted key decrypts after a reload');
      process.env.LM_APP_SECRET = 'operator-managed-secret';
      let rejected = false;
      try { decrypt(ct); } catch { rejected = true; }
      ok(rejected, 'LM_APP_SECRET overrides the file (ciphertext under the file key no longer decrypts)');
      // a row written by a release that ran on the old built-in development key is re-encrypted at start-up
      process.env.LM_APP_SECRET = 'linear-hub-development-secret-not-for-production';
      const legacy = encrypt('JBSWY3DPEHPK3PXP');
      delete process.env.LM_APP_SECRET;
      configureAppSecret(secretFile);
      run(db, `UPDATE users SET totp_secret_enc = ? WHERE id = 10`, [legacy]);
      eq(reencryptLegacySecrets(db), 1, 'one legacy column rewritten');
      eq(decrypt(get<Json>(db, `SELECT totp_secret_enc AS s FROM users WHERE id = 10`)!.s), 'JBSWY3DPEHPK3PXP', 'now under the real key');
      eq(reencryptLegacySecrets(db), 0, 'idempotent');
      run(db, `UPDATE users SET totp_secret_enc = NULL WHERE id = 10`);
    } finally {
      if (previous === undefined) delete process.env.LM_APP_SECRET;
      else process.env.LM_APP_SECRET = previous;
      configureAppSecret(secretFile);
    }
  });
  await check('Security headers on every response; HSTS and Secure cookies only with TRUST_PROXY (off by default)', async () => {
    const r = await fetch(`${base}/health`);
    eq(r.headers.get('x-content-type-options'), 'nosniff', 'nosniff');
    eq(r.headers.get('x-frame-options'), 'DENY', 'frame options');
    eq(r.headers.get('referrer-policy'), 'strict-origin-when-cross-origin', 'referrer policy');
    eq(r.headers.get('permissions-policy'), 'camera=(), microphone=(), geolocation=()', 'permissions policy');
    const csp = r.headers.get('content-security-policy') ?? '';
    ok(csp.includes("default-src 'self'") && csp.includes("frame-ancestors 'none'") && csp.includes("connect-src 'self'"), `CSP (${csp})`);
    eq(r.headers.get('strict-transport-security'), null, 'no HSTS over plain HTTP');
    const dist = path.resolve(import.meta.dirname, '../../client/dist');
    if (existsSync(path.join(dist, 'index.html'))) ok(/'sha256-[A-Za-z0-9+/=]+'/.test(contentSecurityPolicy(dist)), 'built client: inline theme script hashed into script-src');
    // the default app ignores X-Forwarded-*: a forged "https" never yields a Secure cookie or HSTS
    const creds = { email: 'jordan.lee@linearhub.example', employeeId: 'LM-0010' };
    const spoof = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-proto': 'https' }, body: JSON.stringify(creds) });
    eq(spoof.status, 200, 'login');
    ok(!/;\s*Secure/i.test(spoof.headers.get('set-cookie') ?? '') && spoof.headers.get('strict-transport-security') === null, 'X-Forwarded-Proto ignored by default');
    // with TRUST_PROXY=1 the terminator's X-Forwarded-Proto is honoured → Secure cookie + HSTS
    const proxied = createApp(db, { trustProxy: 1 }).listen(0);
    await once(proxied, 'listening');
    try {
      const pbase = `http://127.0.0.1:${(proxied.address() as AddressInfo).port}/api`;
      const trusted = await fetch(`${pbase}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-proto': 'https' }, body: JSON.stringify(creds) });
      eq(trusted.status, 200, 'login via trusted proxy');
      ok(/;\s*Secure/i.test(trusted.headers.get('set-cookie') ?? ''), 'Secure cookie behind a trusted proxy');
      ok((trusted.headers.get('strict-transport-security') ?? '').startsWith('max-age='), 'HSTS behind a trusted proxy');
    } finally {
      proxied.close();
    }
    run(db, `DELETE FROM sessions WHERE user_id = 10`);
  });
  await check('Login limiter keys on the socket address (X-Forwarded-For cannot bypass it) plus a per-email ceiling across addresses', async () => {
    resetLoginFailures();
    const email = 'spoof.me@linearhub.example';
    const attempt = (i: number, localAddress?: string) => {
      const headers = { 'content-type': 'application/json', 'x-forwarded-for': `203.0.113.${i}` };
      const payload = JSON.stringify({ email, employeeId: `LM-9${String(i).padStart(3, '0')}` });
      return localAddress ? requestVia(localAddress, 'POST', `${base}/auth/login`, headers, payload) : fetch(`${base}/auth/login`, { method: 'POST', headers, body: payload });
    };
    for (let i = 1; i <= 8; i++) eq((await attempt(i)).status, 401, `attempt ${i} with a rotating X-Forwarded-For`);
    eq((await attempt(9)).status, 429, '9th → 429 despite a fresh X-Forwarded-For (the limiter keys on the TCP peer)');
    // a second source address (a connection bound to 127.0.0.2) starts with a clean per-source counter (8) …
    for (let i = 9; i <= 16; i++) eq((await attempt(i, '127.0.0.2')).status, 401, `attempt ${i} from a second address`);
    eq((await attempt(17, '127.0.0.2')).status, 429, 'the second address locks itself out after its own 8');
    // … and a third address gets only 4 more: the email as a whole is capped at 20 failures from anywhere
    for (let i = 17; i <= 20; i++) eq((await attempt(i, '127.0.0.3')).status, 401, `attempt ${i} from a third address`);
    const capped = await attempt(21, '127.0.0.3');
    eq(capped.status, 429, '21st failure for the email → 429 from any address (per-email ceiling)');
    const otherEmail = await requestVia('127.0.0.3', 'POST', `${base}/auth/login`, { 'content-type': 'application/json' }, JSON.stringify({ email: 'jordan.lee@linearhub.example', employeeId: 'LM-0010' }));
    eq(otherEmail.status, 200, 'other emails from that address unaffected');
    run(db, `DELETE FROM sessions WHERE user_id = 10`);
    resetLoginFailures();
  });
  const logins: [Client, string, string, string][] = [
    [admin, 'MORGAN.BLAKE@linearhub.example', 'lm-0001', 'admin'],
    [leader, 'amelia.hart@linearhub.example', 'LM-0002', 'leader'],
    [recruiter, 'priya.shah@linearhub.example', 'LM-0003', 'recruiter'],
    [rep, 'jordan.lee@linearhub.example', 'LM-0010', 'rep'],
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
    // Release 1.3 (P1): Mon–Fri at the £63.50 day rate; no gauges, so no commission and the base applies
    ok(fm.json.runs.length > 0 && fm.json.runs.every((p: Json) => p.daysWorked === 5 && p.basePay === 317.5 && p.commission === 0 && p.paidAs === 'base'), 'Mon–Fri × £63.50, paid the base');
    ok(fm.json.runs.every((p: Json) => p.bonus === 0 && p.overrides === 0), 'no automatic bonus on hires and no overrides from 1.3 ("sales" = hires)');
    return `${fm.json.runs.length} runs, ${fm.json.runs.reduce((a: number, p: Json) => a + p.sales, 0)} hires`;
  });
  await check('Seed realism: venues, B2B weekdays, one site per person per day, offers ≤ 21d, interviews, palette, live timing', async () => {
    eq(get<Json>(db, `SELECT COUNT(*) AS n FROM (SELECT date, venue FROM events WHERE status <> 'cancelled' GROUP BY date, venue HAVING COUNT(*) > 1)`)!.n, 0, 'no two crews at one venue on the same day');
    eq(get<Json>(db, `SELECT COUNT(*) AS n FROM events WHERE type = 'b2b' AND strftime('%w', date) IN ('0', '6')`)!.n, 0, 'B2B events are Mon–Fri');
    eq(get<Json>(db, `SELECT COUNT(*) AS n FROM (SELECT user_id, date FROM gauge_entries GROUP BY user_id, date HAVING COUNT(*) > 1)`)!.n, 0, 'nobody is logged at two events on one day');
    eq(get<Json>(db, `SELECT COUNT(*) AS n FROM candidates WHERE stage = 'offer' AND stage_updated_at < ?`, [new Date(businessNow().getTime() - 21 * 86_400_000).toISOString()])!.n, 0, 'no offer older than 21 days');
    eq(get<Json>(db, `SELECT COUNT(*) AS n FROM interviews i JOIN candidates c ON c.id = i.candidate_id WHERE i.outcome = 'pending' AND c.stage IN ('hired', 'rejected', 'withdrawn')`)!.n, 0, 'no pending interviews for closed candidates');
    eq(get<Json>(db, `SELECT COUNT(*) AS n FROM interviews WHERE outcome = 'pending' AND scheduled_at < ?`, [businessNow().toISOString()])!.n, 0, 'pending interviews are in the future');
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
  await check('POST/PATCH /users (reps never; leaders add to their own team; PATCH admin only; 409 on duplicates)', async () => {
    status(await rep.post('/users', {}), 403, 'rep forbidden');
    // Release 1.3.1: a leader adds a trainee to their own team; the employee ID shows once, then is hidden again
    const added = await leader.post('/users', { firstName: 'Smoke', lastName: 'Trainee', email: 'smoke.trainee@linearhub.example', position: 'trainee' });
    status(added, 201, 'leader adds a trainee');
    eq(added.json.teamName, 'Northern Lights', "the leader's own team");
    ok(/^LM-\d{4}$/.test(added.json.employeeId), 'employee ID in the answer');
    eq((await leader.get(`/users/${added.json.id}`)).json.employeeId, '', 'hidden on every later read');
    status(await leader.post('/users', { firstName: 'Smoke', lastName: 'Other', email: 'smoke.other@linearhub.example', position: 'trainee', teamId: 2 }), 403, 'not another team');
    status(await leader.patch(`/users/${added.json.id}`, { city: 'Bury' }), 403, 'PATCH stays admin only');
    const body = {
      employeeId: 'LM-0900', email: 'test.user@linearhub.example', firstName: 'Test', lastName: 'User', role: 'rep', position: 'trainee',
      teamId: 2, startDate: today, status: 'active', phone: null, city: 'Manchester',
    };
    const r = await admin.post('/users', body);
    status(r, 201, 'create');
    eq(r.json.teamName, 'Deansgate', 'team joined');
    ok(/^#[0-9A-Fa-f]{6}$/.test(r.json.avatarColor), 'avatar colour assigned');
    newUserId = r.json.id;
    status(await admin.post('/users', body), 409, 'duplicate');
    status(await admin.post('/users', { ...body, employeeId: 'LM-0901', email: 'not-an-email' }), 400, 'validation');
    // someone the demo admin added is one of the office's own: only a real administrator changes them afterwards
    status(await admin.patch(`/users/${newUserId}`, { city: 'Salford' }), 403, 'the demo admin cannot change them');
    await signInOwner();
    const p = await owner.patch(`/users/${newUserId}`, { position: 'field_rep', city: 'Salford' });
    status(p, 200, 'patch');
    eq(p.json.position, 'field_rep', 'patched position');
    status(await admin.patch('/users/99999', { city: 'X' }), 404, 'patch missing');
  });
  await check('FunnelRatios.stopsPerSale is null (never Infinity) without sales and a number otherwise', async () => {
    const perf = await admin.get(`/users/${newUserId}/performance`);
    status(perf, 200, 'performance of a user with no gauges');
    ok('stopsPerSale' in perf.json.ratios, 'key present in JSON');
    eq(perf.json.ratios.stopsPerSale, null, 'null without sales');
    const withSales = await rep.get(`/users/10/performance?from=${twelveWeeksAgo}&to=${today}`);
    ok(typeof withSales.json.ratios.stopsPerSale === 'number' && withSales.json.ratios.stopsPerSale > 0, 'a number with sales');
    const rows = (await admin.get(`/gauges/summary?groupBy=user&from=${twelveWeeksAgo}&to=${today}`)).json;
    ok(rows.every((r: Json) => (r.ratios.stopsPerSale === null ? r.sales === 0 : r.sales > 0 && typeof r.ratios.stopsPerSale === 'number')), 'summary rows: null exactly when sales = 0');
  });
  await check('PATCH status=left revokes sessions; admins cannot deactivate themselves', async () => {
    const body = {
      employeeId: 'LM-0910', email: 'smoke.leaver@linearhub.example', firstName: 'Smoke', lastName: 'Leaver', role: 'rep', position: 'trainee',
      teamId: 1, startDate: today, status: 'active', phone: null, city: 'Manchester',
    };
    const created = await admin.post('/users', body);
    status(created, 201, 'create');
    leaverId = created.json.id;
    const leaver = new Client(base, 'leaver');
    ok(typeof created.json.setupCode === 'string', 'a one-time setup code for the new account');
    status(await leaver.post('/auth/login', { email: body.email, employeeId: body.employeeId, setupCode: created.json.setupCode }), 200, 'login');
    status(await leaver.get('/auth/me'), 200, 'session works while active');
    await signInOwner();
    status(await owner.patch(`/users/${leaverId}`, { status: 'left' }), 200, 'patch left');
    eq(get<Json>(db, `SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?`, [leaverId])!.n, 0, 'sessions deleted on deactivation');
    status(await leaver.get('/auth/me'), 401, 'existing session rejected');
    status(await leaver.get('/me/dashboard'), 401, 'dashboard rejected');
    status(await leaver.post('/auth/login', { email: body.email, employeeId: body.employeeId }), 401, 'login rejected');
    // a session that survived the delete is still rejected (and removed) by authenticate
    run(db, `INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`, [sessionKey('stale-left-token'), leaverId, new Date().toISOString(), new Date(Date.now() + 86_400_000).toISOString()]);
    const stale = await fetch(`${base}/auth/me`, { headers: { cookie: 'lm_session=stale-left-token' } });
    eq(stale.status, 401, 'stale session of a left user is rejected');
    eq(get<Json>(db, `SELECT COUNT(*) AS n FROM sessions WHERE token = ?`, [sessionKey('stale-left-token')])!.n, 0, 'and deleted');
    const self = await admin.patch('/users/1', { status: 'left' });
    status(self, 400, 'admin cannot deactivate themselves');
    eq((await admin.get('/users/1')).json.status, 'active', 'admin still active');
    status(await admin.get('/auth/me'), 200, 'admin session intact');
  });
  await check('Login answers one 401 message for an unknown email, a wrong ID and a deactivated account', async () => {
    const unknown = await anon.post('/auth/login', { email: 'nobody.here@linearhub.example', employeeId: 'LM-0910' });
    const wrong = await anon.post('/auth/login', { email: 'smoke.leaver@linearhub.example', employeeId: 'LM-9999' });
    const left = await anon.post('/auth/login', { email: 'smoke.leaver@linearhub.example', employeeId: 'LM-0910' });
    for (const [what, r] of [['unknown', unknown], ['wrong id', wrong], ['deactivated', left]] as const) {
      status(r, 401, what);
      eq(r.json.error, 'Invalid email or employee ID', `${what} message`);
    }
    resetLoginFailures();
  });
  await check('GET /teams', async () => {
    const r = await rep.get('/teams');
    status(r, 200, 'teams');
    // the four demo teams and Sapiens (the example starter team: seven blank accounts, Ava leads)
    eq(r.json.length, 5, 'four teams and Sapiens');
    const nl = r.json.find((t: Json) => t.name === 'Northern Lights');
    eq(nl.leaderName, 'Amelia Hart', 'leader name');
    ok(nl.memberCount >= 5, 'member count');
    const sapiens = r.json.find((t: Json) => t.name === 'Sapiens');
    eq(sapiens?.leaderName, 'Ava', 'Sapiens leader, no trailing space');
    eq(sapiens?.memberCount, 7, 'seven Sapiens accounts');
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
    // "future" must mean after today: before the first start time of the day, today's events are still `scheduled`
    futureNlEvent = f.json.find((e: Json) => e.date > today) ?? f.json[0];
    const repList = await rep.get(`/events?from=${weekAgo}&to=${addDays(today, 21)}&teamId=2`);
    ok(repList.json.length > 0 && repList.json.every((e: Json) => e.teamId === 1), 'rep only sees own team');
    const todays = await admin.get(`/events?from=${today}&to=${today}`);
    // the seed schedules events Monday to Saturday only (Sunday is the gauges deadline, not an event day)
    ok(todays.json.length > 0 || dayOfWeek(today) === 0, 'events today (none on Sundays)');
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
    // 00:01 so that on a Monday today's fixture has always started (gauges are refused before an event's start time)
    const fixture = { campaignId: 1, teamId: 1, name: 'Smoke completed stand', venue: 'Arndale', city: 'Manchester', type: 'retail', date, startTime: '00:01', endTime: '23:59', targetSales: 12, notes: null };
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
  await check('GET /gauges strips other teams\' check-ins and notes (leader/recruiter), pages with offset and reports X-Total-Count', async () => {
    const range = `from=${twelveWeeksAgo}&to=${today}`;
    const stripped = (rows: Json[]) => rows.length > 0 && rows.every((g: Json) => g.checkedInAt === null && g.notes === null);
    const foreign = await leader.get(`/gauges?teamId=2&${range}&limit=100`);
    status(foreign, 200, 'leader reads team 2');
    ok(stripped(foreign.json), "leader: other team's check-ins and notes are null");
    const own = await leader.get(`/gauges?teamId=1&${range}&limit=100`);
    ok(own.json.some((g: Json) => g.checkedInAt !== null || g.notes !== null), "leader: own team's details visible");
    const recr = await recruiter.get(`/gauges?${range}&limit=100`);
    ok(stripped(recr.json), 'recruiter: every entry stripped');
    const adm = await admin.get(`/gauges?teamId=2&${range}&limit=100`);
    ok(adm.json.some((g: Json) => g.checkedInAt !== null), 'admin sees everything');
    const total = Number(adm.headers.get('x-total-count'));
    ok(total >= adm.json.length && total > 100, `X-Total-Count (${total}) counts beyond the page`);
    eq(total, get<Json>(db, `SELECT COUNT(*) AS n FROM gauge_entries g JOIN users u ON u.id = g.user_id WHERE u.team_id = 2 AND g.date BETWEEN ? AND ?`, [twelveWeeksAgo, today])!.n, 'X-Total-Count = matching rows');
    const page1 = await admin.get(`/gauges?teamId=2&${range}&limit=5&offset=0`);
    const page2 = await admin.get(`/gauges?teamId=2&${range}&limit=5&offset=5`);
    eq(page1.json.length, 5, 'page 1');
    eq(page2.json.length, 5, 'page 2');
    ok(page1.json.every((g: Json) => !page2.json.some((h: Json) => h.id === g.id)), 'pages are disjoint');
    eq(Number(page2.headers.get('x-total-count')), total, 'total is the same on every page');
    const last = await admin.get(`/gauges?teamId=2&${range}&limit=5&offset=${total - 2}`);
    eq(last.json.length, 2, 'final partial page');
    status(await admin.get(`/gauges?${range}&offset=-1`), 400, 'negative offset');
    status(await admin.get(`/gauges?${range}&offset=abc`), 400, 'non-numeric offset');
    return `${total} team-2 rows in 12 weeks`;
  });
  await check('POST /gauges upsert (201 then 200), invalid funnel 400', async () => {
    ok(pastNlEvent, 'need a completed Northern Lights event');
    // a zoned check-in two minutes after the (00:01) start, expressed as the UTC instant of that local time
    const body = { eventId: pastNlEvent.id, userId: 10, date: pastNlEvent.date, stops: 60, table: 20, presentations: 10, closes: 4, taps: 3, sales: 2, checkedInAt: new Date(`${pastNlEvent.date}T00:03:00`).toISOString(), notes: 'smoke' };
    const r1 = await rep.post('/gauges', body);
    status(r1, 201, 'create');
    eq(r1.json.sales, 2, 'sales');
    eq(r1.json.userName, 'Jordan Lee', 'user meta');
    ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(r1.json.checkedInAt), 'zoned check-in stored as naive local time');
    const naive = await rep.post('/gauges', { ...body, checkedInAt: `${pastNlEvent.date}T00:03` });
    eq(naive.json.checkedInAt, `${pastNlEvent.date}T00:03:00`, 'naive check-in kept verbatim (seconds padded)');
    gaugeId = r1.json.id;
    // omitted keys keep the stored values, explicit nulls clear them
    const { checkedInAt: _ci, notes: _no, ...numbersOnly } = body;
    const kept = await rep.post('/gauges', numbersOnly);
    status(kept, 200, 'omitted');
    eq(kept.json.notes, 'smoke', 'omitted notes kept');
    eq(kept.json.checkedInAt, `${pastNlEvent.date}T00:03:00`, 'omitted check-in kept');
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
  await check('Gauge counts are strict whole numbers 0..2000 (no coercion, no 1e308); targets ≤ 500; money amounts > 0 and ≤ 1,000,000', async () => {
    const body = { eventId: pastNlEvent.id, userId: 10, date: pastNlEvent.date, stops: 60, table: 20, presentations: 10, closes: 4, taps: 3, sales: 2 };
    status(await rep.post('/gauges', { ...body, stops: 2001 }), 400, 'stops above the daily ceiling');
    status(await rep.post('/gauges', { ...body, stops: 1e308, table: 1e308, presentations: 1e308, closes: 1e308, taps: 1e308, sales: 1e308 }), 400, '1e308');
    status(await rep.post('/gauges', { ...body, stops: 1e12 }), 400, '1e12');
    status(await rep.post('/gauges', { ...body, stops: true }), 400, 'boolean is not coerced to 1');
    status(await rep.post('/gauges', { ...body, table: null }), 400, 'null is not coerced to 0');
    status(await rep.post('/gauges', { ...body, stops: '60' }), 400, 'numeric string is not coerced');
    status(await rep.post('/gauges', { ...body, stops: 60.5 }), 400, 'non-integer');
    const raw = await fetch(`${base}/gauges`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: (rep as unknown as { cookie: string }).cookie }, body: `{"eventId":${body.eventId},"userId":10,"date":"${body.date}","stops":1e999,"table":0,"presentations":0,"closes":0,"taps":0,"sales":0}` });
    eq(raw.status, 400, 'JSON 1e999 (Infinity) rejected as non-finite');
    const max = await rep.post('/gauges', { ...body, stops: 2000, table: 2000, presentations: 2000, closes: 2000, taps: 2000, sales: 2000 });
    status(max, 200, '2000 everywhere is accepted');
    status(await rep.post('/gauges', body), 200, 'restored');
    const ev = { campaignId: 1, teamId: 1, name: 'Target', venue: 'X', city: 'Manchester', type: 'retail', date: addDays(today, 5), startTime: '10:00', endTime: '18:00', notes: null };
    status(await admin.post('/events', { ...ev, targetSales: 501 }), 400, 'targetSales above 500');
    status(await admin.post('/events', { ...ev, targetSales: '12' }), 400, 'targetSales must be a number');
    status(await admin.post('/finance/expenses', { date: today, category: 'other', amount: 1e308, description: 'x' }), 400, 'expense 1e308');
    status(await admin.post('/finance/expenses', { date: today, category: 'other', amount: 1_000_001, description: 'x' }), 400, 'expense above £1,000,000');
    status(await admin.post('/finance/expenses', { date: today, category: 'other', amount: 0, description: 'x' }), 400, 'expense of £0');
    status(await admin.post('/finance/expenses', { date: today, category: 'other', amount: -5, description: 'x' }), 400, 'negative expense');
    const okExp = await admin.post('/finance/expenses', { date: today, category: 'other', amount: 1_000_000, description: 'Smoke ceiling' });
    status(okExp, 201, '£1,000,000 accepted');
    status(await admin.del(`/finance/expenses/${okExp.json.id}`), 204, 'cleanup');
    // a campaign's pay per sale is real pay: the demo admin may not change it, a real administrator may
    status(await admin.patch('/campaigns/1', { payoutPerSale: 125 }), 403, 'the demo admin cannot change pay per sale');
    await signInOwner();
    status(await owner.patch('/campaigns/1', { payoutPerSale: 0 }), 400, 'campaign payout must be > 0');
    status(await owner.patch('/campaigns/1', { payoutPerSale: 2_000_000 }), 400, 'campaign payout above the ceiling');
    status(await owner.patch('/campaigns/1', { repCommissionPerSale: -1 }), 400, 'negative commission');
    eq((await admin.get('/campaigns')).json.find((c: Json) => c.id === 1).payoutPerSale, 120, 'campaign untouched');
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
    await signInOwner();
    status(await owner.post('/gauges', { ...body, userId: leaverId }), 400, 'inactive (left) user');
    const otherTeam = (await admin.get(`/events?teamId=2&status=completed&from=${twelveWeeksAgo}&to=${today}`)).json[0];
    ok(otherTeam, 'need a completed team-2 event');
    status(await leader.post('/gauges', { ...body, userId: 2, eventId: otherTeam.id, date: otherTeam.date }), 403, "leader cannot log at another team's event");
    status(await leader.post('/gauges', { ...body, userId: 9, eventId: otherTeam.id, date: otherTeam.date }), 403, "leader cannot log a member at another team's event");
    status(await rep.patch(`/gauges/${gaugeId}`, { date: addDays(pastNlEvent.date, -1) }), 400, 'PATCH cannot move the date off the event');
    status(await rep.patch(`/gauges/${gaugeId}`, { eventId: futureNlEvent.id, date: futureNlEvent.date }), 400, 'PATCH cannot move the entry to a future event');
  });
  await check("Today's event accepts gauges only once its start time has passed; a check-in can never be in the future", async () => {
    const late = await admin.post('/events', { campaignId: 1, teamId: 1, name: 'Smoke late stand', venue: 'Late Hall', city: 'Manchester', type: 'retail', date: today, startTime: '23:58', endTime: '23:59', targetSales: 1, notes: null });
    status(late, 201, 'event today starting 23:58');
    const body = { eventId: late.json.id, userId: 10, date: today, stops: 1, table: 0, presentations: 0, closes: 0, taps: 0, sales: 0 };
    if (nowHHMM() < '23:58') {
      eq(late.json.status, 'scheduled', 'not started yet');
      const early = await rep.post('/gauges', body);
      status(early, 400, 'gauges before the start time');
      ok(/once the event has started/.test(early.json.error), `message (${early.json.error})`);
      status(await admin.post('/gauges', body), 400, 'admin too');
    }
    status(await admin.del(`/events/${late.json.id}`), 204, 'cleanup (no entries)');
    const tomorrow = new Date(businessNow().getTime() + 86_400_000).toISOString();
    const future = await rep.post('/gauges', { eventId: pastNlEvent.id, userId: 10, date: pastNlEvent.date, stops: 30, table: 10, presentations: 5, closes: 2, taps: 1, sales: 1, checkedInAt: tomorrow });
    status(future, 400, 'check-in in the future');
    eq(future.json.error, 'Check-in time cannot be in the future', 'message');
    status(await rep.patch(`/gauges/${gaugeId}`, { checkedInAt: `${addDays(today, 1)}T09:00` }), 400, 'PATCH with a future check-in');
    status(await rep.patch(`/gauges/${gaugeId}`, { checkedInAt: `${pastNlEvent.date}T00:05` }), 200, 'a past check-in is fine');
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
  await check('Events with recorded gauges: date/team/campaign frozen (409), delete refused (409); status follows a new date', async () => {
    ok(get<Json>(db, `SELECT COUNT(*) AS n FROM gauge_entries WHERE event_id = ?`, [pastNlEvent.id])!.n > 0, 'fixture still has an entry (the leader\'s)');
    const moved = await admin.patch(`/events/${pastNlEvent.id}`, { date: addDays(pastNlEvent.date, -1) });
    status(moved, 409, 'date frozen');
    ok(/recorded gauges/.test(moved.json.error), `message (${moved.json.error})`);
    status(await admin.patch(`/events/${pastNlEvent.id}`, { teamId: 2 }), 409, 'team frozen');
    status(await admin.patch(`/events/${pastNlEvent.id}`, { campaignId: 2 }), 409, 'campaign frozen');
    status(await admin.patch(`/events/${pastNlEvent.id}`, { date: pastNlEvent.date, name: 'Smoke completed stand (renamed)' }), 200, 'same date + other fields still editable');
    const del = await admin.del(`/events/${pastNlEvent.id}`);
    status(del, 409, 'delete refused');
    ok(/cancelled instead/.test(del.json.error), `message (${del.json.error})`);
    eq(get<Json>(db, `SELECT COUNT(*) AS n FROM gauge_entries WHERE event_id = ?`, [pastNlEvent.id])!.n, 1, 'entries intact');
    // an entry-less event: the status follows the date / start time unless it is cancelled
    const e = await admin.post('/events', { campaignId: 1, teamId: 1, name: 'Smoke moving stand', venue: 'Y', city: 'Manchester', type: 'retail', date: addDays(today, 3), startTime: '10:00', endTime: '18:00', targetSales: 5, notes: null });
    status(e, 201, 'scheduled event');
    eq(e.json.status, 'scheduled', 'scheduled');
    eq((await admin.patch(`/events/${e.json.id}`, { date: addDays(today, -10) })).json.status, 'completed', 'moved into the past → completed');
    eq((await admin.patch(`/events/${e.json.id}`, { date: today, startTime: '00:01', endTime: '23:59' })).json.status, 'live', 'moved to today after its start → live');
    eq((await admin.patch(`/events/${e.json.id}`, { date: addDays(today, 4) })).json.status, 'scheduled', 'moved ahead → scheduled');
    eq((await admin.patch(`/events/${e.json.id}`, { status: 'cancelled' })).json.status, 'cancelled', 'cancel');
    eq((await admin.patch(`/events/${e.json.id}`, { date: addDays(today, -2) })).json.status, 'cancelled', 'a cancelled event stays cancelled when moved');
    status(await admin.del(`/events/${e.json.id}`), 204, 'entry-less event deletes');
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
  await check('Aggregate response cache: MISS then HIT per user, headers replayed, any write invalidates', async () => {
    const a = await leader.get('/me/dashboard?range=month');
    eq(a.headers.get('x-cache'), 'MISS', 'first read is a miss');
    const b = await leader.get('/me/dashboard?range=month');
    eq(b.headers.get('x-cache'), 'HIT', 'second read is a hit');
    eq(JSON.stringify(b.json), JSON.stringify(a.json), 'identical body');
    eq((await rep.get('/me/dashboard?range=month')).headers.get('x-cache'), 'MISS', 'another user never sees the cached view');
    const lb1 = await admin.get('/leaderboard?period=week');
    const lb2 = await admin.get('/leaderboard?period=week');
    eq(lb2.headers.get('x-cache'), 'HIT', 'leaderboard cached');
    eq(lb2.headers.get('x-total-count'), lb1.headers.get('x-total-count'), 'X-Total-Count replayed on a hit');
    status(await leader.post('/announcements', { title: 'Cache buster', body: 'Any write invalidates' }), 201, 'a write');
    eq((await leader.get('/me/dashboard?range=month')).headers.get('x-cache'), 'MISS', 'invalidated by the write');
    eq((await rep.get('/finance/payroll')).headers.get('x-cache'), null, 'non-aggregate endpoints are not cached');
    status(await rep.get('/me/dashboard?range=year'), 400, 'errors pass through');
    eq((await rep.get('/me/dashboard?range=year')).headers.get('x-cache'), 'MISS', 'errors are never cached');
  });
  await check('Smart 1.1 GETs: /me/insights, /me/attention, /me/digest (all roles, MISS then HIT), /events/forecast (admin/leader 200, rep/recruiter 403)', async () => {
    const roles: [Client, string][] = [[admin, 'admin'], [leader, 'leader'], [recruiter, 'recruiter'], [rep, 'rep']];
    for (const path of ['/me/insights', '/me/attention', '/me/digest']) {
      for (const [c, role] of roles) {
        const first = await c.get(path);
        status(first, 200, `${path} as ${role}`);
        eq(first.headers.get('x-cache'), 'MISS', `${path} as ${role}: first read`);
        const second = await c.get(path);
        eq(second.headers.get('x-cache'), 'HIT', `${path} as ${role}: second read`);
        eq(JSON.stringify(second.json), JSON.stringify(first.json), `${path} as ${role}: same body`);
      }
    }
    for (const [c, role] of roles) {
      const insights = (await c.get('/me/insights')).json;
      ok(Array.isArray(insights.boardStreaks) && 'personal' in insights, `insights shape (${role})`);
      if (role === 'rep' || role === 'recruiter') ok(insights.team === null && insights.company === null, `${role}: no check-in lists`);
      ok(Array.isArray((await c.get('/me/attention')).json.items), `attention items (${role})`);
    }
    ok(Array.isArray((await leader.get('/me/insights')).json.team?.checkIns), 'leader: team.checkIns');
    ok(Array.isArray((await admin.get('/me/insights')).json.company?.checkIns), 'admin: company.checkIns');
    const campaignId = (await admin.get('/campaigns')).json[0].id;
    const teamId = (await leader.get('/auth/me')).json.user.teamId;
    const q = `/events/forecast?campaignId=${campaignId}&teamId=${teamId}&type=private_site&targetSales=12`;
    for (const [c, role] of roles) {
      const r = await c.get(q);
      status(r, role === 'admin' || role === 'leader' ? 200 : 403, `/events/forecast as ${role}`);
      if (r.status === 200) ok('forecast' in r.json, `forecast key (${role})`);
    }
    status(await rep.get(`/me/digest?week=${today}`), 400, 'digest of the unfinished week');
    return `insights · attention · digest cached for 4 roles; forecast 200/200/403/403`;
  });

  // ── payroll materialisation & next pay (direct calls against the same database) ──
  const lastCompletedMonday = addDays(monday, -7);
  const RUN_COLUMNS = `user_id AS userId, days_worked AS daysWorked, sales, team_sales AS teamSales, due_date AS dueDate, status, reference,
    paid_as AS paidAs, sales_logged AS salesLogged, sales_confirmed AS salesConfirmed, sales_cancelled AS salesCancelled, adjustments_total AS adjustmentsTotal`;
  await check('materialisePayrollRuns rebuilds a completed week by the seed rules (via GET /finance/payroll guard)', async () => {
    const seeded = all<Json>(db, `SELECT ${RUN_COLUMNS}, gross + deductions AS gross FROM payroll_runs WHERE week_start = ? ORDER BY user_id`, [lastCompletedMonday]);
    ok(seeded.length > 20, 'seed has runs for the last completed week');
    ok(seeded.every((r: Json) => r.teamSales === 0 && (r.paidAs === 'base' || r.paidAs === 'commission')), 'every run by the 1.3 rule: paid as base or commission, no overrides');
    ok(seeded.some((r: Json) => r.paidAs === 'commission') && seeded.some((r: Json) => r.paidAs === 'base'), 'both base and commission weeks');
    run(db, `DELETE FROM payroll_runs WHERE week_start = ?`, [lastCompletedMonday]);
    const early = materialisePayrollRuns(db, addDays(lastCompletedMonday, 6));
    eq(early.created + early.updated + early.deleted, 0, 'nothing is created while the week is still in progress');
    const r = await admin.get(`/finance/payroll?from=${lastCompletedMonday}&to=${lastCompletedMonday}`);
    status(r, 200, 'list');
    eq(r.json.length, seeded.length, 'GET /finance/payroll materialised the missing week');
    ok(r.json.every((p: Json) => p.status === 'pending' && p.paidDate === null), 'new runs are pending');
    const rebuilt = all<Json>(db, `SELECT ${RUN_COLUMNS}, gross FROM payroll_runs WHERE week_start = ? ORDER BY user_id`, [lastCompletedMonday]);
    eq(JSON.stringify(rebuilt), JSON.stringify(seeded), 'same users, days, sales, team sales, gross (before deductions), due date, status, reference, paid as, subs and corrections');
    const again = materialisePayrollRuns(db);
    eq(JSON.stringify(again), JSON.stringify({ created: 0, updated: 0, deleted: 0 }), 'idempotent (the last two weeks recompute to the same figures)');
    return `${rebuilt.length} runs for w/c ${lastCompletedMonday}`;
  });
  await check('nextPay returns the earliest unpaid run even when overdue (status untouched)', async () => {
    const jordan = getUser(db, 10)!;
    // the earliest UNPAID run — pending or failed — is what nextPay reports (the seed gives Jordan a failed run)
    const pendingRun = get<Json>(db, `SELECT due_date AS dueDate, gross, status FROM payroll_runs WHERE user_id = 10 AND status IN ('pending', 'failed') ORDER BY due_date ASC LIMIT 1`);
    ok(pendingRun, 'Jordan has an unpaid run');
    const onDue = nextPay(db, jordan, pendingRun.dueDate);
    eq(onDue.nextPayday, pendingRun.dueDate, 'due today → that run');
    eq(onDue.nextPayAmount, pendingRun.gross, 'amount');
    const overdue = nextPay(db, jordan, addDays(pendingRun.dueDate, 3));
    eq(overdue.nextPayday, pendingRun.dueDate, 'overdue run is still the next pay');
    eq(overdue.nextPayAmount, pendingRun.gross, 'overdue amount');
    eq(get<Json>(db, `SELECT status FROM payroll_runs WHERE user_id = 10 AND due_date = ?`, [pendingRun.dueDate])!.status, pendingRun.status, 'stored status not mutated');
    run(db, `UPDATE payroll_runs SET status = 'failed' WHERE user_id = 10 AND due_date = ?`, [pendingRun.dueDate]);
    eq(nextPay(db, jordan, addDays(pendingRun.dueDate, 10)).nextPayday, pendingRun.dueDate, 'a failed run still needs paying');
    run(db, `UPDATE payroll_runs SET status = ? WHERE user_id = 10 AND due_date = ?`, [pendingRun.status, pendingRun.dueDate]);
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
    // the demo has no failed transfers (every past week is paid): bounce one so the filter and the repay have one
    run(db, `UPDATE payroll_runs SET status = 'failed', paid_date = NULL WHERE id = (SELECT id FROM payroll_runs WHERE status = 'paid' AND week_start >= ? ORDER BY week_start DESC, id LIMIT 1)`, [twelveWeeksAgo]);
    bumpDataVersion();
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
    // Release 1.3 (P1): byCampaign commission is the subs at each campaign's rep rate in effect on the day (a fresh seed
    // pays every week by the 1.3 rule) — checked against the rate history read here, row by row
    const commission = snapped.json.byCampaign.reduce((a: number, c: Json) => a + c.commission, 0);
    const rateRows = all<Json>(db, `SELECT campaign_id AS c, rep_rate AS rate, effective_from AS f FROM campaign_rates ORDER BY effective_from, id`);
    const rateOn = (c: number, d: string) => [...rateRows].reverse().find((r: Json) => r.c === c && r.f <= d)?.rate ?? rateRows.find((r: Json) => r.c === c)?.rate ?? 0;
    const reference = all<Json>(db, `SELECT g.date AS d, e.campaign_id AS c, g.sales AS s FROM gauge_entries g JOIN events e ON e.id = g.event_id WHERE g.date BETWEEN ? AND ?`, [twelveWeeksAgo, lastSunday])
      .reduce((a: number, g: Json) => a + g.s * rateOn(g.c, g.d), 0);
    ok(Math.abs(commission - reference) < 0.01, `byCampaign commission ${commission} = subs × the rate in effect each day ${round2(reference)}`);
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

  // ── payroll follows gauge changes ──
  let syncEventId = 0;
  const syncDate = addDays(lastCompletedMonday, 2);
  await check('Gauge writes recompute the week\'s unpaid runs (1.3 rule, no overrides) in the same transaction; a complete week without a run gets one', async () => {
    const ev = await admin.post('/events', { campaignId: 1, teamId: 1, name: 'Smoke late entry', venue: 'Smoke Hall', city: 'Manchester', type: 'retail', date: syncDate, startTime: '10:00', endTime: '18:00', targetSales: 5, notes: null });
    status(ev, 201, 'event in the last completed week');
    eq(ev.json.status, 'completed', 'completed');
    syncEventId = ev.json.id;
    const runOf = (userId: number) => get<Json>(db, `SELECT id, sales, gross, days_worked AS days, overrides, status, adjusted_at AS adjustedAt FROM payroll_runs WHERE user_id = ? AND week_start = ?`, [userId, lastCompletedMonday]);
    const jordanBefore = runOf(10);
    const ameliaBefore = runOf(2);
    ok(jordanBefore && jordanBefore.status === 'pending', 'Jordan has a pending run for that week');
    ok(ameliaBefore && ameliaBefore.status === 'pending', 'Amelia (leader) has a pending run');
    const r = await rep.post('/gauges', { eventId: syncEventId, userId: 10, date: syncDate, stops: 30, table: 10, presentations: 5, closes: 3, taps: 3, sales: 3 });
    status(r, 201, 'rep logs a forgotten day');
    const jordanAfter = runOf(10);
    eq(jordanAfter.id, jordanBefore.id, 'same run, updated in place');
    eq(jordanAfter.sales, jordanBefore.sales + 3, 'sales follow the gauges');
    eq(jordanAfter.gross, weekPayFor(db, getUser(db, 10)!, lastCompletedMonday)!.pay.gross, 'gross recomputed by weekPayFor');
    ok(jordanAfter.gross > jordanBefore.gross, 'pay went up');
    eq(jordanAfter.status, 'pending', 'still pending');
    const ameliaAfter = runOf(2);
    // Release 1.3 (P1): no automatic leader overrides — the team's sales do not move the leader's run
    eq(ameliaAfter.overrides, 0, 'no override from 1.3');
    eq(ameliaAfter.gross, ameliaBefore.gross, 'the team\'s sales do not move the leader\'s pay');
    const slip = await admin.get(`/finance/payroll/${jordanBefore.id}`);
    eq(slip.json.entries.reduce((a: number, e: Json) => a + e.sales, 0), jordanAfter.sales, 'payslip entries add up to the run');
    const summary = await admin.get(`/finance/summary?from=${lastCompletedMonday}&to=${addDays(lastCompletedMonday, 6)}`);
    eq(summary.json.weeks[0].payroll, round2(Number(get<Json>(db, `SELECT SUM(gross) AS g FROM payroll_runs WHERE week_start = ?`, [lastCompletedMonday])!.g)), 'finance week payroll moved with the runs');
    // a complete week with work but no run yet → a pending run is created; removing the work removes it again
    const starter = await admin.post('/users', { employeeId: 'LM-0930', email: 'smoke.starter@linearhub.example', firstName: 'Smoke', lastName: 'Starter', role: 'rep', position: 'trainee', teamId: 1, startDate: lastCompletedMonday, status: 'active', phone: null, city: 'Manchester' });
    status(starter, 201, 'new starter');
    eq(runOf(starter.json.id), undefined, 'no run yet');
    await signInOwner();
    const g = await owner.post('/gauges', { eventId: syncEventId, userId: starter.json.id, date: syncDate, stops: 20, table: 8, presentations: 4, closes: 2, taps: 2, sales: 2 });
    status(g, 201, 'admin logs the starter');
    const created = runOf(starter.json.id);
    ok(created && created.status === 'pending', 'pending run created for the complete week');
    eq(created.gross, 63.5, '1 day × £63.50 beats 2 subs × £20 (BCN): paid the base');
    ok(/^PAY-\d{6}-LM-0930$/.test(get<Json>(db, `SELECT reference FROM payroll_runs WHERE id = ?`, [created.id])!.reference), 'reference');
    status(await owner.del(`/gauges/${g.json.id}`), 204, 'entry removed');
    eq(runOf(starter.json.id), undefined, 'run removed with its only entry');
    const p = await rep.patch(`/gauges/${r.json.id}`, { sales: 2, taps: 2 });
    status(p, 200, 'rep patches the entry');
    eq(runOf(10).sales, jordanBefore.sales + 2, 'run follows the patch');
    return `Jordan ${jordanBefore.sales} → ${jordanAfter.sales} sales, £${jordanBefore.gross} → £${jordanAfter.gross}`;
  });
  await check('Paid week: gauge writes refused with 409 unless admin; an admin change flags the run adjusted_at (figures frozen) and the payslip shows it', async () => {
    const runRow = () => get<Json>(db, `SELECT id, sales, gross, status, adjusted_at AS adjustedAt FROM payroll_runs WHERE user_id = 10 AND week_start = ?`, [lastCompletedMonday])!;
    const before = runRow();
    const paid = await admin.post(`/finance/payroll/${before.id}/pay`, {});
    status(paid, 200, 'pay the run');
    const entry = get<Json>(db, `SELECT id FROM gauge_entries WHERE event_id = ? AND user_id = 10`, [syncEventId])!;
    const body = { eventId: syncEventId, userId: 10, date: syncDate, stops: 30, table: 10, presentations: 5, closes: 3, taps: 3, sales: 3 };
    const refused = await rep.post('/gauges', body);
    status(refused, 409, 'rep cannot change a paid week');
    eq(refused.json.error, 'This week has already been paid — ask an administrator to adjust', 'message');
    status(await rep.patch(`/gauges/${entry.id}`, { sales: 1, taps: 1 }), 409, 'rep PATCH refused');
    status(await leader.del(`/gauges/${entry.id}`), 409, 'leader DELETE refused');
    status(await leader.post('/gauges', body), 409, 'leader upsert refused');
    eq(runRow().adjustedAt, null, 'refused writes do not flag the run');
    const adjusted = await admin.patch(`/gauges/${entry.id}`, { sales: 1, taps: 1 });
    status(adjusted, 200, 'admin may adjust');
    const after = runRow();
    ok(typeof after.adjustedAt === 'string', 'run flagged adjusted_at');
    eq(after.gross, before.gross, 'paid figures are frozen');
    eq(after.sales, before.sales, 'paid sales frozen');
    eq(after.status, paid.json.status, 'status unchanged');
    ok(typeof (await rep.get(`/finance/payroll/${before.id}`)).json.adjustedAt === 'string', 'payslip carries adjustedAt');
    ok((await admin.get(`/finance/payroll?userId=10&from=${lastCompletedMonday}&to=${lastCompletedMonday}`)).json[0].adjustedAt !== null, 'payroll list carries adjustedAt');
    eq(get<Json>(db, `SELECT adjusted_at AS a FROM payroll_runs WHERE user_id = 2 AND week_start = ?`, [lastCompletedMonday])!.a, null, "the leader's still-unpaid run is recomputed, not flagged");
  });
  await check('POST /finance/payroll/:id/pay: paidDate must be between the week end and today', async () => {
    const pending = all<Json>(db, `SELECT id, week_end AS weekEnd FROM payroll_runs WHERE status = 'pending' AND week_start = ? ORDER BY id`, [lastCompletedMonday]);
    ok(pending.length >= 2, 'pending runs to pay');
    const [a, b] = pending;
    status(await admin.post(`/finance/payroll/${a.id}/pay`, { paidDate: '2031-01-01' }), 400, 'future paidDate');
    status(await admin.post(`/finance/payroll/${a.id}/pay`, { paidDate: addDays(a.weekEnd, -1) }), 400, 'before the week ends');
    status(await admin.post(`/finance/payroll/${a.id}/pay`, { paidDate: '2020-01-01' }), 400, 'years before the week');
    const onSunday = await admin.post(`/finance/payroll/${a.id}/pay`, { paidDate: a.weekEnd });
    status(onSunday, 200, 'on the week end');
    eq(onSunday.json.status, 'paid', 'paid before the due date');
    const now = await admin.post(`/finance/payroll/${b.id}/pay`, { paidDate: today });
    status(now, 200, 'today');
    eq(now.json.paidDate, today, 'paidDate today');
  });
  await check('materialisePayrollRuns recomputes the unpaid runs of the last two completed weeks (tampered figures restored); paid runs untouched', async () => {
    const unpaid = get<Json>(db, `SELECT id, sales, gross, status FROM payroll_runs WHERE week_start = ? AND status IN ('pending', 'failed') ORDER BY id LIMIT 1`, [lastCompletedMonday]);
    const paidRun = get<Json>(db, `SELECT id, sales, gross FROM payroll_runs WHERE week_start = ? AND status IN ('paid', 'late') AND adjusted_at IS NULL ORDER BY id LIMIT 1`, [lastCompletedMonday]);
    ok(unpaid && paidRun, 'an unpaid and a paid run in the last completed week');
    run(db, `UPDATE payroll_runs SET sales = sales + 100, gross = gross + 999 WHERE id IN (?, ?)`, [unpaid.id, paidRun.id]);
    const r = materialisePayrollRuns(db);
    ok(r.updated >= 1, `recomputed ${r.updated} run(s)`);
    const fixed = get<Json>(db, `SELECT sales, gross, status FROM payroll_runs WHERE id = ?`, [unpaid.id])!;
    eq(fixed.sales, unpaid.sales, 'unpaid sales restored from the gauges');
    eq(fixed.gross, unpaid.gross, 'unpaid gross restored');
    eq(fixed.status, unpaid.status, 'status kept');
    const frozen = get<Json>(db, `SELECT sales, gross FROM payroll_runs WHERE id = ?`, [paidRun.id])!;
    eq(frozen.sales, paidRun.sales + 100, 'paid run not recomputed');
    run(db, `UPDATE payroll_runs SET sales = ?, gross = ? WHERE id = ?`, [paidRun.sales, paidRun.gross, paidRun.id]);
    bumpDataVersion();
    eq(JSON.stringify(materialisePayrollRuns(db)), JSON.stringify({ created: 0, updated: 0, deleted: 0 }), 'idempotent afterwards');
  });
  await check('Dashboard earningsToDate counts only runs whose pay week starts in the range (+ live estimate for weeks without a run)', async () => {
    const jordan = getUser(db, 10)!;
    for (const range of ['month', 'quarter'] as const) {
      const d = await rep.get(`/me/dashboard?range=${range}`);
      status(d, 200, range);
      const runs = all<Json>(db, `SELECT week_start AS weekStart, gross FROM payroll_runs WHERE user_id = 10 AND week_start BETWEEN ? AND ?`, [d.json.from, d.json.to]);
      let expected = runs.reduce((a: number, r: Json) => a + r.gross, 0);
      const covered = new Set(runs.map((r: Json) => r.weekStart));
      for (let m = mondayOf(d.json.from); m <= d.json.to; m = addDays(m, 7)) if (m >= d.json.from && !covered.has(m)) expected += weekPayFor(db, jordan, m)?.pay.gross ?? 0;
      eq(d.json.personal.earningsToDate, round2(expected), `${range}: runs starting in the range + estimate`);
      const firstMonday = mondayOf(d.json.from);
      if (firstMonday < d.json.from) {
        const straddling = get<Json>(db, `SELECT gross FROM payroll_runs WHERE user_id = 10 AND week_start = ?`, [firstMonday]);
        if (straddling && straddling.gross > 0) ok(Math.abs(d.json.personal.earningsToDate - (expected + straddling.gross)) > 0.001, `${range}: the week straddling the period start is not counted`);
      }
    }
  });
  await check('Money rates are snapshotted per entry: changing a campaign payout leaves past revenue alone and only applies to new entries', async () => {
    const range = `from=${lastCompletedMonday}&to=${addDays(lastCompletedMonday, 6)}`;
    const before = (await admin.get(`/finance/summary?${range}`)).json;
    const dashBefore = (await admin.get('/me/dashboard?range=quarter')).json.company.revenue;
    await signInOwner();
    status(await owner.patch('/campaigns/1', { payoutPerSale: 130 }), 200, 'raise BCN payout 120 → 130');
    const after = (await admin.get(`/finance/summary?${range}`)).json;
    eq(after.totals.revenue, before.totals.revenue, 'past revenue unchanged');
    eq(JSON.stringify(after.byCampaign), JSON.stringify(before.byCampaign), 'by-campaign revenue/commission/margin unchanged');
    eq((await admin.get('/me/dashboard?range=quarter')).json.company.revenue, dashBefore, 'dashboard revenue unchanged');
    const g = await leader.post('/gauges', { eventId: syncEventId, userId: 9, date: syncDate, stops: 20, table: 8, presentations: 4, closes: 2, taps: 2, sales: 2 });
    status(g, 201, 'a new entry under the new rate');
    const snap = get<Json>(db, `SELECT payout_per_sale AS p, commission_per_sale AS c FROM gauge_entries WHERE id = ?`, [g.json.id])!;
    eq(snap.p, 130, 'payout snapshot');
    eq(snap.c, get<Json>(db, `SELECT pp.commission_per_sale AS c FROM users u JOIN pay_plans pp ON pp.id = u.pay_plan_id WHERE u.id = 9`)!.c, "commission snapshot from the person's plan");
    const withNew = (await admin.get(`/finance/summary?${range}`)).json;
    eq(withNew.totals.revenue, round2(after.totals.revenue + 2 * 130), 'the new sales count at £130');
    status(await owner.patch('/campaigns/1', { payoutPerSale: 120 }), 200, 'restore the rate');
    eq((await admin.get(`/finance/summary?${range}`)).json.totals.revenue, withNew.totals.revenue, 'restoring the rate does not restate the new entry either');
    eq(get<Json>(db, `SELECT COUNT(*) AS n FROM gauge_entries WHERE payout_per_sale IS NULL OR commission_per_sale IS NULL`)!.n, 0, 'every seeded row carries a snapshot');
    status(await leader.del(`/gauges/${g.json.id}`), 204, 'cleanup');
  });
  await check('FinanceSummary weeks (one GROUP BY per series) equal the per-week reference queries', async () => {
    const r = (await admin.get('/finance/summary')).json;
    for (const w of r.weeks) {
      const sunday = addDays(w.weekStart, 6);
      const g = get<Json>(db, `SELECT COALESCE(SUM(g.sales * COALESCE(g.payout_per_sale, c.payout_per_sale)), 0) AS revenue, COALESCE(SUM(g.sales), 0) AS sales FROM gauge_entries g JOIN events e ON e.id = g.event_id JOIN campaigns c ON c.id = e.campaign_id WHERE g.date BETWEEN ? AND ?`, [w.weekStart, sunday])!;
      const x = get<Json>(db, `SELECT COALESCE(SUM(amount), 0) AS expenses FROM expenses WHERE date BETWEEN ? AND ?`, [w.weekStart, sunday])!;
      eq(w.revenue, round2(Number(g.revenue)), `${w.weekStart} revenue`);
      eq(w.sales, Number(g.sales), `${w.weekStart} sales`);
      eq(w.expenses, round2(Number(x.expenses)), `${w.weekStart} expenses`);
      if (!w.estimated) eq(w.payroll, round2(Number(get<Json>(db, `SELECT COALESCE(SUM(gross), 0) AS p FROM payroll_runs WHERE week_start = ?`, [w.weekStart])!.p)), `${w.weekStart} payroll`);
    }
    const lw = (await leader.get('/finance/summary')).json.weeks[0];
    const lg = get<Json>(db, `SELECT COALESCE(SUM(g.sales * COALESCE(g.payout_per_sale, c.payout_per_sale)), 0) AS revenue FROM gauge_entries g JOIN users u ON u.id = g.user_id JOIN events e ON e.id = g.event_id JOIN campaigns c ON c.id = e.campaign_id WHERE u.team_id = 1 AND g.date BETWEEN ? AND ?`, [lw.weekStart, addDays(lw.weekStart, 6)])!;
    eq(lw.revenue, round2(Number(lg.revenue)), 'team-scoped week revenue');
    return `${r.weeks.length} weeks identical`;
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
    const p = await recruiter.patch(`/recruitment/candidates/${candidateId}`, { rating: 4, notes: 'Strong phone screen', nextAction: 'Book interview', nextActionAt: businessNow().toISOString() });
    status(p, 200, 'patch');
    eq(p.json.rating, 4, 'rating');
    status(await recruiter.patch(`/recruitment/candidates/${candidateId}`, { stage: 'offer' }), 400, 'stage via PATCH rejected');
    const s1 = await leader.post(`/recruitment/candidates/${candidateId}/stage`, { stage: 'screening', note: 'Good call' });
    status(s1, 200, 'leader moves stage');
    eq(s1.json.stage, 'screening', 'stage screening');
    status(await leader.post(`/recruitment/candidates/${candidateId}/stage`, { stage: 'screening' }), 409, 'same stage');
    status(await recruiter.post(`/recruitment/candidates/${candidateId}/stage`, { stage: 'hired' }), 409, 'hired only from offer');
    status(await recruiter.post(`/recruitment/candidates/${candidateId}/stage`, { stage: 'offer' }), 200, 'screening → offer (forward moves may skip stages)');
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
    status(await recruiter.post(`/recruitment/candidates/${c2.json.id}/stage`, { stage: 'offer' }), 200, 'second candidate to offer');
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
    const future = r.json.filter((i: Json) => i.scheduledAt > businessNow().toISOString());
    ok(future.length > 0, 'some interviews scheduled ahead');
    const at = new Date(businessNow().getTime() + 3 * 86_400_000).toISOString();
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
  await check('Candidate stage machine: forward, one step back, reject/withdraw from open stages, hired only from offer, admin-only reopen to offer', async () => {
    const c = await recruiter.post('/recruitment/candidates', { firstName: 'Stage', lastName: 'Machine', email: 'stage.machine@example.com' });
    status(c, 201, 'candidate');
    const move = (client: Client, stage: string) => client.post(`/recruitment/candidates/${c.json.id}/stage`, { stage });
    const refused = await move(recruiter, 'hired');
    status(refused, 409, 'applied → hired refused');
    eq(refused.json.error, 'Candidates are hired from the offer stage', 'message');
    status(await move(recruiter, 'interview'), 200, 'applied → interview (two steps forward)');
    status(await move(recruiter, 'applied'), 409, 'two steps back refused');
    status(await move(recruiter, 'screening'), 200, 'one step back');
    status(await move(recruiter, 'offer'), 200, 'screening → offer');
    status(await move(recruiter, 'withdrawn'), 200, 'withdrawn from an open stage');
    status(await move(recruiter, 'offer'), 409, 'recruiter cannot reopen');
    status(await move(leader, 'applied'), 409, 'leader cannot reopen');
    status(await move(admin, 'applied'), 409, 'admin can only reopen to offer');
    status(await move(admin, 'offer'), 200, 'admin reopens to offer');
    status(await move(leader, 'rejected'), 200, 'rejected');
    status(await move(leader, 'rejected'), 409, 'same stage');
    status(await move(admin, 'offer'), 200, 'reopened again');
    status(await move(recruiter, 'hired'), 200, 'hired from offer');
    status(await move(admin, 'offer'), 409, 'hired is final');
    eq((await recruiter.get(`/recruitment/candidates/${c.json.id}`)).json.history.length, 9, 'applied + eight moves recorded');
  });
  await check('Duplicate candidates: same email refused while open (409), allowed again once closed; hire refused when a user with that email exists or the person was hired already', async () => {
    const dup = { firstName: 'Dupe', lastName: 'Person', email: 'dupe.person@example.com' };
    const first = await recruiter.post('/recruitment/candidates', dup);
    status(first, 201, 'first');
    const second = await recruiter.post('/recruitment/candidates', { ...dup, firstName: 'Dupe2' });
    status(second, 409, 'same email while open');
    ok(/already in the pipeline/.test(second.json.error), `message (${second.json.error})`);
    status(await recruiter.post('/recruitment/candidates', { ...dup, email: 'DUPE.PERSON@example.com' }), 409, 'case-insensitive');
    const other = await recruiter.post('/recruitment/candidates', { firstName: 'Other', lastName: 'Person', email: 'other.person@example.com' });
    status(other, 201, 'another candidate');
    status(await recruiter.patch(`/recruitment/candidates/${other.json.id}`, { email: dup.email }), 409, 'PATCH onto an open email refused');
    status(await recruiter.post(`/recruitment/candidates/${first.json.id}/stage`, { stage: 'rejected' }), 200, 'close the first');
    const again = await recruiter.post('/recruitment/candidates', dup);
    status(again, 201, 'may re-apply once closed');
    const twin = await recruiter.post('/recruitment/candidates', { firstName: 'Jordan', lastName: 'Twin', email: 'jordan.lee@linearhub.example' });
    status(twin, 201, 'candidate with an existing user\'s email');
    status(await recruiter.post(`/recruitment/candidates/${twin.json.id}/stage`, { stage: 'offer' }), 200, 'to offer');
    const hire = await recruiter.post(`/recruitment/candidates/${twin.json.id}/stage`, { stage: 'hired' });
    status(hire, 409, 'hire refused: a user with that email exists');
    ok(/already exists/.test(hire.json.error), `message (${hire.json.error})`);
    eq((await recruiter.get(`/recruitment/candidates/${twin.json.id}`)).json.stage, 'offer', 'stage unchanged');
    status(await recruiter.post(`/recruitment/candidates/${again.json.id}/stage`, { stage: 'offer' }), 200, 'to offer');
    status(await recruiter.post(`/recruitment/candidates/${again.json.id}/stage`, { stage: 'hired' }), 200, 'hired once');
    const third = await recruiter.post('/recruitment/candidates', dup);
    status(third, 201, 'a new record once the previous one is closed');
    status(await recruiter.post(`/recruitment/candidates/${third.json.id}/stage`, { stage: 'offer' }), 200, 'to offer');
    const rehire = await recruiter.post(`/recruitment/candidates/${third.json.id}/stage`, { stage: 'hired' });
    status(rehire, 409, 'cannot be hired twice');
    ok(/already been hired/.test(rehire.json.error), `message (${rehire.json.error})`);
  });
  await check('Hire emails transliterate accents, never produce empty parts, and are numbered when taken', async () => {
    const hire = async (firstName: string, lastName: string, email: string): Promise<string> => {
      const c = await recruiter.post('/recruitment/candidates', { firstName, lastName, email });
      status(c, 201, `candidate ${email}`);
      status(await recruiter.post(`/recruitment/candidates/${c.json.id}/stage`, { stage: 'offer' }), 200, 'offer');
      const h = await recruiter.post(`/recruitment/candidates/${c.json.id}/stage`, { stage: 'hired' });
      status(h, 200, 'hired');
      return (await admin.get(`/users/${h.json.hiredUserId}`)).json.email as string;
    };
    eq(await hire('Łukasz', 'Żółć', 'lukasz1@example.com'), 'lukasz.zolc@linear-mcr.co.uk', 'Polish letters transliterated');
    eq(await hire('Łukasz', 'Żółć', 'lukasz2@example.com'), 'lukasz.zolc2@linear-mcr.co.uk', 'numbered when taken');
    eq(await hire('Zoë', "O'Brien-Søren", 'zoe@example.com'), 'zoe.obriensoren@linear-mcr.co.uk', 'diaeresis, apostrophe, hyphen, ø');
    eq(await hire('李', '明', 'li@example.com'), 'staff@linear-mcr.co.uk', 'nothing transliterable → staff');
    eq(await hire('李', '华', 'li2@example.com'), 'staff2@linear-mcr.co.uk', 'staff, numbered');
    eq(await hire('Anne-Marie', '李', 'am@example.com'), 'annemarie@linear-mcr.co.uk', 'an empty part is dropped, never a trailing dot');
  });
  await check('overdueActions follows the shared isOverdue rule (date-only due today is not overdue; a future timestamp is not)', async () => {
    const c = await recruiter.post('/recruitment/candidates', { firstName: 'Over', lastName: 'Due', email: 'over.due@example.com' });
    status(c, 201, 'candidate');
    const setDue = async (nextActionAt: string | null) => status(await recruiter.patch(`/recruitment/candidates/${c.json.id}`, { nextActionAt }), 200, `set ${nextActionAt}`);
    const count = async () => (await recruiter.get('/recruitment/summary')).json.overdueActions as number;
    await setDue(null);
    const base0 = await count();
    await setDue(today);
    eq(await count(), base0, 'date-only due today is not overdue');
    await setDue(addDays(today, -1));
    eq(await count(), base0 + 1, 'date-only due yesterday is overdue');
    const future = new Date(businessNow().getTime() + 3 * 3600_000);
    await setDue(`${new Date(future.getTime() - 5 * 3600_000).toISOString().slice(0, 19)}-05:00`);
    eq(await count(), base0, 'a future instant written with a negative offset is not overdue');
    await setDue(new Date(businessNow().getTime() - 3600_000).toISOString());
    eq(await count(), base0 + 1, 'a past timestamp is overdue');
    status(await recruiter.post(`/recruitment/candidates/${c.json.id}/stage`, { stage: 'withdrawn' }), 200, 'close');
    eq(await count(), base0, 'closed candidates are never overdue');
  });
  await check('RecruitmentSummary.weekly buckets are clipped to the range (first bucket keyed by `from`) and equal the per-week reference', async () => {
    const sum = (rows: Json[], k: string) => rows.reduce((a: number, w: Json) => a + w[k], 0);
    const verify = async (from: string, to: string) => {
      const r = (await recruiter.get(`/recruitment/summary?from=${from}&to=${to}`)).json;
      eq(r.weekly[0].weekStart, from < mondayOf(from) ? from : from === mondayOf(from) ? from : from, 'first bucket keyed by from');
      for (const w of r.weekly) {
        const end = addDays(mondayOf(w.weekStart), 6) < to ? addDays(mondayOf(w.weekStart), 6) : to;
        const wFrom = `${w.weekStart}T00:00:00.000Z`;
        const wTo = `${end}T23:59:59.999Z`;
        eq(w.applied, get<Json>(db, `SELECT COUNT(*) AS n FROM candidates WHERE applied_at BETWEEN ? AND ?`, [wFrom, wTo])!.n, `${w.weekStart} applied`);
        eq(w.interviews, get<Json>(db, `SELECT COUNT(*) AS n FROM interviews WHERE scheduled_at BETWEEN ? AND ?`, [wFrom, wTo])!.n, `${w.weekStart} interviews`);
        eq(w.hired, get<Json>(db, `SELECT COUNT(DISTINCT candidate_id) AS n FROM stage_changes WHERE to_stage = 'hired' AND changed_at BETWEEN ? AND ?`, [wFrom, wTo])!.n, `${w.weekStart} hired`);
      }
      eq(sum(r.weekly, 'applied'), r.applied, 'weekly applied adds up to the headline');
      eq(sum(r.weekly, 'hired'), r.hired, 'weekly hired adds up to the headline');
      return r.weekly.length as number;
    };
    const n1 = await verify(twelveWeeksAgo, today);
    const midWeekFrom = addDays(monday, -5); // the previous Wednesday
    const n2 = await verify(midWeekFrom, today);
    eq((await recruiter.get(`/recruitment/summary?from=${midWeekFrom}&to=${today}`)).json.weekly[0].weekStart, midWeekFrom, 'mid-week start labels the first bucket');
    return `${n1} + ${n2} buckets identical`;
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

  // ── two-step verification (TOTP) — a non-demo user so the demo sign-in keeps working. Release 1.4 (package S):
  // two-step is required for every account but the demo sign-in accounts, so this user is held at setup until it is
  // on and can never turn it off (only an admin reset clears it); switching it off is checked on a demo Sapiens
  // account, which is exempt while the database is still the demo. ──
  const tfa = {
    employeeId: 'LM-0920', email: 'smoke.totp@linearhub.example', firstName: 'Smoke', lastName: 'Totp', role: 'rep', position: 'field_rep',
    teamId: 2, startDate: today, status: 'active', phone: null, city: 'Manchester',
  };
  const tfaLogin = { email: tfa.email, employeeId: tfa.employeeId };
  let tfaUserId = 0;
  const RECOVERY_RE = /^[a-z0-9]{4}-[a-z0-9]{4}$/;
  /** A code that is certainly wrong right now: the current one with its last digit changed. */
  const wrongCode = (secret: string) => {
    const right = totp(secret);
    return right.slice(0, 5) + String((Number(right[5]) + 1) % 10);
  };
  /** Setup + enable for a signed-in client; returns the secret and the recovery codes. */
  const enable2fa = async (client: Client): Promise<{ secret: string; codes: string[] }> => {
    const setup = await client.post('/auth/2fa/setup');
    status(setup, 201, 'setup');
    const enabled = await client.post('/auth/2fa/enable', { code: totp(setup.json.secret) });
    status(enabled, 200, 'enable');
    return { secret: setup.json.secret, codes: enabled.json.recoveryCodes };
  };
  const tfaDbRow = () => get<Json>(db, `SELECT totp_secret_enc AS s, totp_pending_enc AS p, totp_enabled_at AS e FROM users WHERE id = ?`, [tfaUserId])!;
  const recoveryRows = () => get<Json>(db, `SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = ?`, [tfaUserId])!.n as number;
  const tfaUser = new Client(base, 'totp');
  /**
   * Authenticator codes are single use (the last accepted time step is stored per user). The flow below reuses a
   * secret's code inside one 30-second step for brevity, so it forgets that marker first; the dedicated replay check
   * verifies the rule itself.
   */
  const code = (secret: string): string => {
    run(db, `UPDATE users SET totp_last_counter = NULL WHERE id = ?`, [tfaUserId]);
    return totp(secret);
  };
  let tfaSecret = '';
  let tfaCodes: string[] = [];
  /** A one-time setup code for the smoke user, as an administrator would hand over (npm run setup-code does the same). */
  const freshSetupCode = (): string => issueSetupCode(db, tfaUserId, { createdBy: null, reason: 'command' }).code;
  await check('2FA setup → enable: QR + otpauth, wrong code 400, 10 recovery codes, other sessions signed out', async () => {
    const created = await admin.post('/users', tfa);
    status(created, 201, 'create user');
    tfaUserId = created.json.id;
    ok(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/.test(created.json.setupCode), `a one-time setup code (${created.json.setupCode})`);
    const other = new Client(base, 'totp-other');
    const asked = await tfaUser.post('/auth/login', tfaLogin);
    status(asked, 200, 'email and employee ID alone: asked for the setup code');
    eq(asked.json.requiresSetupCode, true, 'requiresSetupCode');
    ok(!asked.headers.get('set-cookie') && asked.json.user === undefined, 'no session without the code');
    const login = await tfaUser.post('/auth/login', { ...tfaLogin, setupCode: created.json.setupCode.toLowerCase().replace(/-/g, ' ') });
    status(login, 200, 'login with the setup code (any case, spaces)');
    eq(login.json.user.twoFactorEnabled, false, 'login carries twoFactorEnabled=false');
    status(await other.post('/auth/login', { ...tfaLogin, setupCode: created.json.setupCode }), 401, 'the code works once');
    status(await other.post('/auth/login', { ...tfaLogin, setupCode: freshSetupCode() }), 200, 'second session');
    resetLoginFailures();
    eq((await tfaUser.get('/auth/me')).json.user.twoFactorEnabled, false, '/auth/me flag off');
    const off = await tfaUser.get('/auth/2fa');
    status(off, 200, 'status');
    eq(JSON.stringify(off.json), JSON.stringify({ enabled: false, enabledAt: null, recoveryCodesLeft: 0, pendingSetup: false, required: true }), 'status off');
    eq((await tfaUser.get('/auth/me')).json.user.twoFactorSetupRequired, true, 'release 1.4: held at setup');
    eq((await tfaUser.get('/me/dashboard')).json.twoFactorSetupRequired, true, 'the gate holds the app');
    status(await tfaUser.post('/auth/2fa/enable', { code: '123456' }), 409, 'enable with nothing pending');
    status(await tfaUser.post('/auth/2fa/disable', { code: '123456' }), 403, 'disable while off: held at setup');
    status(await tfaUser.post('/auth/2fa/recovery-codes', { code: '123456' }), 403, 'recovery codes while off: held at setup');
    const first = await tfaUser.post('/auth/2fa/setup');
    status(first, 201, 'setup');
    ok(/^[A-Z2-7]{32}$/.test(first.json.secret), `base32 secret (${first.json.secret})`);
    ok(first.json.otpauthUrl.startsWith('otpauth://totp/Linear%20Hub:smoke.totp%40linearhub.example?'), `otpauth label (${first.json.otpauthUrl})`);
    ok(first.json.otpauthUrl.includes(`secret=${first.json.secret}`) && first.json.otpauthUrl.includes('issuer=Linear%20Hub'), 'otpauth params');
    ok(typeof first.json.qrSvg === 'string' && first.json.qrSvg.startsWith('<svg') && first.json.qrSvg.length > 500, 'inline SVG QR');
    eq((await tfaUser.get('/auth/2fa')).json.pendingSetup, true, 'pendingSetup after setup');
    const second = await tfaUser.post('/auth/2fa/setup');
    status(second, 201, 'setup again replaces the pending secret');
    ok(second.json.secret !== first.json.secret, 'new secret');
    tfaSecret = second.json.secret;
    const bad = await tfaUser.post('/auth/2fa/enable', { code: wrongCode(tfaSecret) });
    status(bad, 400, 'wrong code');
    eq(bad.json.error, 'That code is not valid', 'wrong code message');
    status(await tfaUser.post('/auth/2fa/enable', { code: '12 34' }), 400, 'malformed code');
    status(await tfaUser.post('/auth/2fa/enable', { code: totp(first.json.secret) }), 400, 'code from the replaced secret');
    status(await tfaUser.post('/auth/2fa/enable', {}), 400, 'missing code → validation');
    const on = await tfaUser.post('/auth/2fa/enable', { code: totp(tfaSecret) });
    status(on, 200, 'enable');
    tfaCodes = on.json.recoveryCodes;
    eq(tfaCodes.length, 10, 'ten recovery codes');
    ok(tfaCodes.every((c: string) => RECOVERY_RE.test(c)), `xxxx-xxxx lower-case alphanumerics (${tfaCodes[0]})`);
    eq(new Set(tfaCodes).size, 10, 'all distinct');
    status(await other.get('/auth/me'), 401, 'the other session was signed out');
    const me = await tfaUser.get('/auth/me');
    status(me, 200, 'current session kept');
    eq(me.json.user.twoFactorEnabled, true, '/auth/me flag on');
    const st = await tfaUser.get('/auth/2fa');
    eq(st.json.enabled, true, 'enabled');
    ok(typeof st.json.enabledAt === 'string' && st.json.enabledAt.startsWith(today.slice(0, 4)), 'enabledAt timestamp');
    eq(st.json.recoveryCodesLeft, 10, '10 left');
    eq(st.json.pendingSetup, false, 'nothing pending');
    status(await tfaUser.post('/auth/2fa/setup'), 409, 'setup while on');
    status(await tfaUser.post('/auth/2fa/enable', { code: totp(tfaSecret) }), 409, 'enable while on');
    const row = tfaDbRow();
    ok(typeof row.s === 'string' && row.s.startsWith('v1:') && !row.s.includes(tfaSecret), 'secret stored encrypted (v1:iv:tag:ct)');
    eq(row.p, null, 'pending cleared');
    eq(recoveryRows(), 10, 'hashed recovery codes stored');
    ok(!get<Json>(db, `SELECT GROUP_CONCAT(code_hash) AS h FROM recovery_codes WHERE user_id = ?`, [tfaUserId])!.h.includes(tfaCodes[0]!.replace('-', '')), 'codes stored hashed, not plain');
    const asAdmin = await admin.get(`/users/${tfaUserId}`);
    const secretKey = (o: Json) => Object.keys(o).some((k) => /totp|secret|enc$/i.test(k));
    ok(!secretKey(asAdmin.json), 'user payload never carries the secret columns');
    ok(!secretKey(me.json.user) && !secretKey(login.json.user), '/auth/me and login never carry the secret columns');
    ok(!JSON.stringify(asAdmin.json).includes(row.s) && !JSON.stringify(me.json).includes(row.s), 'ciphertext never leaves the database');
  });
  await check('Login with 2FA on: challenge without cookie → wrong code 401 → right code sets cookie; token is single use', async () => {
    const c = new Client(base, 'totp-login');
    const step1 = await c.post('/auth/login', tfaLogin);
    status(step1, 200, 'step one');
    eq(step1.json.requiresTwoFactor, true, 'requiresTwoFactor');
    eq(step1.json.method, 'totp', 'method');
    ok(typeof step1.json.challengeToken === 'string' && step1.json.challengeToken.length === 64, 'challenge token');
    ok(!step1.headers.get('set-cookie'), 'no session cookie yet');
    eq(step1.json.user, undefined, 'no user payload yet');
    status(await c.get('/auth/me'), 401, 'not signed in yet');
    const token = step1.json.challengeToken;
    status(await c.post('/auth/login/2fa', {}), 400, 'empty body → validation');
    status(await c.post('/auth/login/2fa', { challengeToken: token }), 400, 'no code or recovery code → validation');
    const wrong = await c.post('/auth/login/2fa', { challengeToken: token, code: wrongCode(tfaSecret) });
    status(wrong, 401, 'wrong code');
    eq(wrong.json.error, 'That code is not valid', 'wrong code message');
    ok(!wrong.headers.get('set-cookie'), 'still no cookie');
    eq(get<Json>(db, `SELECT attempts FROM two_factor_challenges WHERE token = ?`, [token])!.attempts, 1, 'attempt counted on the challenge');
    const right = await c.post('/auth/login/2fa', { challengeToken: token, code: code(tfaSecret) });
    status(right, 200, 'right code');
    ok(/lm_session=[0-9a-f]{64}/.test(right.headers.get('set-cookie') ?? ''), 'session cookie set');
    eq(right.json.user.id, tfaUserId, 'user payload');
    eq(right.json.user.twoFactorEnabled, true, 'flag on');
    eq(right.json.user.employeeId, tfa.employeeId, 'own employee ID');
    status(await c.get('/auth/me'), 200, 'signed in');
    eq(get<Json>(db, `SELECT COUNT(*) AS n FROM two_factor_challenges WHERE token = ?`, [token])!.n, 0, 'challenge deleted after use');
    status(await c.post('/auth/login/2fa', { challengeToken: token, code: totp(tfaSecret) }), 410, 'reused token → 410');
    status(await c.post('/auth/login/2fa', { challengeToken: 'f'.repeat(64), code: totp(tfaSecret) }), 410, 'unknown token → 410');
    status(await c.post('/auth/logout'), 204, 'logout');
  });
  await check('Authenticator codes are single use: a replayed code is refused at login and in settings; the next time step works', async () => {
    const c = new Client(base, 'totp-replay');
    const challenge = async () => (await c.post('/auth/login', tfaLogin)).json.challengeToken as string;
    const used = code(tfaSecret);
    status(await c.post('/auth/login/2fa', { challengeToken: await challenge(), code: used }), 200, 'first use signs in');
    const stored = get<Json>(db, `SELECT totp_last_counter AS n FROM users WHERE id = ?`, [tfaUserId])!.n;
    ok(Math.abs(stored - totpCounter(Date.now())) <= 1, `the accepted time step is stored (${stored})`);
    status(await c.post('/auth/logout'), 204, 'logout');
    const token = await challenge();
    const replay = await c.post('/auth/login/2fa', { challengeToken: token, code: used });
    status(replay, 401, 'the same code is refused at login');
    eq(replay.json.error, 'That code is not valid', 'message');
    status(await tfaUser.post('/auth/2fa/recovery-codes', { code: used }), 400, 'and in settings');
    status(await tfaUser.post('/auth/2fa/disable', { code: used }), 409, 'disabling is refused anyway (release 1.4: required)');
    eq(get<Json>(db, `SELECT totp_last_counter AS n FROM users WHERE id = ?`, [tfaUserId])!.n, stored, 'marker unchanged by refused replays');
    // the following 30-second step (still inside the ±1 window) is a new code and is accepted
    status(await c.post('/auth/login/2fa', { challengeToken: token, code: totp(tfaSecret, { timeMs: Date.now() + 30_000 }) }), 200, 'the next code works');
    ok(get<Json>(db, `SELECT totp_last_counter AS n FROM users WHERE id = ?`, [tfaUserId])!.n > stored, 'marker moved forward');
    status(await c.post('/auth/logout'), 204, 'logout');
    resetCodeFailures();
  });
  await check('Recovery codes: single use at login (case/hyphen tolerant); regenerating with a code invalidates the old set', async () => {
    const c = new Client(base, 'totp-recovery');
    const challenge = async () => (await c.post('/auth/login', tfaLogin)).json.challengeToken as string;
    status(await c.post('/auth/login/2fa', { challengeToken: await challenge(), recoveryCode: tfaCodes[0]!.toUpperCase() }), 200, 'recovery code signs in');
    eq((await c.get('/auth/2fa')).json.recoveryCodesLeft, 9, '9 left');
    status(await c.post('/auth/logout'), 204, 'logout');
    status(await c.post('/auth/login/2fa', { challengeToken: await challenge(), recoveryCode: tfaCodes[0] }), 401, 'same code again fails');
    status(await c.post('/auth/login/2fa', { challengeToken: await challenge(), recoveryCode: tfaCodes[1]!.replace('-', ' ') }), 200, 'another code without the hyphen');
    eq((await c.get('/auth/2fa')).json.recoveryCodesLeft, 8, '8 left');
    status(await c.post('/auth/logout'), 204, 'logout');
    const bad = await tfaUser.post('/auth/2fa/recovery-codes', { code: wrongCode(tfaSecret) });
    status(bad, 400, 'regenerate with a wrong code');
    status(await tfaUser.post('/auth/2fa/recovery-codes', { recoveryCode: tfaCodes[2] }), 400, 'regenerate needs an authenticator code, not a recovery code');
    const fresh = await tfaUser.post('/auth/2fa/recovery-codes', { code: code(tfaSecret) });
    status(fresh, 200, 'regenerate');
    eq(fresh.json.recoveryCodes.length, 10, 'ten new codes');
    ok(fresh.json.recoveryCodes.every((x: string) => RECOVERY_RE.test(x) && !tfaCodes.includes(x)), 'all new');
    eq((await tfaUser.get('/auth/2fa')).json.recoveryCodesLeft, 10, '10 left again');
    status(await c.post('/auth/login/2fa', { challengeToken: await challenge(), recoveryCode: tfaCodes[2] }), 401, 'old unused code no longer works');
    status(await c.post('/auth/login/2fa', { challengeToken: await challenge(), recoveryCode: fresh.json.recoveryCodes[0] }), 200, 'new code works');
    status(await c.post('/auth/logout'), 204, 'logout');
    tfaCodes = fresh.json.recoveryCodes;
  });
  await check('Disable: refused for an account that must use it; a demo account: 400 without a valid code, 204 with a recovery code (or code), login back to one step', async () => {
    // Release 1.4 (package S): the non-demo user keeps two-step on, whatever it sends
    status(await tfaUser.post('/auth/2fa/disable', {}), 400, 'nothing supplied → validation');
    const refused = await tfaUser.post('/auth/2fa/disable', { recoveryCode: tfaCodes[1] });
    status(refused, 409, 'required for every account');
    ok(/required for every account/.test(refused.json.error), `message (${refused.json.error})`);
    eq((await tfaUser.get('/auth/2fa')).json.enabled, true, 'still on');
    eq(recoveryRows(), 10, 'no recovery code spent');
    // …a demo sign-in account (team Sapiens) may switch it on and off again
    const demo = get<Json>(db, `SELECT id, email, employee_id AS employeeId FROM users WHERE employee_id = 'LM-0107'`)!;
    const demoLogin = { email: demo.email, employeeId: demo.employeeId };
    const demoCode = (secret: string): string => {
      run(db, `UPDATE users SET totp_last_counter = NULL WHERE id = ?`, [demo.id]);
      return totp(secret);
    };
    const y = new Client(base, 'totp-demo');
    status(await y.post('/auth/login', demoLogin), 200, 'demo account signs in in one step');
    eq((await y.get('/auth/2fa')).json.required, false, 'not required for a demo sign-in account');
    const ySetup = await y.post('/auth/2fa/setup');
    status(ySetup, 201, 'setup');
    const yOn = await y.post('/auth/2fa/enable', { code: totp(ySetup.json.secret) });
    status(yOn, 200, 'enable');
    status(await y.post('/auth/2fa/disable', {}), 400, 'nothing supplied → validation');
    const bad = await y.post('/auth/2fa/disable', { code: wrongCode(ySetup.json.secret) });
    status(bad, 400, 'wrong code');
    eq(bad.json.error, 'That code is not valid', 'message');
    status(await y.post('/auth/2fa/disable', { recoveryCode: 'zzzz-zzzz' }), 400, 'unknown recovery code');
    status(await y.post('/auth/2fa/disable', { recoveryCode: yOn.json.recoveryCodes[1] }), 204, 'disable with a recovery code');
    const st = await y.get('/auth/2fa');
    eq(JSON.stringify(st.json), JSON.stringify({ enabled: false, enabledAt: null, recoveryCodesLeft: 0, pendingSetup: false, required: false }), 'status off');
    eq((await y.get('/auth/me')).json.user.twoFactorEnabled, false, 'flag off');
    const row = get<Json>(db, `SELECT totp_secret_enc AS s, totp_pending_enc AS p, totp_enabled_at AS e FROM users WHERE id = ?`, [demo.id])!;
    ok(row.s === null && row.p === null && row.e === null, 'secret columns cleared');
    eq(get<Json>(db, `SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = ?`, [demo.id])!.n, 0, 'recovery codes deleted');
    const c = new Client(base, 'totp-plain');
    const login = await c.post('/auth/login', demoLogin);
    status(login, 200, 'one-step login again');
    eq(login.json.requiresTwoFactor, undefined, 'no challenge');
    eq(login.json.user.twoFactorEnabled, false, 'flag off on login');
    status(await c.get('/auth/me'), 200, 'cookie set');
    status(await c.post('/auth/logout'), 204, 'logout');
    // disable with an authenticator code
    const again = await y.post('/auth/2fa/setup');
    status(await y.post('/auth/2fa/enable', { code: totp(again.json.secret) }), 200, 'on again');
    status(await y.post('/auth/2fa/disable', { code: demoCode(again.json.secret) }), 204, 'disable with a code');
    eq((await y.get('/auth/2fa')).json.enabled, false, 'off again');
    status(await y.post('/auth/logout'), 204, 'logout');
  });
  await check('Admin reset: 403 for non-admins and demo administrators, 400 for own account, 404 unknown; a real admin needs a fresh code, and the person gets a setup code and is signed out everywhere', async () => {
    const secret = tfaSecret; // still on (release 1.4: it cannot be turned off)
    const c = new Client(base, 'totp-second');
    const step1 = await c.post('/auth/login', tfaLogin);
    status(await c.post('/auth/login/2fa', { challengeToken: step1.json.challengeToken, code: code(secret) }), 200, 'second device signed in');
    status(await rep.post(`/users/${tfaUserId}/2fa/reset`), 403, 'rep cannot reset');
    status(await leader.post(`/users/${tfaUserId}/2fa/reset`), 403, 'leader cannot reset');
    const demo = await admin.post(`/users/${tfaUserId}/2fa/reset`);
    status(demo, 403, 'the demo administrator cannot reset anyone (trial mode)');
    eq(demo.json.details?.code, 'demo_account', 'demo refusal');
    await signInOwner();
    status(await owner.post(`/users/${ownerId}/2fa/reset`, { code: ownerCode() }), 400, 'admin cannot reset their own via this route');
    status(await owner.post('/users/99999/2fa/reset', { code: ownerCode() }), 404, 'unknown user');
    status(await owner.post(`/users/${tfaUserId}/2fa/reset`, {}), 400, 'a real admin needs a fresh code');
    status(await owner.post(`/users/${tfaUserId}/2fa/reset`, { code: '000000' }), 400, 'a wrong code');
    const reset = await owner.post(`/users/${tfaUserId}/2fa/reset`, { code: ownerCode() });
    status(reset, 200, 'reset');
    ok(typeof reset.json.setupCode === 'string' && typeof reset.json.expiresAt === 'string', 'a one-time setup code to hand over');
    status(await tfaUser.get('/auth/me'), 401, 'signed out everywhere (1)');
    status(await c.get('/auth/me'), 401, 'signed out everywhere (2)');
    eq(get<Json>(db, `SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?`, [tfaUserId])!.n, 0, 'no sessions left');
    const row = tfaDbRow();
    ok(row.s === null && row.p === null && row.e === null, 'secret columns cleared');
    eq(recoveryRows(), 0, 'recovery codes deleted');
    eq((await tfaUser.post('/auth/login', tfaLogin)).json.requiresSetupCode, true, 'email and ID alone are not enough after a reset');
    const login = await tfaUser.post('/auth/login', { ...tfaLogin, setupCode: reset.json.setupCode });
    status(login, 200, 'one-step login again with the setup code');
    eq(login.json.user.twoFactorEnabled, false, 'flag off');
    eq(login.json.user.twoFactorSetupRequired, true, 'release 1.4: set it up again before carrying on');
    status(await admin.get('/auth/me'), 200, 'admin session intact');
    resetLoginFailures();
  });
  await check('Code limiters: 6 wrong codes exhaust the challenge (410) and lock the source (429); another address is unaffected; wrong codes count for the login limiter', async () => {
    resetCodeFailures();
    resetLoginFailures();
    const { secret } = await enable2fa(tfaUser);
    const c = new Client(base, 'totp-brute');
    const step1 = await c.post('/auth/login', tfaLogin);
    status(step1, 200, 'challenge');
    const token = step1.json.challengeToken;
    for (let i = 1; i <= 6; i++) status(await c.post('/auth/login/2fa', { challengeToken: token, code: wrongCode(secret) }), 401, `wrong code ${i}`);
    eq(get<Json>(db, `SELECT attempts FROM two_factor_challenges WHERE token = ?`, [token])!.attempts, 6, 'six attempts recorded on the challenge');
    const exhausted = await c.post('/auth/login/2fa', { challengeToken: token, code: wrongCode(secret) });
    status(exhausted, 410, '7th attempt on the same challenge → 410 (challenge consumed)');
    ok(/start again/.test(exhausted.json.error), `message (${exhausted.json.error})`);
    eq(get<Json>(db, `SELECT COUNT(*) AS n FROM two_factor_challenges WHERE token = ?`, [token])!.n, 0, 'exhausted challenge deleted');
    const token2 = (await c.post('/auth/login', tfaLogin)).json.challengeToken as string;
    const locked = await c.post('/auth/login/2fa', { challengeToken: token2, code: code(secret) });
    status(locked, 429, 'fresh challenge, right code: this source is locked after 6 failures');
    ok(/^Too many attempts, try again in \d+ minutes?$/.test(locked.json.error), `error text (${locked.json.error})`);
    status(await tfaUser.post('/auth/2fa/recovery-codes', { code: code(secret) }), 429, 'settings endpoints share the per-source limiter');
    status(await tfaUser.post('/auth/2fa/disable', { code: code(secret) }), 409, 'disable is refused anyway (release 1.4: required)');
    // the real person on another device (another source address) is not locked out by a stranger's guesses
    const other = new Client(base, 'totp-other-device', '127.0.0.2');
    const token3 = (await other.post('/auth/login', tfaLogin)).json.challengeToken as string;
    status(await other.post('/auth/login/2fa', { challengeToken: token3, code: code(secret) }), 200, 'another address signs in with the right code');
    status(await other.post('/auth/logout'), 204, 'logout');
    // the six wrong codes count as failed sign-ins for this source+email: two more bad logins exhaust the 8 → 429 at step one
    status(await anon.post('/auth/login', { email: tfa.email, employeeId: 'LM-9998' }), 401, 'bad credentials 7');
    status(await anon.post('/auth/login', { email: tfa.email, employeeId: 'LM-9997' }), 401, 'bad credentials 8');
    status(await anon.post('/auth/login', tfaLogin), 429, 'login step one locked by the combined count');
    resetCodeFailures();
    resetLoginFailures();
    status(await c.post('/auth/login/2fa', { challengeToken: token2, code: code(secret) }), 200, 'right code once the window passes');
    status(await c.post('/auth/logout'), 204, 'logout');
    tfaSecret = secret;
  });
  await check('Expired challenge → 410 and deleted; housekeeping purges expired rows; unknown user state handled', async () => {
    const c = new Client(base, 'totp-expired');
    const token = (await c.post('/auth/login', tfaLogin)).json.challengeToken as string;
    run(db, `UPDATE two_factor_challenges SET expires_at = ? WHERE token = ?`, [new Date(Date.now() - 1000).toISOString(), token]);
    const r = await c.post('/auth/login/2fa', { challengeToken: token, code: totp(tfaSecret) });
    status(r, 410, 'expired');
    ok(/expired/i.test(r.json.error), `message (${r.json.error})`);
    eq(get<Json>(db, `SELECT COUNT(*) AS n FROM two_factor_challenges WHERE token = ?`, [token])!.n, 0, 'expired challenge deleted on use');
    const token2 = (await c.post('/auth/login', tfaLogin)).json.challengeToken as string;
    run(db, `UPDATE two_factor_challenges SET expires_at = ? WHERE token = ?`, [new Date(Date.now() - 1000).toISOString(), token2]);
    ok(purgeExpiredChallenges(db) >= 1, 'purge removes expired challenges');
    eq(get<Json>(db, `SELECT COUNT(*) AS n FROM two_factor_challenges WHERE user_id = ?`, [tfaUserId])!.n, 0, 'none left for the user');
    const live = (await c.post('/auth/login', tfaLogin)).json.challengeToken as string;
    ok(get<Json>(db, `SELECT expires_at AS e FROM two_factor_challenges WHERE token = ?`, [live])!.e > new Date(Date.now() + 4 * 60_000).toISOString(), 'fresh challenge lives ~5 minutes');
    status(await c.post('/auth/login/2fa', { challengeToken: live, code: code(tfaSecret) }), 200, 'fresh challenge works');
    status(await c.post('/auth/logout'), 204, 'logout');
    // Release 1.4: the account cannot switch it off; the admin reset leaves it off (it sets it up at its next sign-in)
    status(await owner.post(`/users/${tfaUserId}/2fa/reset`, { code: ownerCode() }), 200, 'leave 2FA off (admin reset)');
    eq((await anon.get('/auth/demo-accounts')).json.accounts.length, 4, 'demo accounts untouched (2FA off for all four)');
    eq(get<Json>(db, `SELECT COUNT(*) AS n FROM users WHERE totp_enabled_at IS NOT NULL AND id <> ?`, [ownerId])!.n, 0, 'no user but the real owner has 2FA on');
  });
  await check('Schema upgrade: a first-release database gains every later column, index and the rate backfill on createSchema (idempotent, rows kept)', async () => {
    const legacySql = SCHEMA_SQL
      .replace(/  city TEXT,\n  totp_secret_enc TEXT,\n  totp_pending_enc TEXT,\n  totp_enabled_at TEXT,\n  totp_last_counter INTEGER\n/, '  city TEXT\n')
      .replace(/CREATE TABLE IF NOT EXISTS (recovery_codes|two_factor_challenges) \([\s\S]*?\);\n/g, '')
      .replace(/CREATE INDEX IF NOT EXISTS idx_recovery_codes_user[^\n]*\n/, '')
      .replace(/ CHECK \([^)]*\)/g, '') // the first release had no CHECK constraints on the gauges
      .replace(/  payout_per_sale REAL,\n  commission_per_sale REAL,\n/, '')
      .replace(/  reference TEXT NOT NULL UNIQUE,\n  adjusted_at TEXT,\n/, '  reference TEXT NOT NULL UNIQUE,\n')
      .replace(/CREATE INDEX IF NOT EXISTS idx_events_campaign[^\n]*\n/, '');
    const gaugeDdl = /CREATE TABLE IF NOT EXISTS gauge_entries \(([\s\S]*?)\);/.exec(legacySql)![1]!;
    ok(!/totp|recovery_codes|two_factor|adjusted_at|CHECK|idx_events_campaign/.test(legacySql) && !/per_sale/.test(gaugeDdl), 'legacy DDL has none of the later objects');
    const legacy = openDb(path.join(dir, 'legacy.sqlite'));
    legacy.exec(legacySql);
    run(legacy, `INSERT INTO pay_plans (name, position, base_per_day, commission_per_sale) VALUES ('Legacy', 'trainee', 80, 25)`);
    run(legacy, `INSERT INTO users (employee_id, email, first_name, last_name, role, position, team_id, pay_plan_id, start_date, status, phone, avatar_color, city) VALUES ('LM-0001', 'a@b.c', 'A', 'B', 'admin', 'owner', NULL, 1, ?, 'active', NULL, '#000000', NULL)`, [today]);
    run(legacy, `INSERT INTO teams (name, leader_id, color) VALUES ('T', NULL, '#111111')`);
    run(legacy, `INSERT INTO campaigns (name, code, sector, type, payout_per_sale, rep_commission_per_sale, color, active, start_date) VALUES ('C', 'CC', 'charity', 'fundraising', 120, 45, '#222222', 1, ?)`, [today]);
    run(legacy, `INSERT INTO events (campaign_id, team_id, name, venue, city, type, date, start_time, end_time, status) VALUES (1, 1, 'E', 'V', 'M', 'retail', ?, '09:00', '17:00', 'completed')`, [addDays(today, -1)]);
    run(legacy, `INSERT INTO gauge_entries (event_id, user_id, date, stops, table_count, presentations, closes, taps, sales, submitted_at) VALUES (1, 1, ?, 50, 20, 10, 4, 3, 3, ?)`, [addDays(today, -1), new Date().toISOString()]);
    run(legacy, `INSERT INTO payroll_runs (user_id, week_start, week_end, days_worked, sales, gross, due_date, status, reference) VALUES (1, ?, ?, 1, 3, 155, ?, 'pending', 'PAY-LEGACY')`, [mondayOf(today), sundayOf(today), addDays(sundayOf(today), 5)]);
    ok(!tableColumns(legacy, 'users').includes('totp_secret_enc') && !tableColumns(legacy, 'gauge_entries').includes('payout_per_sale') && !tableColumns(legacy, 'payroll_runs').includes('adjusted_at'), 'legacy tables lack the columns');
    const tables = () => all<{ name: string }>(legacy, `SELECT name FROM sqlite_master WHERE type = 'table'`).map((t) => t.name);
    const indexes = () => all<{ name: string }>(legacy, `SELECT name FROM sqlite_master WHERE type = 'index'`).map((t) => t.name);
    ok(!tables().includes('recovery_codes') && !indexes().includes('idx_events_campaign'), 'legacy has no recovery_codes table and no campaign index');
    const added = createSchema(legacy);
    // core columns only: release 1.2 extensions report their own changes as `<extension>:<name>` (db/extensions)
    eq(added.filter((n) => !n.includes(':')).join(','), 'users.totp_secret_enc,users.totp_pending_enc,users.totp_enabled_at,users.totp_last_counter,gauge_entries.payout_per_sale,gauge_entries.commission_per_sale,payroll_runs.adjusted_at', 'columns added');
    ok(tableColumns(legacy, 'users').includes('totp_last_counter') && tableColumns(legacy, 'payroll_runs').includes('adjusted_at'), 'columns present');
    ok(tables().includes('recovery_codes') && tables().includes('two_factor_challenges'), 'tables created');
    ok(indexes().includes('idx_events_campaign'), 'idx_events_campaign created');
    const u = get<Json>(legacy, `SELECT email, totp_secret_enc AS s, totp_enabled_at AS e, totp_last_counter AS c FROM users WHERE id = 1`)!;
    ok(u.email === 'a@b.c' && u.s === null && u.e === null && u.c === null, 'existing user row kept with null 2FA columns');
    const g = get<Json>(legacy, `SELECT payout_per_sale AS p, commission_per_sale AS c, stops FROM gauge_entries WHERE id = 1`)!;
    eq(g.p, 120, 'gauge payout backfilled from the campaign');
    eq(g.c, 25, "gauge commission backfilled from the person's plan");
    eq(g.stops, 50, 'gauge row kept');
    eq(get<Json>(legacy, `SELECT adjusted_at AS a, gross FROM payroll_runs WHERE id = 1`)!.a, null, 'payroll row kept, adjusted_at null');
    eq(createSchema(legacy).length, 0, 'second run adds nothing');
    legacy.close();
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

// Before any check: the extra loopback addresses the smoke test sends from as other devices (a Mac has only 127.0.0.1).
const missingAddresses = await missingLocalAddresses(['127.0.0.2', '127.0.0.3']);
if (missingAddresses.length) {
  console.error(missingAddressesMessage(missingAddresses));
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
