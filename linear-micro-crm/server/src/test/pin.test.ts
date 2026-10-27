/**
 * U1 sign-in-pin (release 1.2), end to end on the small fixture: setting, changing and removing a PIN; sign-in with a
 * PIN (missing / wrong / right, the login rate limit, the lock after PIN_LOCK_AFTER_FAILURES wrong PINs in a row and a
 * parallel burst); the "Require a PIN for everyone" gate; the old "Require two-step verification for administrators"
 * switch, which since 1.4 decides nothing (two-step is required for every account: test/r4-security.test.ts); the
 * admin's PIN reset and status; the session idle timeout; and the extension's upgrade of an existing database.
 * Sessions and PINs run on the real clock, so nothing here pins the business clock.
 */
import { after, afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { sessionKey } from '../lib/sessionKey.ts';
import { issueSetupCode } from '../lib/setupCodes.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PIN_LOCK_AFTER_FAILURES } from '@lm/shared';
import { get, openDb, run } from '../db/connection.ts';
import { extension as pinExtension } from '../db/extensions/pin.ts';
import { createSchema } from '../db/schema.ts';
import { configureAppSecret } from '../lib/crypto.ts';
import { hashPin, verifyPin } from '../lib/pin.ts';
import { totp } from '../lib/totp.ts';
import { LAST_SEEN_RESOLUTION_MS, purgeExpiredSessions } from '../middleware/auth.ts';
import { LOGIN_MAX_FAILURES, resetLoginFailures } from '../routes/auth.ts';
import { FIXTURE_ACCOUNTS, currentCode, startTestServer, type Json, type LoginOptions, type TestClient, type TestServer } from './helpers.ts';

const GOOD_PIN = '5821';
const OTHER_PIN = '7390';

// PINs are peppered with the app secret: the first test hashes before any test server exists, so point the secret at
// a temporary file (never server/data/app-secret).
const secretDir = mkdtempSync(path.join(os.tmpdir(), 'linear-pin-'));
configureAppSecret(path.join(secretDir, 'app-secret'));
after(() => rmSync(secretDir, { recursive: true, force: true }));

let srv: TestServer | null = null;
afterEach(async () => {
  await srv?.close();
  srv = null;
});

async function start(): Promise<TestServer> {
  srv = await startTestServer();
  return srv;
}

const fx = () => srv!.fixture!;
const pinHashOf = (userId: number) => get<{ h: string | null; n: number }>(srv!.db, `SELECT pin_hash AS h, pin_failed_attempts AS n FROM users WHERE id = ?`, [userId])!;
const sessionsOf = (userId: number) => get<{ n: number }>(srv!.db, `SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?`, [userId])!.n;

/** Sign in, set `pin` as a first PIN and return the client (its session survives the change). */
async function withPin(account: keyof typeof FIXTURE_ACCOUNTS, pin = GOOD_PIN, opts: LoginOptions = {}): Promise<TestClient> {
  const client = await srv!.login(account, undefined, opts);
  const r = await client.post('/auth/pin', { pin });
  assert.equal(r.status, 204, JSON.stringify(r.json));
  return client;
}

/** Turn on two-step verification for a signed-in client; returns the secret. */
async function enableTwoFactor(client: TestClient): Promise<string> {
  const setup = await client.post('/auth/2fa/setup');
  assert.equal(setup.status, 201);
  const on = await client.post('/auth/2fa/enable', { code: totp(setup.json.secret) });
  assert.equal(on.status, 200, JSON.stringify(on.json));
  return setup.json.secret as string;
}

test('scrypt hashes: random salt, parameters in the hash, constant-time verify; malformed input is a mismatch', async () => {
  const a = await hashPin(GOOD_PIN);
  const b = await hashPin(GOOD_PIN);
  assert.match(a, /^scrypt-hmac\$16384\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
  assert.notEqual(a, b, 'a fresh salt every time');
  assert.ok(!a.includes(GOOD_PIN));
  assert.equal(await verifyPin(a, GOOD_PIN), true);
  assert.equal(await verifyPin(a, OTHER_PIN), false);
  assert.equal(await verifyPin(a, '58210'), false);
  assert.equal(await verifyPin(a, 'abcd'), false);
  assert.equal(await verifyPin('plain-text', GOOD_PIN), false);
  assert.equal(await verifyPin('scrypt$1$1$1$$', GOOD_PIN), false);
});

test('set a PIN: rules, stored hashed, other sessions signed out, sign-in then needs it', async () => {
  await start();
  const rep = await srv!.login('rep');
  const otherDevice = await srv!.login('rep');
  assert.deepEqual((await rep.get('/auth/pin')).json, { hasPin: false, setAt: null, required: false, locked: false });
  const me0 = (await rep.get('/auth/me')).json.user;
  assert.equal(me0.hasPin, false);
  assert.equal(me0.pinSetupRequired, false);
  assert.equal(me0.twoFactorSetupRequired, false);

  for (const [pin, rule] of [['123', 'digits'], ['1234', 'run'], ['0000', 'one digit'], ['1212', 'most guessed'], ['0004', 'employee ID'], [1234, 'Validation']] as const) {
    const r = await rep.post('/auth/pin', { pin });
    assert.equal(r.status, 400, `${pin} refused`);
    assert.match(r.json.error, new RegExp(rule === 'Validation' ? 'Validation' : rule, 'i'), `${pin}: ${r.json.error}`);
  }
  assert.equal(pinHashOf(fx().users.rep).h, null, 'nothing stored for a refused PIN');

  assert.equal((await rep.post('/auth/pin', { pin: GOOD_PIN })).status, 204);
  const stored = pinHashOf(fx().users.rep).h!;
  assert.ok(stored.startsWith('scrypt-hmac$') && !stored.includes(GOOD_PIN), 'peppered and hashed, never plain');
  const status = (await rep.get('/auth/pin')).json;
  assert.equal(status.hasPin, true);
  assert.equal(typeof status.setAt, 'string');
  assert.equal((await rep.get('/auth/me')).json.user.hasPin, true, 'the session that set it carries on');
  assert.equal((await otherDevice.get('/auth/me')).status, 401, 'every other session is signed out');
  assert.ok(!JSON.stringify((await rep.get('/auth/me')).json).includes('scrypt'), 'the hash never leaves the server');

  const creds = FIXTURE_ACCOUNTS.rep;
  const anon = srv!.anon();
  const missing = await anon.post('/auth/login', creds);
  assert.equal(missing.status, 200, 'step two of the sign-in, like the two-step challenge');
  assert.deepEqual(missing.json, { requiresPin: true, attemptsLeft: PIN_LOCK_AFTER_FAILURES });
  assert.equal(anon.cookie, '', 'no session without the PIN');
  assert.equal((await anon.get('/auth/me')).status, 401);
  const wrong = await anon.post('/auth/login', { ...creds, pin: OTHER_PIN });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.json.details.reason, 'wrong');
  assert.equal(wrong.json.details.attemptsLeft, PIN_LOCK_AFTER_FAILURES - 1);
  assert.equal(pinHashOf(fx().users.rep).n, 1);
  const right = await anon.post('/auth/login', { ...creds, pin: GOOD_PIN });
  assert.equal(right.status, 200);
  assert.equal(right.json.requiresTwoFactor, true, 'release 1.4: then the two-step code');
  assert.equal(pinHashOf(fx().users.rep).n, 0, 'a right PIN wipes the count');
  const ok = await anon.post('/auth/login/2fa', { challengeToken: right.json.challengeToken, code: currentCode(srv!.db, fx().users.rep) });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.user.hasPin, true);

  // A wrong employee ID still answers the plain mismatch (the PIN is never mentioned).
  const mismatch = await srv!.anon().post('/auth/login', { email: creds.email, employeeId: 'FX-9999', pin: GOOD_PIN });
  assert.equal(mismatch.status, 401);
  assert.equal(mismatch.json.requiresPin, undefined);
  // Accounts without a PIN sign in exactly as before; a PIN sent to them is ignored.
  assert.equal((await srv!.anon().post('/auth/login', { ...FIXTURE_ACCOUNTS.repA2, pin: GOOD_PIN })).status, 200);
});

