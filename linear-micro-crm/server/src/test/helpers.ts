/**
 * Route-test harness (p1 foundation; every package's server/src/test/<name>.test.ts uses it).
 *
 *   const srv = await startTestServer();            // ':memory:' + createSchema + the small fixture below
 *   const srv = await startTestServer({ seed: true }); // ':memory:' + the full demo seed (dates shift with today)
 *   const rep = await srv.login('rep');              // cookie client: rep.get('/me/insights') → { status, json, headers }
 *   ...
 *   await srv.close();
 *
 * Fixture (seed: false): 2 teams (A, B), an admin (owner, no team), a leader of team A, 2 reps on team A, 1 rep on
 * team B, a recruiter, five pay plans, one campaign, and per team a completed event yesterday, a live event today
 * (00:00–23:59, so gauges can be logged at any time of day) and a scheduled event tomorrow. No gauges, no payroll:
 * build what a test needs with addEvent / addGauge / addHistory. Assert shapes and scoping, not seeded names.
 *
 * Every server gets a fresh response cache and login limiter; the app secret goes to a temp folder (never
 * server/data). Run with the server test script (TZ=Europe/London). Node runs each test file in its own process.
 *
 * Release 1.3 (r3-foundation): `srv.login('client')` signs in a client portal account — the seeded demo client (Hannah
 * Price, Breast Cancer Now, CL-0001, no PIN: the demo client is exempt from the client PIN rule) with `seed: true`;
 * with the fixture, a client of the fixture campaign (cleo.client@fixture.test, CL-0001, PIN FIXTURE_ACCOUNTS.client.pin
 * — an invited client has a PIN once P6 requires one) created on first use, so no other test sees an extra user. The
 * fixture writes no demo-client marker, so cleo is never "the demo client". addClientUser(db, …) adds more client
 * accounts (with `pinHash`, or addClientUserWithPin, for one that has a PIN).
 *
 * Release 1.4 (package S): two-step verification is required for every account except the demo sign-in accounts while
 * the database is still the demo (lib/demoTeams.ts isDemoSignInAccount). So `srv.login(…)` first sets it up for an
 * account that must have it and has not (enrolTwoFactor: a fresh secret, encrypted, straight into the users row), and
 * answers the code step with a current code (currentCode). The fixture's accounts are not demo accounts, so they all
 * sign in with a code; the demo seed's accounts do not. `srv.login(who, pin, { twoFactor: false })` signs in as the
 * account stands: one without two-step then meets the setup gate (403 twoFactorSetupRequired) like a real person.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { EventStatus, EventType, GaugeTotals, Role } from '@lm/shared';
import { createApp } from '../app.ts';
import { get, openDb, run, type Db } from '../db/connection.ts';
import { createSchema } from '../db/schema.ts';
import { seed as seedDemo, type SeedOptions } from '../db/seed.ts';
import { bumpDataVersion, clearResponseCache } from '../lib/cache.ts';
import { clientPayPlanId, nextClientAccessCode } from '../lib/client.ts';
import { configureAppSecret, decrypt, encrypt } from '../lib/crypto.ts';
import { addDays, mondayOf, setBusinessClock, todayISO } from '../lib/dates.ts';
import { isDemoSignInAccount } from '../lib/demoTeams.ts';
import { hashPin, savePinHash } from '../lib/pin.ts';
import { issueSetupCode } from '../lib/setupCodes.ts';
import { generateSecret, totp } from '../lib/totp.ts';
import { resetCodeFailures } from '../lib/twofactor.ts';
import { resetLoginFailures } from '../routes/auth.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = any;

export interface TestResponse {
  status: number;
  json: Json;
  headers: Headers;
}

export interface Credentials {
  email: string;
  employeeId: string;
  /** Release 1.2 (U1): the sign-in PIN, sent only when given. */
  pin?: string;
}

/** A tiny fetch client that keeps the session cookie (lm_session) between calls. Paths are relative to /api. */
export class TestClient {
  readonly base: string;
  cookie = '';

  constructor(base: string) {
    this.base = base;
  }

