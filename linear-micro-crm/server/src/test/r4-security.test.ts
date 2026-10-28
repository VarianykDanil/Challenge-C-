/**
 * Release 1.4 — package S (security), end to end. The owner's decisions: two-step verification (authenticator app)
 * for every account that signs in — admin, leader, recruiter, rep and client (charity) accounts — and a sign-out 14
 * hours after sign-in, whatever the activity, with the code asked again at the next sign-in. The demo sign-in
 * accounts (the four staff, team Sapiens, Hannah Price) are exempt from both while the database is still the demo.
 *
 * Sessions run on the real clock: the tests move a session's sign-in time back in the sessions table rather than pin
 * any clock. The fixture (seed: false) is not a demo database, so all of its accounts must use two-step; the helper's
 * srv.login sets it up for them unless asked not to ({ twoFactor: false }).
 */
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { sessionKey } from '../lib/sessionKey.ts';
import { issueSetupCode } from '../lib/setupCodes.ts';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SESSION_MAX_HOURS_DEFAULT, sessionMaxAgeMessage } from '@lm/shared';
import { all, get, openDb, run } from '../db/connection.ts';
import { createSchema } from '../db/schema.ts';
import { MAX_AGE_SIGN_OUT_ACTION } from '../lib/audit/sessions.ts';
import { demoTeamMarkers, isDemoSignInAccount } from '../lib/demoTeams.ts';
import { totp } from '../lib/totp.ts';
import { isWriteLimited } from '../middleware/writeLimit.ts';
import { purgeExpiredSessions } from '../middleware/auth.ts';
import { DEMO_ACCOUNTS, FIXTURE_ACCOUNTS, buildFixture, currentCode, startTestServer, type Credentials, type TestClient, type TestResponse, type TestServer } from './helpers.ts';

const HOUR = 3_600_000;
const MIN = 60_000;

let srv: TestServer | null = null;
afterEach(async () => {
  await srv?.close();
  srv = null;
});

async function start(seed = false): Promise<TestServer> {
  srv = await startTestServer({ seed });
  return srv;
}

const db = () => srv!.db;
const fx = () => srv!.fixture!;
// the sessions table keeps the token's hash (lib/sessionKey.ts)
const tokenOf = (c: TestClient) => sessionKey(c.cookie.replace(/^lm_session=/, ''));

interface UserRow { id: number; role: string; email: string; employeeId: string; status: string }
const userBy = (creds: Credentials): UserRow =>
  get<UserRow>(db(), `SELECT id, role, email, employee_id AS employeeId, status FROM users WHERE lower(email) = lower(?) AND lower(employee_id) = lower(?)`, [creds.email, creds.employeeId])!;
const exempt = (creds: Credentials) => isDemoSignInAccount(db(), userBy(creds));

/** Moves this client's session back: signed in `signedInMs` ago, last request `seenMs` ago (real clock). */
function age(c: TestClient, signedInMs: number, seenMs = 0, expiresInMs?: number): void {
  const now = Date.now();
  const sets = ['created_at = ?', 'last_seen_at = ?'];
  const params: (string | number)[] = [new Date(now - signedInMs).toISOString(), new Date(now - seenMs).toISOString()];
  if (expiresInMs !== undefined) {
    sets.push('expires_at = ?');
    params.push(new Date(now + expiresInMs).toISOString());
  }
  run(db(), `UPDATE sessions SET ${sets.join(', ')} WHERE token = ?`, [...params, tokenOf(c)]);
}

const session = (c: TestClient) =>
  get<{ createdAt: string; expiresAt: string }>(db(), `SELECT created_at AS createdAt, expires_at AS expiresAt FROM sessions WHERE token = ?`, [tokenOf(c)]);
const lifetimeHours = (s: { createdAt: string; expiresAt: string }) => (Date.parse(s.expiresAt) - Date.parse(s.createdAt)) / HOUR;
const maxAgeOf = (r: TestResponse) => Number(/Max-Age=(\d+)/i.exec(r.headers.get('set-cookie') ?? '')?.[1] ?? Number.NaN);
const maxAgeRows = (userId: number) =>
  all<{ kind: string; summary: string; userId: number }>(db(), `SELECT kind, summary, user_id AS userId FROM audit_log WHERE action = ? AND user_id = ?`, [MAX_AGE_SIGN_OUT_ACTION, userId]);

/** The page a signed-in person of this role opens first (a client account: its portal). */
const probeFor = (role: string) => (role === 'client' ? '/client/portal' : '/me/dashboard');