test('change and remove a PIN: the current one is needed, the same one is refused', async () => {
  await start();
  const rep = await withPin('rep');
  const noCurrent = await rep.post('/auth/pin', { pin: OTHER_PIN });
  assert.equal(noCurrent.status, 400);
  assert.equal(noCurrent.json.error, 'Enter your current PIN');
  const wrongCurrent = await rep.post('/auth/pin', { pin: OTHER_PIN, currentPin: '9152' });
  assert.equal(wrongCurrent.status, 400);
  assert.equal(wrongCurrent.json.details[0].path, 'currentPin');
  assert.equal((await rep.post('/auth/pin', { pin: GOOD_PIN, currentPin: GOOD_PIN })).status, 400, 'the same PIN again');
  assert.equal((await rep.post('/auth/pin', { pin: OTHER_PIN, currentPin: GOOD_PIN })).status, 204);
  assert.equal(pinHashOf(fx().users.rep).n, 0, 'the right current PIN cleared the count');

  const creds = FIXTURE_ACCOUNTS.rep;
  assert.equal((await srv!.anon().post('/auth/login', { ...creds, pin: GOOD_PIN })).status, 401, 'old PIN gone');
  assert.equal((await srv!.anon().post('/auth/login', { ...creds, pin: OTHER_PIN })).status, 200, 'new PIN works');

  assert.equal((await rep.post('/auth/pin/remove', { currentPin: GOOD_PIN })).status, 400);
  assert.equal((await rep.post('/auth/pin/remove', { currentPin: OTHER_PIN })).status, 204);
  assert.equal((await rep.get('/auth/pin')).json.hasPin, false);
  assert.equal((await rep.post('/auth/pin/remove', { currentPin: OTHER_PIN })).status, 409, 'nothing to remove');
  assert.equal((await srv!.anon().post('/auth/login', creds)).status, 200, 'back to email + employee ID');
});