  async req(method: string, url: string, body?: unknown): Promise<TestResponse> {
    const res = await fetch(this.base + url, {
      method,
      headers: { 'content-type': 'application/json', ...(this.cookie ? { cookie: this.cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    // The last lm_session cookie wins, as in a browser (release 1.4: a sign-in over a session that just ended clears the
    // old cookie and sets the new one in the same answer).
    const session = res.headers.getSetCookie().filter((c) => c.startsWith('lm_session=')).at(-1);
    if (session !== undefined) {
      const m = /lm_session=([^;]*)/.exec(session);
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
  /** Release 1.2 (e.g. PUT /pitches/:campaignCode, PUT /auth/security-settings). */
  put = (url: string, body?: unknown) => this.req('PUT', url, body);
  del = (url: string) => this.req('DELETE', url);
}

/**
 * A fixed business day for tests whose answer would otherwise depend on the real date: the demo seed's content (its
 * pipeline, change log and dates of birth come out differently from day to day) and dates written out in full in a
 * test. Wednesday 21 Oct 2026, 15:00 in London. Call pinBusinessClock() at the top of the test file, before anything
 * reads the clock. The business clock keeps ticking from there; sign-in, sessions and two-step codes stay on the real
 * clock, as they do in the app.
 */
export const FIXED_BUSINESS_NOW = '2026-10-21T15:00:00';

export function pinBusinessClock(at: string = FIXED_BUSINESS_NOW): void {
  setBusinessClock(new Date(at)); // local time: the server test script runs with TZ=Europe/London
}

/** The four demo accounts of the full seed (`seed: true`). */
export const DEMO_ACCOUNTS = {
  admin: { email: 'morgan.blake@linearhub.example', employeeId: 'LM-0001' },
  leader: { email: 'amelia.hart@linearhub.example', employeeId: 'LM-0002' },
  recruiter: { email: 'priya.shah@linearhub.example', employeeId: 'LM-0003' },
  rep: { email: 'jordan.lee@linearhub.example', employeeId: 'LM-0010' },
  /** Release 1.3: the demo client portal account (Breast Cancer Now). */
  client: { email: 'hannah.price@breastcancernow.example', employeeId: 'CL-0001' },
} as const satisfies Record<string, Credentials>;

export type DemoRole = keyof typeof DEMO_ACCOUNTS;

/** Fixture accounts (`seed: false`). `rep` is the first rep on team A. */
export const FIXTURE_ACCOUNTS = {
  admin: { email: 'ada.admin@fixture.test', employeeId: 'FX-0001' },
  leader: { email: 'lee.leader@fixture.test', employeeId: 'FX-0002' },
  recruiter: { email: 'rae.recruiter@fixture.test', employeeId: 'FX-0003' },
  rep: { email: 'remy.rep@fixture.test', employeeId: 'FX-0004' },
  repA2: { email: 'rita.rep@fixture.test', employeeId: 'FX-0005' },
  repB: { email: 'bo.rep@fixture.test', employeeId: 'FX-0006' },
  /**
   * Release 1.3: a client portal account of the fixture campaign — created on the first login('client'), with this PIN
   * (sent on every login('client')), so the fixture keeps signing in once P6 makes a PIN required for client accounts.
   */
  client: { email: 'cleo.client@fixture.test', employeeId: 'CL-0001', pin: '5821' },
} as const satisfies Record<string, Credentials>;

export type FixtureAccount = keyof typeof FIXTURE_ACCOUNTS;

export interface Fixture {
  today: string;
  teams: { a: number; b: number };
  plans: { rep: number; trainee: number; leader: number; owner: number; recruiter: number };
  campaignId: number;
  users: { admin: number; leader: number; recruiter: number; rep: number; repA2: number; repB: number };
  events: { yesterdayA: number; todayA: number; tomorrowA: number; yesterdayB: number; todayB: number; tomorrowB: number };
  accounts: typeof FIXTURE_ACCOUNTS;
}

export interface EventInput {
  campaignId: number;
  teamId: number;
  date: string;
  status?: EventStatus;
  type?: EventType;
  startTime?: string;
  endTime?: string;
  targetSales?: number;
  name?: string;
}

/** Insert an event directly (no route rules). Default: a completed 09:00–17:00 private site with a target of 10. */
export function addEvent(db: Db, e: EventInput): number {
  return run(
    db,
    `INSERT INTO events (campaign_id, team_id, name, venue, city, type, date, start_time, end_time, status, target_sales, notes)
     VALUES (?, ?, ?, 'Test Venue', 'Manchester', ?, ?, ?, ?, ?, ?, NULL)`,
    [e.campaignId, e.teamId, e.name ?? `Fixture event ${e.date}`, e.type ?? 'private_site', e.date, e.startTime ?? '09:00', e.endTime ?? '17:00', e.status ?? 'completed', e.targetSales ?? 10],
  ).lastInsertRowid;
}

export type GaugeInput = { eventId: number; userId: number; date: string; checkedInAt?: string | null; submittedAt?: string } & Pick<GaugeTotals, 'stops' | 'sales'> &
  Partial<GaugeTotals>;

/** A valid funnel from stops and sales: the middle stages default to typical ratios, clamped so the funnel holds. */
export function funnelFrom(stops: number, sales: number, partial: Partial<GaugeTotals> = {}): GaugeTotals {
  const table = partial.table ?? Math.min(stops, Math.max(sales, Math.round(stops * 0.35)));
  const presentations = partial.presentations ?? Math.min(table, Math.max(sales, Math.round(table * 0.5)));
  const closes = partial.closes ?? Math.min(presentations, Math.max(sales, Math.round(presentations * 0.4)));
  const taps = partial.taps ?? Math.min(closes, Math.max(sales, Math.round(closes * 0.6)));
  return { stops, table, presentations, closes, taps, sales };
}

/** Insert a gauge row directly (no route rules, no payroll sync). The event's date should equal `date`. */
export function addGauge(db: Db, g: GaugeInput): number {
  const t = funnelFrom(g.stops, g.sales, g);
  return run(
    db,
    `INSERT INTO gauge_entries (event_id, user_id, date, stops, table_count, presentations, closes, taps, sales, checked_in_at, notes, submitted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    [g.eventId, g.userId, g.date, t.stops, t.table, t.presentations, t.closes, t.taps, t.sales, g.checkedInAt ?? null, g.submittedAt ?? `${g.date}T18:00:00.000Z`],
  ).lastInsertRowid;
}

export interface HistoryInput {
  userId: number;
  teamId: number;
  campaignId: number;
  /** Completed weeks before this Monday to fill (newest last). */
  weeks: number;
  /** Worked days per week, from Monday (default 4). */
  daysPerWeek?: number;
  /** Per worked day; a function gets the week index (0 = oldest) and the day index. */
  stops: number | ((week: number, day: number) => number);
  sales: number | ((week: number, day: number) => number);
  today?: string;
}

/**
 * Fill `weeks` completed Mon–Sun weeks of history for one person: one completed event per (team, date) — shared with
 * anyone else filled on the same dates — and one gauge row per worked day. Returns the dates written.
 */
export function addHistory(db: Db, h: HistoryInput): string[] {
  const today = h.today ?? todayISO();
  const first = addDays(mondayOf(today), -7 * h.weeks);
  const days = h.daysPerWeek ?? 4;
  const val = (v: HistoryInput['stops'], w: number, d: number) => (typeof v === 'function' ? v(w, d) : v);
  const dates: string[] = [];
  for (let w = 0; w < h.weeks; w++) {
    for (let d = 0; d < days; d++) {
      const date = addDays(first, 7 * w + d);
      const existing = get<{ id: number }>(db, `SELECT id FROM events WHERE team_id = ? AND campaign_id = ? AND date = ? ORDER BY id LIMIT 1`, [h.teamId, h.campaignId, date]);
      const eventId = existing?.id ?? addEvent(db, { campaignId: h.campaignId, teamId: h.teamId, date });
      addGauge(db, { eventId, userId: h.userId, date, stops: val(h.stops, w, d), sales: val(h.sales, w, d) });
      dates.push(date);
    }
  }
  return dates;
}

export interface ClientUserInput {
  campaignId: number;
  email?: string;
  /** The access code (default: the next free CL-xxxx from lib/client.ts nextClientAccessCode, never a demo code). */
  employeeId?: string;
  firstName?: string;
  lastName?: string;
  status?: 'active' | 'left';
  /** A PIN hash from lib/pin.ts hashPin (default: no PIN). addClientUserWithPin hashes one for you. */
  pinHash?: string;
}

/**
 * Release 1.3: insert a client portal account directly (role and position 'client', no team, the owner's pay plan),
 * as P6's invite will. Returns its id. Never a demo client: only the demo seed writes that marker.
 */
export function addClientUser(db: Db, c: ClientUserInput): number {
  const code = c.employeeId ?? nextClientAccessCode(db);
  const id = run(
    db,
    `INSERT INTO users (employee_id, email, first_name, last_name, role, position, team_id, pay_plan_id, start_date, status, phone, avatar_color, city, client_campaign_id)
     VALUES (?, ?, ?, ?, 'client', 'client', NULL, ?, ?, ?, NULL, '#BE185D', NULL, ?)`,
    [code, c.email ?? `${code.toLowerCase()}@client.test`, c.firstName ?? 'Cleo', c.lastName ?? 'Client', clientPayPlanId(db), todayISO(), c.status ?? 'active', c.campaignId],
  ).lastInsertRowid;
  if (c.pinHash) savePinHash(db, id, c.pinHash);
  return id;
}

/** Release 1.3: addClientUser with a sign-in PIN (hashed with the test server's app secret). */
export async function addClientUserWithPin(db: Db, c: Omit<ClientUserInput, 'pinHash'>, pin: string): Promise<number> {
  return addClientUser(db, { ...c, pinHash: await hashPin(pin) });
}

/** The small, date-relative fixture described at the top of this file. */
export function buildFixture(db: Db, today: string = todayISO()): Fixture {
  const plan = (name: string, position: string, base: number, commission: number, threshold: number, bonus: number, override: number) =>
    run(
      db,
      `INSERT INTO pay_plans (name, position, base_per_day, commission_per_sale, bonus_threshold, bonus_amount, override_per_team_sale) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [name, position, base, commission, threshold, bonus, override],
    ).lastInsertRowid;
  const plans = {
    rep: plan('Field rep', 'field_rep', 60, 45, 12, 75, 0),
    trainee: plan('Trainee', 'trainee', 50, 40, 10, 50, 0),
    leader: plan('Team leader', 'team_leader', 80, 45, 12, 75, 5),
    owner: plan('Owner', 'owner', 0, 0, 0, 0, 2),
    recruiter: plan('Recruiter', 'recruiter', 90, 0, 2, 100, 0),
  };
  const a = run(db, `INSERT INTO teams (name, leader_id, color) VALUES ('Team A', NULL, '#2563EB')`).lastInsertRowid;
  const b = run(db, `INSERT INTO teams (name, leader_id, color) VALUES ('Team B', NULL, '#16A34A')`).lastInsertRowid;
  const start = addDays(mondayOf(today), -52 * 7);
  const user = (acc: Credentials, first: string, last: string, role: string, position: string, teamId: number | null, planId: number) =>
    run(
      db,
      `INSERT INTO users (employee_id, email, first_name, last_name, role, position, team_id, pay_plan_id, start_date, status, phone, avatar_color, city)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', NULL, '#4F46E5', 'Manchester')`,
      [acc.employeeId, acc.email, first, last, role, position, teamId, planId, start],
    ).lastInsertRowid;
  const users = {
    admin: user(FIXTURE_ACCOUNTS.admin, 'Ada', 'Admin', 'admin', 'owner', null, plans.owner),
    leader: user(FIXTURE_ACCOUNTS.leader, 'Lee', 'Leader', 'leader', 'team_leader', a, plans.leader),
    recruiter: user(FIXTURE_ACCOUNTS.recruiter, 'Rae', 'Recruiter', 'recruiter', 'recruiter', null, plans.recruiter),
    rep: user(FIXTURE_ACCOUNTS.rep, 'Remy', 'Rep', 'rep', 'field_rep', a, plans.rep),
    repA2: user(FIXTURE_ACCOUNTS.repA2, 'Rita', 'Rep', 'rep', 'field_rep', a, plans.rep),
    repB: user(FIXTURE_ACCOUNTS.repB, 'Bo', 'Rep', 'rep', 'field_rep', b, plans.rep),
  };
  run(db, `UPDATE teams SET leader_id = ? WHERE id = ?`, [users.leader, a]);
  const campaignId = run(
    db,
    `INSERT INTO campaigns (name, code, sector, type, payout_per_sale, rep_commission_per_sale, color, active, start_date, description)
     VALUES ('Fixture Charity', 'FXC', 'charity', 'fundraising', 120, 45, '#DB2777', 1, ?, NULL)`,
    [start],
  ).lastInsertRowid;
  const ev = (teamId: number, date: string, status: EventStatus, times: [string, string] = ['09:00', '17:00']) =>
    addEvent(db, { campaignId, teamId, date, status, startTime: times[0], endTime: times[1], name: `${teamId === a ? 'Team A' : 'Team B'} ${date}` });
  const yesterday = addDays(today, -1);
  const tomorrow = addDays(today, 1);
  const events = {
    yesterdayA: ev(a, yesterday, 'completed'),
    todayA: ev(a, today, 'live', ['00:00', '23:59']),
    tomorrowA: ev(a, tomorrow, 'scheduled'),
    yesterdayB: ev(b, yesterday, 'completed'),
    todayB: ev(b, today, 'live', ['00:00', '23:59']),
    tomorrowB: ev(b, tomorrow, 'scheduled'),
  };
  run(db, `INSERT INTO meta (key, value) VALUES ('seeded_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [new Date().toISOString()]);
  return { today, teams: { a, b }, plans, campaignId, users, events, accounts: FIXTURE_ACCOUNTS };
}

export interface StartOptions {
  /** true → the full demo seed; false (default) → buildFixture. */
  seed?: boolean;
  /** Business date for the seed / fixture (default: today). The server itself always uses the real clock. */
  today?: string;
  /** Release 1.3.1: options for the demo seed (with `seed: true`), e.g. `{ demoClients: false }` for a 1.2-shaped demo. */
  seedOptions?: SeedOptions;
}

export interface LoginOptions {
  /**
   * Release 1.4: false → do not set up two-step verification for an account that has none (it then meets the setup
   * gate). The code step is still answered when the account already has it on.
   */
  twoFactor?: boolean;
}

/**
 * Release 1.4: switch two-step verification on for a person directly (a fresh secret, encrypted with the test app
 * secret, no recovery codes) — what finishing the Settings setup leaves in the users row. Returns the secret.
 */
export function enrolTwoFactor(db: Db, userId: number): string {
  const secret = generateSecret();
  run(db, `UPDATE users SET totp_secret_enc = ?, totp_pending_enc = NULL, totp_enabled_at = ?, totp_last_counter = NULL WHERE id = ?`, [
    encrypt(secret), new Date().toISOString(), userId,
  ]);
  return secret;
}

/**
 * Release 1.4: a current authenticator code for a person with two-step on. Codes are single use per 30-second step, so
 * this forgets the last accepted step first: a test may sign the same person in several times within one step.
 */
export function currentCode(db: Db, userId: number): string {
  const row = get<{ s: string | null }>(db, `SELECT totp_secret_enc AS s FROM users WHERE id = ?`, [userId]);
  if (!row?.s) throw new Error(`user ${userId} has no two-step secret`);
  run(db, `UPDATE users SET totp_last_counter = NULL WHERE id = ?`, [userId]);
  return totp(decrypt(row.s));
}

/**
 * Release 1.4: the whole sign-in on any TestClient (also one pointed at a second app on the same database): sets up
 * two-step verification first for an account that must use it (unless `twoFactor: false`), posts the credentials (and
 * PIN), and answers the code step with a current code when asked. Returns the last answer, whatever its status.
 */
export async function signInWith(db: Db, client: TestClient, creds: Credentials, opts: LoginOptions = {}): Promise<TestResponse> {
  const user = get<{ id: number; role: Role; email: string; employeeId: string; status: string; totpOn: number }>(
    db,
    `SELECT id, role, email, employee_id AS employeeId, status, (totp_enabled_at IS NOT NULL) AS totpOn FROM users WHERE lower(email) = lower(?) AND lower(employee_id) = lower(?)`,
    [creds.email, creds.employeeId],
  );
  if (user && opts.twoFactor !== false && user.status !== 'left' && !user.totpOn && !isDemoSignInAccount(db, user)) enrolTwoFactor(db, user.id);
  let r = await client.post('/auth/login', creds);
  // An account still setting up signs in with its one-time setup code (an admin hands one out): give it one here.
  if (r.status === 200 && r.json?.requiresSetupCode === true && user) {
    r = await client.post('/auth/login', { ...creds, setupCode: issueSetupCode(db, user.id, { createdBy: null, reason: 'reissue' }).code });
  }
  if (r.status === 200 && r.json?.requiresTwoFactor === true && user) {
    return client.post('/auth/login/2fa', { challengeToken: r.json.challengeToken, code: currentCode(db, user.id) });
  }
  return r;
}

export interface TestServer {
  db: Db;
  /** e.g. http://127.0.0.1:54321/api */
  base: string;
  /** The fixture ids (null with `seed: true`). */
  fixture: Fixture | null;
  /**
   * Sign in by role / fixture account name, or with explicit credentials; throws unless the login answers 200.
   * Release 1.2: `pin` (or `who.pin`) is sent as the sign-in PIN; without one the body is exactly as before.
   * Release 1.4: an account that must use two-step verification gets it set up first (unless `twoFactor: false`), and
   * the code step is answered with a current code whenever the server asks for one.
   */
  login(who: DemoRole | FixtureAccount | Credentials, pin?: string, opts?: LoginOptions): Promise<TestClient>;
  /** A client without a session. */
  anon(): TestClient;
  /** Forget cached aggregates (e.g. after writing rows directly with addGauge, or flipping LM_SMART). */
  resetCache(): void;
  close(): Promise<void>;
}

export async function startTestServer(opts: StartOptions = {}): Promise<TestServer> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'linear-test-'));
  configureAppSecret(path.join(dir, 'app-secret')); // never touch server/data/app-secret
  const db = openDb(':memory:');
  createSchema(db);
  const today = opts.today ?? todayISO();
  const fixture = opts.seed ? (seedDemo(db, today, opts.seedOptions), null) : buildFixture(db, today);
  clearResponseCache();
  bumpDataVersion();
  resetLoginFailures();
  resetCodeFailures();

  const server = http.createServer(createApp(db));
  // Release 1.3: idle keep-alive connections stay open until close() (which ends them all). With Node's default (the
  // server drops a socket after 6 s idle: keepAliveTimeout 5 s + keepAliveTimeoutBuffer 1 s, on its own timer) a test
  // step that blocks the event loop for longer — a synchronous demo seed, slower while the other test files run in
  // parallel — let the server's close and the next request on that pooled socket meet: "fetch failed" (ECONNRESET /
  // other side closed), depending on test order and machine load. See harness.test.ts.
  server.keepAliveTimeout = 0;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;

  const credentials = (who: DemoRole | FixtureAccount | Credentials): Credentials => {
    if (typeof who !== 'string') return who;
    if (opts.seed) {
      if (!(who in DEMO_ACCOUNTS)) throw new Error(`No demo account "${who}" in the seed`);
      return DEMO_ACCOUNTS[who as DemoRole];
    }
    return FIXTURE_ACCOUNTS[who];
  };

  return {
    db,
    base,
    fixture,
    async login(who, pin, loginOpts = {}) {
      const client = new TestClient(base);
      const creds = credentials(who);
      // Release 1.3: the fixture's client account exists only once a test signs in as it (with its PIN).
      if (who === 'client' && fixture && !get(db, `SELECT 1 FROM users WHERE lower(employee_id) = lower(?)`, [creds.employeeId])) {
        await addClientUserWithPin(db, { campaignId: fixture.campaignId, email: creds.email, employeeId: creds.employeeId }, FIXTURE_ACCOUNTS.client.pin);
      }
      const r = await signInWith(db, client, pin === undefined ? creds : { ...creds, pin }, loginOpts);
      if (r.status !== 200 || !client.cookie) throw new Error(`login ${JSON.stringify(who)} → ${r.status} ${JSON.stringify(r.json)}`);
      return client;
    },
    anon: () => new TestClient(base),
    resetCache() {
      clearResponseCache();
      bumpDataVersion();
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Run `fn` with LM_SMART set to `value` (e.g. '0'), restoring the previous value afterwards. */
export async function withSmart<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.LM_SMART;
  if (value === undefined) delete process.env.LM_SMART;
  else process.env.LM_SMART = value;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.LM_SMART;
    else process.env.LM_SMART = prev;
  }
}