/** Signs in step by step (credentials → PIN → code) and returns the last answer, so a test can read its cookie. */
async function signInSteps(creds: Credentials, pin?: string): Promise<{ client: TestClient; last: TestResponse }> {
  const client = srv!.anon();
  let last = await client.post('/auth/login', pin ? { ...creds, pin } : creds);
  // an account still setting up signs in with the one-time setup code an admin gave
  if (last.status === 200 && last.json?.requiresSetupCode) {
    const setupCode = issueSetupCode(db(), userBy(creds).id, { createdBy: null, reason: 'reissue' }).code;
    last = await client.post('/auth/login', { ...(pin ? { ...creds, pin } : creds), setupCode });
  }
  if (last.status === 200 && last.json?.requiresTwoFactor) {
    last = await client.post('/auth/login/2fa', { challengeToken: last.json.challengeToken, code: currentCode(db(), userBy(creds).id) });
  }
  assert.equal(last.status, 200, JSON.stringify(last.json));
  return { client, last };
}

const STAFF_ROLES = ['admin', 'leader', 'recruiter', 'rep'] as const;
const ROLES = [...STAFF_ROLES, 'client'] as const;

// ───────────────────────────── who is exempt ─────────────────────────────

test('exempt: the demo sign-in accounts (the four, team Sapiens, Hannah Price) while the database is still the demo', async () => {
  await start(true);
  for (const role of ROLES) assert.equal(exempt(DEMO_ACCOUNTS[role]), true, `${role} demo account`);
  const sapiens = demoTeamMarkers(db()).flatMap((m) => m.accounts);
  assert.equal(sapiens.length, 7, 'the seven Sapiens accounts');
  for (const a of sapiens) assert.equal(exempt(a), true, a.employeeId);
  // Anyone else on the demo database is not: a person added by hand, an invited charity contact.
  const admin = await srv!.login('admin');
  const added = await admin.post('/users', {
    employeeId: 'LM-0500', email: 'new.person@example.test', firstName: 'New', lastName: 'Person', role: 'rep', position: 'field_rep',
    teamId: null, payPlanId: get<{ id: number }>(db(), `SELECT id FROM pay_plans WHERE position = 'field_rep' ORDER BY id LIMIT 1`)!.id,
    startDate: '2026-10-01', status: 'active', phone: null, city: 'Manchester',
  });
  assert.equal(added.status, 201, JSON.stringify(added.json));
  assert.equal(exempt({ email: 'new.person@example.test', employeeId: 'LM-0500' }), false, 'a person Matt adds');
  const bcn = get<{ id: number }>(db(), `SELECT id FROM campaigns WHERE code = 'BCN'`)!.id;
  const invite = await admin.post(`/campaigns/${bcn}/client-accounts`, { firstName: 'Ivy', lastName: 'Invited', email: 'ivy@charity.example' });
  assert.equal(invite.status, 201, JSON.stringify(invite.json));
  assert.equal(exempt({ email: 'ivy@charity.example', employeeId: invite.json.accessCode }), false, 'an invited client');
  // A Sapiens account given a real email is no longer the demo one.
  const theo = sapiens.find((a) => a.employeeId === 'LM-0101')!;
  run(db(), `UPDATE users SET email = 'theo.real@example.test' WHERE id = ?`, [theo.id]);
  srv!.resetCache();
  assert.equal(exempt({ email: 'theo.real@example.test', employeeId: 'LM-0101' }), false, 'renamed Sapiens account');
  assert.equal(exempt(DEMO_ACCOUNTS.rep), true, 'the others stay exempt');
});

test('exempt: nobody once the demo database is in real use (a demo person left or changed role)', async () => {
  await start(true);
  run(db(), `UPDATE users SET status = 'left' WHERE employee_id = 'LM-0010'`);
  srv!.resetCache();
  for (const role of ['admin', 'leader', 'recruiter', 'client'] as const) assert.equal(exempt(DEMO_ACCOUNTS[role]), false, role);
  for (const a of demoTeamMarkers(db()).flatMap((m) => m.accounts)) assert.equal(exempt(a), false, a.employeeId);
  run(db(), `UPDATE users SET status = 'active' WHERE employee_id = 'LM-0010'`);
  run(db(), `UPDATE users SET role = 'rep' WHERE employee_id = 'LM-0002'`);
  srv!.resetCache();
  assert.equal(exempt(DEMO_ACCOUNTS.admin), false, 'a demo leader made a rep: in real use');
});

test('exempt: nobody with LM_DEMO_ACCOUNTS=0, nor on a database the demo seed did not build', async () => {
  await start(true);
  const prev = process.env.LM_DEMO_ACCOUNTS;
  process.env.LM_DEMO_ACCOUNTS = '0';
  try {
    srv!.resetCache();
    for (const role of ROLES) assert.equal(exempt(DEMO_ACCOUNTS[role]), false, role);
    // and the gate holds the demo admin until two-step is set up
    const admin = await srv!.login('admin', undefined, { twoFactor: false });
    assert.equal((await admin.get('/auth/me')).json.user.twoFactorSetupRequired, true);
    assert.equal((await admin.get('/me/dashboard')).status, 403);
  } finally {
    if (prev === undefined) delete process.env.LM_DEMO_ACCOUNTS;
    else process.env.LM_DEMO_ACCOUNTS = prev;
  }
  await srv!.close();
  srv = null;
  await start(false);
  for (const name of ['admin', 'leader', 'recruiter', 'rep'] as const) assert.equal(exempt(FIXTURE_ACCOUNTS[name]), false, name);
});