test('lockout: the login limiter (8 per source and email) and the PIN lock after 10 wrong in a row; admin reset unlocks (expiry: pin-lock.test.ts)', async () => {
  await start();
  const rep = await withPin('rep');
  const creds = FIXTURE_ACCOUNTS.rep;
  const anon = srv!.anon();
  for (let i = 1; i <= LOGIN_MAX_FAILURES; i++) assert.equal((await anon.post('/auth/login', { ...creds, pin: '9152' })).status, 401, `attempt ${i}`);
  const limited = await anon.post('/auth/login', { ...creds, pin: GOOD_PIN });
  assert.equal(limited.status, 429, 'rate limits as login, even with the right PIN');
  assert.match(limited.json.error, /Too many attempts/);

  resetLoginFailures(); // 15 minutes later (or another network): the PIN count is still there
  assert.equal(pinHashOf(fx().users.rep).n, LOGIN_MAX_FAILURES);
  const ninth = await anon.post('/auth/login', { ...creds, pin: '9152' });
  assert.equal(ninth.json.details.attemptsLeft, 1);
  const tenth = await anon.post('/auth/login', { ...creds, pin: '9152' });
  assert.equal(tenth.status, 423);
  assert.equal(tenth.json.details.reason, 'locked');
  assert.equal(typeof tenth.json.details.lockedUntil, 'string', 'the lock says when it ends');
  assert.match(tenth.json.error, /^Too many wrong PINs\. Try again after \d{2}:\d{2}/);
  const right = await anon.post('/auth/login', { ...creds, pin: GOOD_PIN });
  assert.equal(right.status, 423, 'locked even for the right PIN');
  assert.equal(anon.cookie, '');

  assert.equal((await rep.get('/auth/pin')).json.locked, true, 'the open session sees the lock');
  assert.equal((await rep.post('/auth/pin', { pin: OTHER_PIN, currentPin: GOOD_PIN })).status, 423, 'and cannot change it');

  const admin = await srv!.login('admin');
  const seen = await admin.get(`/auth/pin/${fx().users.rep}`);
  assert.equal(seen.status, 200);
  assert.equal(seen.json.hasPin, true);
  assert.equal(seen.json.locked, true);
  // a reset needs the admin's fresh two-step code and hands out a setup code for the next sign-in
  const reset = await admin.post(`/auth/pin/reset/${fx().users.rep}`, { code: currentCode(srv!.db, fx().users.admin) });
  assert.equal(reset.status, 200);
  assert.deepEqual({ ...pinHashOf(fx().users.rep) }, { h: null, n: 0 });
  assert.equal(sessionsOf(fx().users.rep), 0, 'reset signs the person out everywhere');
  assert.equal((await rep.get('/auth/me')).status, 401);
  resetLoginFailures();
  const back = srv!.anon();
  assert.deepEqual((await back.post('/auth/login', creds)).json, { requiresSetupCode: true }, 'no PIN now, but the setup code first');
  const step = await back.post('/auth/login', { ...creds, setupCode: reset.json.setupCode });
  assert.equal(step.json.requiresTwoFactor, true, 'then two-step, then they set a new PIN');
});

test('a parallel burst of guesses meets the limits one request at a time', async () => {
  await start();
  await withPin('rep');
  const creds = FIXTURE_ACCOUNTS.rep;
  const anon = srv!.anon();
  const guesses = Array.from({ length: 24 }, (_, i) => String(4000 + i * 7).padStart(4, '0'));
  const results = await Promise.all(guesses.map((pin) => anon.post('/auth/login', { ...creds, pin })));
  const answered = results.filter((r) => r.status === 401 || r.status === 423).length;
  const limited = results.filter((r) => r.status === 429).length;
  assert.equal(answered, LOGIN_MAX_FAILURES, 'only 8 guesses were checked');
  assert.equal(limited, guesses.length - LOGIN_MAX_FAILURES);
  assert.equal(pinHashOf(fx().users.rep).n, LOGIN_MAX_FAILURES);
});

test('signing in with a PIN and two-step verification: the PIN first, then the code', async () => {
  await start();
  const rep = await withPin('rep', GOOD_PIN, { twoFactor: false });
  const secret = await enableTwoFactor(rep);
  const creds = FIXTURE_ACCOUNTS.rep;
  const anon = srv!.anon();
  assert.deepEqual((await anon.post('/auth/login', creds)).json, { requiresPin: true, attemptsLeft: PIN_LOCK_AFTER_FAILURES });
  const step1 = await anon.post('/auth/login', { ...creds, pin: GOOD_PIN });
  assert.equal(step1.status, 200);
  assert.equal(step1.json.requiresTwoFactor, true);
  assert.equal(anon.cookie, '', 'no session before the code');
  // Enable spent this time step's code (one code, one use): the next step's code is inside the ±1 window.
  const code = totp(secret, { timeMs: Date.now() + 30_000 });
  const step2 = await anon.post('/auth/login/2fa', { challengeToken: step1.json.challengeToken, code });
  assert.equal(step2.status, 200, JSON.stringify(step2.json));
  assert.equal(step2.json.user.hasPin, true);
  assert.equal(step2.json.user.twoFactorEnabled, true);
});