// ───────────────────────────── two-step for everyone ─────────────────────────────

test('every role must set up two-step: the gate holds every API, the client portal too, until it is on', async () => {
  await start();
  for (const role of ROLES) {
    const c = await srv!.login(role, undefined, { twoFactor: false });
    const me = await c.get('/auth/me');
    assert.equal(me.status, 200);
    assert.equal(me.json.user.twoFactorSetupRequired, true, `${role}: setup required`);
    assert.equal(me.json.user.twoFactorEnabled, false);
    const held = await c.get(probeFor(role));
    assert.equal(held.status, 403, `${role}: ${probeFor(role)} held`);
    assert.equal(held.json.twoFactorSetupRequired, true);
    if (role === 'client') assert.equal((await c.get('/client/posts')).status, 403, 'client posts held too');
    const status = await c.get('/auth/2fa');
    assert.equal(status.status, 200, `${role}: two-step status reachable`);
    assert.equal(status.json.enabled, false);
    assert.equal(status.json.required, true);
    const setup = await c.post('/auth/2fa/setup');
    assert.equal(setup.status, 201, `${role}: setup reachable`);
    const on = await c.post('/auth/2fa/enable', { code: totp(setup.json.secret) });
    assert.equal(on.status, 200, `${role}: enable ${JSON.stringify(on.json)}`);
    assert.equal(on.json.recoveryCodes.length, 10);
    assert.equal((await c.get(probeFor(role))).status, 200, `${role}: open once two-step is on`);
    assert.equal((await c.get('/auth/me')).json.user.twoFactorSetupRequired, false);
    if (role === 'client') {
      const office = await c.get('/users');
      assert.equal(office.status, 403, 'still only the client portal');
      assert.equal(office.json.clientPortalOnly, true);
      assert.equal((await c.post('/auth/2fa/recovery-codes', { code: currentCode(db(), userBy(FIXTURE_ACCOUNTS.client).id) })).status, 200, 'new recovery codes');
    }
  }
});

test('a client signs in with email + access code → PIN → code', async () => {
  await start();
  const first = await srv!.login('client'); // creates the fixture client (PIN set) and sets up two-step
  await first.post('/auth/logout');
  const creds = { email: FIXTURE_ACCOUNTS.client.email, employeeId: FIXTURE_ACCOUNTS.client.employeeId };
  const c = srv!.anon();
  const step1 = await c.post('/auth/login', creds);
  assert.equal(step1.status, 200);
  assert.equal(step1.json.requiresPin, true);
  assert.equal(c.cookie, '', 'no session after step one');
  const step2 = await c.post('/auth/login', { ...creds, pin: FIXTURE_ACCOUNTS.client.pin });
  assert.equal(step2.json.requiresTwoFactor, true, JSON.stringify(step2.json));
  assert.equal(c.cookie, '', 'no session after the PIN');
  const step3 = await c.post('/auth/login/2fa', { challengeToken: step2.json.challengeToken, code: currentCode(db(), userBy(creds).id) });
  assert.equal(step3.status, 200);
  assert.equal(step3.json.user.role, 'client');
  assert.ok(c.cookie);
  assert.equal((await c.get('/client/portal')).status, 200);
});

test('every sign-in asks for the code again: no remember-this-device', async () => {
  await start();
  const rep = await srv!.login('rep');
  const creds = { email: FIXTURE_ACCOUNTS.rep.email, employeeId: FIXTURE_ACCOUNTS.rep.employeeId };
  // another device while the first is signed in, then the same device after signing out
  const other = srv!.anon();
  const step = await other.post('/auth/login', creds);
  assert.equal(step.json.requiresTwoFactor, true);
  assert.equal(other.cookie, '');
  await rep.post('/auth/logout');
  const again = await rep.post('/auth/login', creds);
  assert.equal(again.json.requiresTwoFactor, true, 'signing in again asks for the code');
  assert.equal(rep.cookie, '');
});

test('the demo sign-in accounts are exempt: one tap still signs in, nothing held', async () => {
  await start(true);
  const theo = demoTeamMarkers(db()).flatMap((m) => m.accounts).find((a) => a.employeeId === 'LM-0101')!;
  for (const [role, creds] of [...ROLES.map((r) => [r, DEMO_ACCOUNTS[r]] as const), ['leader', theo] as const]) {
    const c = srv!.anon();
    const r = await c.post('/auth/login', { email: creds.email, employeeId: creds.employeeId });
    assert.equal(r.status, 200, `${creds.employeeId}`);
    assert.equal(r.json.requiresTwoFactor, undefined, `${creds.employeeId}: no code step`);
    assert.equal(r.json.user.twoFactorSetupRequired, false, `${creds.employeeId}: no setup step`);
    assert.equal((await c.get(probeFor(role))).status, 200, `${creds.employeeId}: ${probeFor(role)}`);
    assert.equal((await c.get('/auth/2fa')).json.required, false);
  }
});