test('"Require a PIN for everyone": admin only, own PIN first, the gate holds others until they set one', async () => {
  await start();
  const rep = await srv!.login('rep');
  const leader = await srv!.login('leader');
  assert.equal((await leader.get('/auth/security-settings')).status, 403);
  assert.equal((await leader.put('/auth/security-settings', { requirePin: true })).status, 403);
  assert.equal((await srv!.anon().get('/auth/security-settings')).status, 401);

  const admin = await srv!.login('admin');
  assert.deepEqual((await admin.get('/auth/security-settings')).json, { requirePin: false, requireAdminTwoFactor: false, sessionIdleHours: 12, sessionMaxHours: 14 });
  const own = await admin.put('/auth/security-settings', { requirePin: true });
  assert.equal(own.status, 409, 'your own PIN first');
  assert.match(own.json.error, /own PIN/);
  for (const bad of [{ sessionIdleHours: 0 }, { sessionIdleHours: 73 }, { sessionIdleHours: 1.5 }, { requirePin: 'yes' }, { surprise: true }]) {
    assert.equal((await admin.put('/auth/security-settings', bad)).status, 400, JSON.stringify(bad));
  }
  assert.equal((await admin.post('/auth/pin', { pin: OTHER_PIN })).status, 204);
  const on = await admin.put('/auth/security-settings', { requirePin: true });
  assert.equal(on.status, 200);
  assert.deepEqual(on.json, { requirePin: true, requireAdminTwoFactor: false, sessionIdleHours: 12, sessionMaxHours: 14 });

  // An open session without a PIN: 403 everywhere except PIN setup, me, logout and health.
  const blocked = await rep.get('/me/dashboard');
  assert.equal(blocked.status, 403);
  assert.deepEqual(blocked.json, { error: 'Create your PIN to carry on', pinSetupRequired: true });
  for (const path of ['/events', '/gauges/summary', '/learning/progress', '/users', '/auth/2fa', '/AUTH/2FA/']) {
    assert.equal((await rep.get(path)).status, 403, path);
  }
  assert.equal((await rep.post('/gauges', {})).status, 403, 'writes too');
  assert.equal((await rep.post('/auth/pin/remove', { currentPin: GOOD_PIN })).status, 403);
  const me = await rep.get('/auth/me');
  assert.equal(me.status, 200);
  assert.equal(me.json.user.pinSetupRequired, true);
  assert.equal((await rep.get('/health')).status, 200);
  assert.deepEqual((await rep.get('/auth/pin')).json, { hasPin: false, setAt: null, required: true, locked: false });
  assert.equal((await srv!.anon().get('/me/dashboard')).status, 401, 'anonymous requests are not the gate’s business');

  // A fresh sign-in without a PIN (with the setup code a new account needs) gets in, flagged, and is held the same way.
  const repA2 = srv!.anon();
  const login = await repA2.post('/auth/login', { ...FIXTURE_ACCOUNTS.repA2, setupCode: issueSetupCode(srv!.db, fx().users.repA2, { createdBy: null, reason: 'reissue' }).code });
  assert.equal(login.status, 200);
  assert.equal(login.json.user.pinSetupRequired, true);
  assert.equal((await repA2.get('/me/dashboard')).status, 403);

  assert.equal((await rep.post('/auth/pin', { pin: GOOD_PIN })).status, 204);
  assert.equal((await rep.get('/me/dashboard')).status, 200, 'the gate lifts on the next request');
  assert.equal((await rep.get('/auth/me')).json.user.pinSetupRequired, false);
  assert.equal((await rep.post('/auth/pin/remove', { currentPin: GOOD_PIN })).status, 409, 'cannot remove while required');
  assert.equal((await admin.get('/me/dashboard')).status, 200, 'the admin has a PIN');

  assert.equal((await admin.put('/auth/security-settings', { requirePin: false })).json.requirePin, false);
  // Release 1.4: the PIN gate is gone, the two-step one stays (Rita signed in without setting it up)
  const held = await repA2.get('/me/dashboard');
  assert.equal(held.status, 403, 'switched off: no PIN gate');
  assert.equal(held.json.twoFactorSetupRequired, true);
});

test('release 1.4: two-step is required for every admin anyway; the old "administrators" switch decides nothing and signs nobody out', async () => {
  await start();
  const db = srv!.db;
  const plan = get<{ id: number }>(db, `SELECT pay_plan_id AS id FROM users WHERE id = ?`, [fx().users.admin])!.id;
  run(
    db,
    `INSERT INTO users (employee_id, email, first_name, last_name, role, position, team_id, pay_plan_id, start_date, status, phone, avatar_color, city)
     VALUES ('FX-0009', 'ola.admin@fixture.test', 'Ola', 'Admin', 'admin', 'owner', NULL, ?, '2025-01-06', 'active', NULL, '#4F46E5', 'Manchester')`,
    [plan],
  );
  const second = await srv!.login({ email: 'ola.admin@fixture.test', employeeId: 'FX-0009' }, undefined, { twoFactor: false });
  const admin = await srv!.login('admin');
  const rep = await srv!.login('rep');

  const me = (await second.get('/auth/me')).json.user;
  assert.equal(me.twoFactorSetupRequired, true, 'held at setup with the switch off');
  assert.equal(me.pinSetupRequired, false);
  const on = await admin.put('/auth/security-settings', { requireAdminTwoFactor: true });
  assert.equal(on.status, 200, 'still accepted (and stored)');
  assert.equal(on.json.requireAdminTwoFactor, true);
  assert.equal((await second.get('/auth/me')).status, 200, 'nobody is signed out by it');
  assert.equal((await rep.get('/me/dashboard')).status, 200, 'everyone with two-step carries on');
  const blocked = await second.get('/me/dashboard');
  assert.equal(blocked.status, 403);
  assert.deepEqual(blocked.json, { error: 'Set up two-step verification to carry on', twoFactorSetupRequired: true });
  assert.equal((await second.get('/auth/2fa')).status, 200);
  assert.equal((await second.post('/auth/pin', { pin: OTHER_PIN })).status, 204, 'PIN setup stays open');
  const secret = await enableTwoFactor(second);
  assert.ok(secret);
  assert.equal((await second.get('/me/dashboard')).status, 200, 'set up: the gate lifts');
  assert.equal((await admin.put('/auth/security-settings', { requireAdminTwoFactor: false })).status, 200);
  assert.equal((await second.get('/me/dashboard')).status, 200);

  const off = await admin.post('/auth/2fa/disable', { code: currentCode(db, fx().users.admin) });
  assert.equal(off.status, 409, 'every account keeps two-step on');
  assert.match(off.json.error, /required for every account/);
});

test('admin PIN status and reset: admin only, never yourself, 404 for nobody', async () => {
  await start();
  await withPin('repB');
  const leader = await srv!.login('leader');
  const admin = await srv!.login('admin');
  const target = fx().users.repB;
  assert.equal((await leader.get(`/auth/pin/${target}`)).status, 403);
  assert.equal((await leader.post(`/auth/pin/reset/${target}`)).status, 403);
  assert.equal((await srv!.anon().post(`/auth/pin/reset/${target}`)).status, 401);
  assert.equal((await admin.get('/auth/pin/999999')).status, 404);
  assert.equal((await admin.get('/auth/pin/abc')).status, 400);
  assert.equal((await admin.post('/auth/pin/reset/999999')).status, 404);
  assert.equal((await admin.post(`/auth/pin/reset/${fx().users.admin}`)).status, 400, 'your own PIN lives in Settings');
  const status = (await admin.get(`/auth/pin/${target}`)).json as Json;
  assert.deepEqual(Object.keys(status).sort(), ['hasPin', 'locked', 'required', 'setAt']);
  assert.equal(status.hasPin, true);
  assert.equal((await admin.post(`/auth/pin/reset/${target}`)).status, 400, 'the admin’s fresh two-step code is needed');
  assert.equal((await admin.post(`/auth/pin/reset/${target}`, { code: currentCode(srv!.db, fx().users.admin) })).status, 200);
  assert.equal((await admin.get(`/auth/pin/${target}`)).json.hasPin, false);
});