test('two-step cannot be turned off by an account that must use it; an exempt demo account still can', async () => {
  await start();
  const rep = await srv!.login('rep');
  const id = userBy(FIXTURE_ACCOUNTS.rep).id;
  const off = await rep.post('/auth/2fa/disable', { code: currentCode(db(), id) });
  assert.equal(off.status, 409);
  assert.match(off.json.error, /required for every account/);
  assert.equal((await rep.get('/auth/2fa')).json.enabled, true, 'still on');
  await srv!.close();
  srv = null;

  await start(true);
  const demoRep = await srv!.login('rep');
  const setup = await demoRep.post('/auth/2fa/setup');
  assert.equal((await demoRep.post('/auth/2fa/enable', { code: totp(setup.json.secret) })).status, 200);
  const demoId = userBy(DEMO_ACCOUNTS.rep).id;
  assert.equal((await demoRep.post('/auth/2fa/disable', { code: currentCode(db(), demoId) })).status, 204, 'the demo rep may switch it off again');
});

test('the old "Require two-step for administrators" setting stays readable but no longer decides anything', async () => {
  await start();
  const admin = await srv!.login('admin');
  run(db(), `INSERT INTO meta (key, value) VALUES ('ext:pin:require-admin-2fa', '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
  srv!.resetCache();
  const s = await admin.get('/auth/security-settings');
  assert.equal(s.json.requireAdminTwoFactor, true, 'the stored value is still read');
  const leader = await srv!.login('leader', undefined, { twoFactor: false });
  assert.equal((await leader.get('/auth/me')).json.user.twoFactorSetupRequired, true, 'non-admins need it whatever the switch says');
  run(db(), `UPDATE meta SET value = '0' WHERE key = 'ext:pin:require-admin-2fa'`);
  srv!.resetCache();
  const admin2 = await srv!.login({ email: FIXTURE_ACCOUNTS.admin.email, employeeId: FIXTURE_ACCOUNTS.admin.employeeId });
  run(db(), `UPDATE users SET totp_enabled_at = NULL, totp_secret_enc = NULL WHERE id = ?`, [fx().users.admin]);
  srv!.resetCache();
  assert.equal((await admin2.get('/auth/me')).json.user.twoFactorSetupRequired, true, 'admins need it with the switch off');
});

// ───────────────────────────── 14 hours from sign-in ─────────────────────────────

test('a session lasts 14 hours from sign-in and the cookie matches; the one-tap demo accounts too', async () => {
  await start();
  const { client, last } = await signInSteps(FIXTURE_ACCOUNTS.rep);
  assert.equal(maxAgeOf(last), 14 * 3600, 'cookie Max-Age 14 hours');
  assert.ok(Math.abs(lifetimeHours(session(client)!) - 14) < 0.001, 'expires 14 hours after sign-in');
  const me = await client.get('/auth/me');
  assert.equal(me.json.session.maxHours, 14);
  assert.equal(Date.parse(me.json.session.endsAt) - Date.parse(me.json.session.signedInAt), 14 * HOUR);
  await srv!.close();
  srv = null;

  // The demo accounts used to keep 14 days (anyone on the network could open one and keep it for two weeks): now the
  // same 14 hours as everyone (finding SEC-1).
  await start(true);
  const demo = await signInSteps(DEMO_ACCOUNTS.rep);
  assert.equal(maxAgeOf(demo.last), 14 * 3600, 'demo cookie Max-Age 14 hours');
  assert.ok(Math.abs(lifetimeHours(session(demo.client)!) - 14) < 0.001);
  assert.equal((await demo.client.get('/auth/me')).json.session.maxHours, 14);
});

test('the 14-hour boundary for every role: alive at 13:59, signed out at 14:01 with the reason', async () => {
  await start();
  for (const role of ROLES) {
    const c = await srv!.login(role);
    const id = userBy(FIXTURE_ACCOUNTS[role]).id;
    age(c, 14 * HOUR - MIN);
    assert.equal((await c.get(probeFor(role))).status, 200, `${role} at 13:59`);
    age(c, 14 * HOUR + MIN);
    const ended = await c.get(probeFor(role));
    assert.equal(ended.status, 401, `${role} at 14:01`);
    assert.equal(ended.json.error, sessionMaxAgeMessage(14));
    assert.equal(ended.json.error, 'For security you are signed out 14 hours after signing in. Sign in again to carry on.');
    assert.deepEqual(ended.json.details, { sessionEnded: 'max_age', maxHours: 14 });
    assert.match(ended.headers.get('set-cookie') ?? '', /lm_session=;/, 'the cookie is cleared');
    assert.equal(get(db(), `SELECT 1 FROM sessions WHERE user_id = ?`, [id]), undefined, 'the session is gone');
    const after = await c.get('/auth/me');
    assert.equal(after.status, 401);
    assert.equal(after.json.details, undefined, 'later requests are simply signed out');
    assert.equal(maxAgeRows(id).length, 1, `${role}: one audit row`);
  }
});

test('/auth/me also answers the reason when it is the request that finds the session over 14 hours', async () => {
  await start();
  const c = await srv!.login('leader');
  age(c, 15 * HOUR);
  const me = await c.get('/auth/me');
  assert.equal(me.status, 401);
  assert.deepEqual(me.json.details, { sessionEnded: 'max_age', maxHours: 14 });
});

test('activity does not stretch it: a session used a minute ago still ends at 14 hours', async () => {
  await start();
  const c = await srv!.login('rep');
  age(c, 14 * HOUR - 2 * MIN, 0);
  assert.equal((await c.get('/me/dashboard')).status, 200);
  age(c, 14 * HOUR + MIN, 30_000);
  const r = await c.get('/me/dashboard');
  assert.equal(r.status, 401);
  assert.equal(r.json.details?.sessionEnded, 'max_age');
});

test('the idle timeout still applies on its own, without the 14-hour sentence', async () => {
  await start();
  const c = await srv!.login('rep');
  age(c, 13 * HOUR, 12 * HOUR + 30 * MIN);
  const r = await c.get('/me/dashboard');
  assert.equal(r.status, 401);
  assert.equal(r.json.details, undefined);
  assert.equal(maxAgeRows(userBy(FIXTURE_ACCOUNTS.rep).id).length, 0);
  assert.equal(all(db(), `SELECT 1 FROM audit_log WHERE action = 'SESSION idle'`).length, 1);
});

test('demo sessions end 14 hours after sign-in like everyone’s (they used to last 14 days)', async () => {
  await start(true);
  for (const role of ROLES) {
    const c = await srv!.login(role);
    age(c, 13 * HOUR, 0);
    assert.equal((await c.get(probeFor(role))).status, 200, `${role}: 13 hours after sign-in`);
    age(c, 20 * HOUR, 0);
    const ended = await c.get(probeFor(role));
    assert.equal(ended.status, 401, `${role}: 20 hours after sign-in`);
    assert.equal(ended.json.error, sessionMaxAgeMessage(14));
  }
});

test('upgrade: a session from before 1.4 older than 14 hours ends at the next request, with the same sentence', async () => {
  await start();
  const c = await srv!.login('rep');
  age(c, 15 * HOUR, 0, 14 * 86_400_000 - 15 * HOUR); // a 1.3 session: expires 14 days after sign-in
  const r = await c.get('/me/dashboard');
  assert.equal(r.status, 401);
  assert.equal(r.json.error, sessionMaxAgeMessage(14));
  const young = await srv!.login('leader');
  age(young, 2 * HOUR, 0, 14 * 86_400_000 - 2 * HOUR);
  assert.equal((await young.get('/me/dashboard')).status, 200, 'a younger 1.3 session carries on until its 14 hours');
});

test('the admin chooses 4–24 hours in Settings → Sign-in rules; nobody else can; it applies at once and to new sign-ins', async () => {
  await start();
  const admin = await srv!.login('admin');
  const s = await admin.get('/auth/security-settings');
  assert.equal(s.json.sessionMaxHours, SESSION_MAX_HOURS_DEFAULT);
  for (const bad of [3, 25, 4.5, 0, '8', null]) assert.equal((await admin.put('/auth/security-settings', { sessionMaxHours: bad })).status, 400, String(bad));
  for (const ok of [4, 24]) assert.equal((await admin.put('/auth/security-settings', { sessionMaxHours: ok })).json.sessionMaxHours, ok);
  for (const role of ['leader', 'recruiter', 'rep', 'client'] as const) {
    const c = await srv!.login(role);
    assert.equal((await c.put('/auth/security-settings', { sessionMaxHours: 20 })).status, 403, role);
    assert.equal((await c.get('/auth/security-settings')).status, 403, role);
  }
  assert.equal((await srv!.anon().put('/auth/security-settings', { sessionMaxHours: 20 })).status, 401);
  assert.equal((await srv!.anon().get('/auth/security-settings')).status, 401);

  const rep = await srv!.login('rep');
  age(rep, 9 * HOUR);
  const saved = await admin.put('/auth/security-settings', { sessionMaxHours: 8 });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.sessionMaxHours, 8);
  const r = await rep.get('/me/dashboard');
  assert.equal(r.status, 401, 'a shorter limit applies at once');
  assert.equal(r.json.error, 'For security you are signed out 8 hours after signing in. Sign in again to carry on.');
  assert.deepEqual(r.json.details, { sessionEnded: 'max_age', maxHours: 8 });
  const fresh = await signInSteps(FIXTURE_ACCOUNTS.leader);
  assert.equal(maxAgeOf(fresh.last), 8 * 3600);
  assert.ok(Math.abs(lifetimeHours(session(fresh.client)!) - 8) < 0.001);
  const audit = get<{ summary: string }>(db(), `SELECT summary FROM audit_log WHERE entity = 'settings' ORDER BY id DESC LIMIT 1`);
  assert.match(audit!.summary, /sign out after \(hours from sign-in\) 24 → 8/i);
});

test('a longer limit applies from the next sign-in: a session signed in under 14 hours still says 14 and ends at 14 with the reason', async () => {
  await start();
  const admin = await srv!.login('admin');
  const rep = await srv!.login('rep'); // two-step set up, as a real rep's would be
  const id = userBy(FIXTURE_ACCOUNTS.rep).id;
  assert.equal((await admin.put('/auth/security-settings', { sessionMaxHours: 24 })).json.sessionMaxHours, 24);

  // Its expires_at and cookie were fixed at sign-in: /auth/me says when it really ends, and for how many hours.
  const me = await rep.get('/auth/me');
  assert.equal(me.status, 200);
  assert.equal(Date.parse(me.json.session.endsAt) - Date.parse(me.json.session.signedInAt), 14 * HOUR);
  assert.equal(me.json.session.maxHours, 14, 'its own 14 hours, not the new 24');

  // A new sign-in gets the 24 hours.
  const fresh = await signInSteps(FIXTURE_ACCOUNTS.leader);
  assert.equal(maxAgeOf(fresh.last), 24 * 3600);
  assert.equal((await fresh.client.get('/auth/me')).json.session.maxHours, 24);

  // 14 hours and a minute on (its 14-hour expiry passed; the cookie is still sent): the reason and one audit row.
  age(rep, 14 * HOUR + MIN, 0, -MIN);
  const ended = await rep.get('/me/dashboard');
  assert.equal(ended.status, 401);
  assert.equal(ended.json.error, sessionMaxAgeMessage(14));
  assert.deepEqual(ended.json.details, { sessionEnded: 'max_age', maxHours: 14 });
  assert.match(ended.headers.get('set-cookie') ?? '', /lm_session=;/, 'the cookie is cleared');
  const rows = maxAgeRows(id);
  assert.equal(rows.length, 1);
  assert.match(rows[0]!.summary, /^Signed out 14 hours after signing in/);
  assert.equal((await rep.get('/auth/me')).json.details, undefined, 'later requests are simply signed out');

  // Raised and then lowered below its own lifetime: the shorter setting is what ended it.
  const recruiter = await srv!.login('recruiter'); // signed in under 24 hours
  assert.equal((await admin.put('/auth/security-settings', { sessionMaxHours: 10 })).status, 200);
  age(recruiter, 25 * HOUR, 0, -HOUR);
  assert.deepEqual((await recruiter.get('/me/dashboard')).json.details, { sessionEnded: 'max_age', maxHours: 10 });
});

test('a 14-day demo session from before this release ends at its next request with the 14-hour reason', async () => {
  await start(true);
  const demo = await srv!.login('rep');
  age(demo, 15 * 86_400_000, 0, -HOUR); // signed in 15 days ago under the old 14 days, expired an hour ago
  const r = await demo.get('/me/dashboard');
  assert.equal(r.status, 401);
  assert.deepEqual(r.json.details, { sessionEnded: 'max_age', maxHours: 14 });
  assert.equal(maxAgeRows(userBy(DEMO_ACCOUNTS.rep).id).length, 1, 'recorded like anyone’s');
});

test('audit: a 14-hour sign-out is one automatic row filed under the person; the sweep writes one per person', async () => {
  await start();
  const c = await srv!.login('rep');
  const id = userBy(FIXTURE_ACCOUNTS.rep).id;
  age(c, 14 * HOUR + 5 * MIN);
  assert.equal((await c.get('/me/dashboard')).status, 401);
  assert.equal((await c.get('/me/dashboard')).status, 401);
  const rows = maxAgeRows(id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.kind, 'sign_in');
  assert.match(rows[0]!.summary, /^Signed out 14 hours after signing in/);

  // The 15-minute sweep: two devices whose 14 hours (and cookies) ran out while nobody used them → one row.
  const leaderId = userBy(FIXTURE_ACCOUNTS.leader).id;
  const phone = await srv!.login('leader');
  const laptop = await srv!.login('leader');
  for (const d of [phone, laptop]) age(d, 15 * HOUR, 2 * HOUR, -HOUR);
  // A 1.3 session past its 14 days goes quietly, as before.
  const old = await srv!.login('recruiter');
  age(old, 15 * 86_400_000, 15 * 86_400_000 - HOUR, -HOUR);
  purgeExpiredSessions(db());
  assert.equal(get<{ n: number }>(db(), `SELECT COUNT(*) AS n FROM sessions WHERE user_id IN (?, ?)`, [leaderId, userBy(FIXTURE_ACCOUNTS.recruiter).id])!.n, 0);
  assert.equal(maxAgeRows(leaderId).length, 1, 'one row for the person, not one per device');
  assert.equal(maxAgeRows(userBy(FIXTURE_ACCOUNTS.recruiter).id).length, 0);
});

// ───────────────────────────── the admin resets a client's two-step ─────────────────────────────

test('POST /client-accounts/:id/reset-2fa: admin only; clears two-step, signs them out, set up again at the next sign-in', async () => {
  await start();
  const cl = await srv!.login('client');
  const clientId = userBy(FIXTURE_ACCOUNTS.client).id;
  const admin = await srv!.login('admin');
  const list = await admin.get(`/campaigns/${fx().campaignId}/client-accounts`);
  assert.equal(list.json.find((a: { id: number }) => a.id === clientId).twoFactorEnabled, true);

  for (const role of ['leader', 'recruiter', 'rep'] as const) {
    const c = await srv!.login(role);
    assert.equal((await c.post(`/client-accounts/${clientId}/reset-2fa`)).status, 403, role);
  }
  const own = await cl.post(`/client-accounts/${clientId}/reset-2fa`);
  assert.equal(own.status, 403, 'a client session');
  assert.equal(own.json.clientPortalOnly, true);
  assert.equal((await srv!.anon().post(`/client-accounts/${clientId}/reset-2fa`)).status, 401);
  assert.equal((await admin.post('/client-accounts/987654/reset-2fa')).status, 404);
  assert.equal((await admin.post(`/client-accounts/${fx().users.rep}/reset-2fa`)).status, 404, 'a staff member is not a client account');

  // the admin's fresh two-step code is needed; the answer carries the client's setup code for their next sign-in
  assert.equal((await admin.post(`/client-accounts/${clientId}/reset-2fa`)).status, 400, 'no code');
  const r = await admin.post(`/client-accounts/${clientId}/reset-2fa`, { code: currentCode(db(), fx().users.admin) });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.match(r.json.setupCode, /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.equal(r.json.id, clientId);
  assert.equal(r.json.twoFactorEnabled, false);
  assert.equal((await cl.get('/client/portal')).status, 401, 'signed out everywhere');
  const row = get<{ enabledAt: string | null; s: string | null }>(db(), `SELECT totp_enabled_at AS enabledAt, totp_secret_enc AS s FROM users WHERE id = ?`, [clientId])!;
  assert.deepEqual({ ...row }, { enabledAt: null, s: null });
  const audit = get<{ summary: string; entity: string; userId: number }>(
    db(), `SELECT summary, entity, user_id AS userId FROM audit_log WHERE action = 'POST /client-accounts/:id/reset-2fa' ORDER BY id DESC LIMIT 1`,
  );
  assert.ok(audit, 'recorded');
  assert.equal(audit!.entity, 'client_account');
  assert.equal(audit!.userId, fx().users.admin);
  assert.match(audit!.summary, /two-step verification/);
  assert.ok(isWriteLimited('POST', `/client-accounts/${clientId}/reset-2fa`), 'under the per-person write limit');

  const back = await srv!.login('client', undefined, { twoFactor: false });
  assert.equal((await back.get('/auth/me')).json.user.twoFactorSetupRequired, true, 'they set it up again');
});

test('the staff reset (Team › Edit) still works and the person sets it up again at the next sign-in', async () => {
  await start();
  const rep = await srv!.login('rep');
  const admin = await srv!.login('admin');
  assert.equal((await admin.post(`/users/${fx().users.rep}/2fa/reset`)).status, 400, 'the admin’s fresh two-step code is needed');
  const reset = await admin.post(`/users/${fx().users.rep}/2fa/reset`, { code: currentCode(db(), fx().users.admin) });
  assert.equal(reset.status, 200);
  assert.match(reset.json.setupCode, /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/, 'the setup code their next sign-in needs');
  assert.equal((await rep.get('/me/dashboard')).status, 401);
  const back = await srv!.login('rep', undefined, { twoFactor: false });
  assert.equal((await back.get('/me/dashboard')).status, 403);

  // never your own: the refusal names the way that is left (a recovery code, or the server command)
  const own = await admin.post(`/users/${fx().users.admin}/2fa/reset`);
  assert.equal(own.status, 400);
  assert.ok(own.json.error.includes('recovery code'), own.json.error);
  assert.ok(own.json.error.includes(`npm run 2fa:reset -- ${FIXTURE_ACCOUNTS.admin.email}`), own.json.error);
});

// ───────────────────────────── npm run 2fa:reset ─────────────────────────────

const SERVER_DIR = path.resolve(import.meta.dirname, '../..');

function twoFactorReset(dbPath: string, ...args: string[]) {
  const r = spawnSync(process.execPath, ['src/twoFactorReset.ts', ...args], {
    cwd: SERVER_DIR,
    env: { ...process.env, DB_PATH: dbPath, NODE_NO_WARNINGS: '1' },
    encoding: 'utf8',
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

test('npm run 2fa:reset -- <email>: clears two-step, signs the person out everywhere, writes an audit row (the only admin locked out)', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'linear-2fa-reset-'));
  try {
    const file = path.join(dir, 'linear.sqlite');
    const fileDb = openDb(file);
    createSchema(fileDb);
    buildFixture(fileDb);
    const adminId = get<{ id: number }>(fileDb, `SELECT id FROM users WHERE email = ?`, [FIXTURE_ACCOUNTS.admin.email])!.id;
    run(fileDb, `UPDATE users SET totp_secret_enc = 'v1:x:y:z', totp_enabled_at = ?, totp_last_counter = 5 WHERE id = ?`, [new Date().toISOString(), adminId]);
    run(fileDb, `INSERT INTO recovery_codes (user_id, code_hash, used_at) VALUES (?, 'abc', NULL)`, [adminId]);
    for (const token of ['phone', 'laptop']) {
      run(fileDb, `INSERT INTO sessions (token, user_id, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?)`, [
        token, adminId, new Date().toISOString(), new Date(Date.now() + HOUR).toISOString(), new Date().toISOString(),
      ]);
    }
    const auditBefore = get<{ n: number }>(fileDb, `SELECT COUNT(*) AS n FROM audit_log`)!.n;
    fileDb.close();

    const usage = twoFactorReset(file);
    assert.equal(usage.code, 1);
    assert.match(usage.out, /Usage: npm run 2fa:reset -- <email>/);
    const missing = twoFactorReset(path.join(dir, 'nope.sqlite'), FIXTURE_ACCOUNTS.admin.email);
    assert.equal(missing.code, 1);
    assert.match(missing.out, /There is no database at .*nope\.sqlite/);
    const junk = path.join(dir, 'notdb.sqlite');
    writeFileSync(junk, randomBytes(64));
    const notDb = twoFactorReset(junk, FIXTURE_ACCOUNTS.admin.email);
    assert.equal(notDb.code, 1, notDb.out);
    assert.match(notDb.out, /is not a Linear Hub database/);
    assert.doesNotMatch(notDb.out, /\bat \S+\.ts:\d+|ERR_SQLITE_ERROR|Node\.js v/, 'no stack trace');
    const unknown = twoFactorReset(file, 'nobody@fixture.test');
    assert.equal(unknown.code, 1);
    assert.match(unknown.out, /No one .* nobody@fixture\.test/);
    const nothing = twoFactorReset(file, FIXTURE_ACCOUNTS.repB.email);
    assert.equal(nothing.code, 0, nothing.out);
    assert.match(nothing.out, /has no two-step verification/);

    const done = twoFactorReset(file, FIXTURE_ACCOUNTS.admin.email.toUpperCase());
    assert.equal(done.code, 0, done.out);
    assert.match(done.out, /Reset the two-step verification of Ada Admin \(ada\.admin@fixture\.test\) and signed them out on 2 devices/);
    assert.match(done.out, /set it up again/);

    const after = openDb(file);
    const row = get<{ s: string | null; enabledAt: string | null; c: number | null }>(
      after, `SELECT totp_secret_enc AS s, totp_enabled_at AS enabledAt, totp_last_counter AS c FROM users WHERE id = ?`, [adminId],
    )!;
    assert.deepEqual({ ...row }, { s: null, enabledAt: null, c: null });
    assert.equal(get<{ n: number }>(after, `SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?`, [adminId])!.n, 0);
    assert.equal(get<{ n: number }>(after, `SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = ?`, [adminId])!.n, 0);
    const audit = all<{ userId: number | null; action: string; entity: string; entityId: number; summary: string; after: string }>(
      after, `SELECT user_id AS userId, action, entity, entity_id AS entityId, summary, after_json AS after FROM audit_log ORDER BY id`,
    );
    assert.equal(audit.length, auditBefore + 1, 'one row, none for the person who had no two-step');
    const last = audit.at(-1)!;
    assert.deepEqual([last.userId, last.action, last.entity, last.entityId], [null, 'npm run 2fa:reset', 'user', adminId]);
    assert.equal(last.summary, 'Reset two-step verification from the server command: Ada Admin');
    assert.equal(JSON.parse(last.after).twoFactor, false);
    assert.ok(!last.after.includes('v1:x:y:z'), 'never the secret');
    after.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