test('session idle timeout: default 12 h, admin sets 1–72, idle sessions end and last_seen is written once a minute', async () => {
  await start();
  const db = srv!.db;
  const admin = await srv!.login('admin');
  const rep = await srv!.login('rep');
  const leader = await srv!.login('leader');
  // the sessions table keeps the token's hash (lib/sessionKey.ts)
  const tokenOf = (c: TestClient) => sessionKey(c.cookie.replace('lm_session=', ''));
  const seenAt = (c: TestClient) => get<{ s: string | null }>(db, `SELECT last_seen_at AS s FROM sessions WHERE token = ?`, [tokenOf(c)])?.s;
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
  const H = 3_600_000;

  // Default 12 hours: 11 hours idle is fine, 13 is not.
  run(db, `UPDATE sessions SET last_seen_at = ? WHERE token = ?`, [ago(11 * H), tokenOf(leader)]);
  assert.equal((await leader.get('/auth/me')).status, 200);
  assert.ok(Date.parse(seenAt(leader)!) > Date.now() - 60_000, 'a request refreshes last_seen');
  run(db, `UPDATE sessions SET last_seen_at = ? WHERE token = ?`, [ago(13 * H), tokenOf(leader)]);
  assert.equal((await leader.get('/auth/me')).status, 401);
  assert.equal(seenAt(leader), undefined, 'the idle session is deleted');

  assert.equal((await admin.put('/auth/security-settings', { sessionIdleHours: 1 })).json.sessionIdleHours, 1);
  run(db, `UPDATE sessions SET last_seen_at = ? WHERE token = ?`, [ago(2 * H), tokenOf(rep)]);
  assert.equal((await rep.get('/auth/me')).status, 401, 'two hours idle with a one-hour timeout');

  const fresh = await srv!.login('rep');
  const stamp = ago(LAST_SEEN_RESOLUTION_MS / 2);
  run(db, `UPDATE sessions SET last_seen_at = ? WHERE token = ?`, [stamp, tokenOf(fresh)]);
  assert.equal((await fresh.get('/auth/me')).status, 200);
  assert.equal(seenAt(fresh), stamp, 'seen under a minute ago: no write');

  // The sweep removes idle sessions too.
  const idle = await srv!.login('repA2');
  run(db, `UPDATE sessions SET last_seen_at = ? WHERE token = ?`, [ago(90 * 60_000), tokenOf(idle)]);
  purgeExpiredSessions(db);
  assert.equal(seenAt(idle), undefined);
  assert.notEqual(seenAt(fresh), undefined);
  assert.equal((await admin.get('/auth/security-settings')).json.sessionIdleHours, 1);
});

test('extension upgrade on an existing database: columns added once, open sessions count as seen at the upgrade', () => {
  const db = openDb(':memory:');
  createSchema(db);
  db.exec(`ALTER TABLE sessions DROP COLUMN last_seen_at`);
  db.exec(`ALTER TABLE users DROP COLUMN pin_hash`);
  db.exec(`INSERT INTO pay_plans (name, position, base_per_day, commission_per_sale, bonus_threshold, bonus_amount, override_per_team_sale) VALUES ('P', 'field_rep', 60, 45, 12, 75, 0)`);
  db.exec(`INSERT INTO users (employee_id, email, first_name, last_name, role, position, team_id, pay_plan_id, start_date, status, phone, avatar_color, city)
           VALUES ('LM-0100', 'old@x.test', 'Old', 'Session', 'rep', 'field_rep', NULL, 1, '2025-01-06', 'active', NULL, '#000000', NULL)`);
  db.exec(`INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES ('old', 1, '2026-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z')`);
  const before = Date.now();
  assert.deepEqual(pinExtension.upgrade(db).sort(), ['sessions.last_seen_at', 'users.pin_hash']);
  const seen = get<{ s: string }>(db, `SELECT last_seen_at AS s FROM sessions WHERE token = 'old'`)!.s;
  assert.ok(Date.parse(seen) >= before - 1000, 'backfilled to the upgrade time');
  assert.deepEqual(pinExtension.upgrade(db), [], 'idempotent');
  assert.deepEqual(createSchema(db), [], 'nothing left to upgrade');
  db.close();
});
