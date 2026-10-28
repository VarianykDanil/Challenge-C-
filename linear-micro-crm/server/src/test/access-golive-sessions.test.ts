/**
 * Release check of 1.5.0 (SECURITY-MISSED-1 on an upgraded database): a session made without a setup code outlived the
 * rule that an account without two-step signs in only with one. On a 1.4 database upgraded to 1.5, a real
 * administrator's 1.4 session (email and employee ID only) set up two-step and then made another administrator, and
 * one-tap sessions survived `npm run golive`. Now:
 *  - going live signs everyone out (sessions and half-finished two-step sign-ins), so each person signs in again under
 *    the live rules;
 *  - a session of an account without two-step that is not a one-tap demo account works only when it was made with a
 *    setup code: any other (a 1.4 session, a one-tap session after the demo sign-ins were switched off) is signed out.
 */
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { get, run, type Db } from '../db/connection.ts';
import { goLive } from '../lib/goLive.ts';
import { todayISO } from '../lib/dates.ts';
import { sessionKey } from '../middleware/auth.ts';
import { DEMO_ACCOUNTS, currentCode, enrolTwoFactor, startTestServer, TestClient, type TestServer } from './helpers.ts';

let srv: TestServer | null = null;
afterEach(async () => {
  await srv?.close();
  srv = null;
});

const db = (): Db => srv!.db;
const count = (sql: string, params: (string | number)[] = []) => Number(get<{ n: number }>(db(), sql, params)!.n);

/** A person of the office's own, added during the trial. */
function addPerson(role: 'admin' | 'rep', email: string, employeeId: string): { id: number; email: string; employeeId: string } {
  const plan = get<{ id: number }>(db(), `SELECT id FROM pay_plans ORDER BY id LIMIT 1`)!.id;
  const id = run(
    db(),
    `INSERT INTO users (employee_id, email, first_name, last_name, role, position, team_id, pay_plan_id, start_date, status, phone, avatar_color, city)
     VALUES (?, ?, 'Real', 'Person', ?, ?, NULL, ?, ?, 'active', NULL, '#4F46E5', 'Manchester')`,
    [employeeId, email, role, role === 'admin' ? 'assistant_owner' : 'field_rep', plan, todayISO()],
  ).lastInsertRowid;
  return { id, email, employeeId };
}

/** A session as 1.4 left it (no setup code existed then), with the cookie its device holds. */
function oldSession(userId: number): TestClient {
  const token = randomBytes(32).toString('hex');
  const now = new Date().toISOString();
  run(db(), `INSERT INTO sessions (token, user_id, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?)`, [
    sessionKey(token), userId, now, new Date(Date.now() + 14 * 86_400_000).toISOString(), now,
  ]);
  const c = new TestClient(srv!.base);
  c.cookie = `lm_session=${token}`;
  return c;
}

test('golive signs everyone out: sessions and half-finished two-step sign-ins made before it no longer work', async () => {
  srv = await startTestServer({ seed: true });
  // an administrator of the office's own with two-step, and a rep who signed in with a setup code
  const admin = addPerson('admin', 'real.admin@office.example', 'LM-0700');
  enrolTwoFactor(db(), admin.id);
  const rep = addPerson('rep', 'real.rep@office.example', 'LM-0701');
  const adminClient = await srv.login({ email: admin.email, employeeId: admin.employeeId });
  const repClient = await srv.login({ email: rep.email, employeeId: rep.employeeId }, undefined, { twoFactor: false });
  const demoOwner = await srv.login('admin');
  for (const c of [adminClient, repClient, demoOwner]) assert.equal((await c.get('/auth/me')).status, 200);
  // a sign-in waiting at its two-step step
  const step1 = await srv.anon().post('/auth/login', { email: admin.email, employeeId: admin.employeeId });
  assert.equal(step1.json.requiresTwoFactor, true);

  const result = goLive(db(), {});
  assert.equal(result.owner, null, 'the real administrator stays');
  assert.equal(result.signedOut, 2, 'the two who stay (the demo owner’s session went with the demo owner)');
  assert.equal(count(`SELECT COUNT(*) AS n FROM sessions`), 0);
  assert.equal(count(`SELECT COUNT(*) AS n FROM two_factor_challenges`), 0);
  srv.resetCache();
  for (const c of [adminClient, repClient, demoOwner]) assert.equal((await c.get('/auth/me')).status, 401);
  const step2 = await srv.anon().post('/auth/login/2fa', { challengeToken: step1.json.challengeToken, code: currentCode(db(), admin.id) });
  assert.equal(step2.status, 410, 'the half-finished sign-in starts again');
  // they sign in again under the live rules: the administrator with two-step, the rep with a setup code
  assert.equal((await (await srv.login({ email: admin.email, employeeId: admin.employeeId })).get('/auth/me')).status, 200);
  assert.deepEqual((await srv.anon().post('/auth/login', { email: rep.email, employeeId: rep.employeeId })).json, { requiresSetupCode: true });
});

test('a session made without a setup code for an account without two-step is signed out (a 1.4 session on the trial)', async () => {
  srv = await startTestServer({ seed: true });
  const robin = addPerson('admin', 'robin.real@office.example', 'LM-0702');
  const stale = oldSession(robin.id);
  assert.equal((await stale.get('/auth/me')).status, 401);
  assert.equal(count(`SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?`, [robin.id]), 0, 'the session is gone');
  const again = oldSession(robin.id);
  assert.equal((await again.post('/auth/2fa/setup', {})).status, 401, 'no two-step setup without the setup code');
  assert.equal((await again.post('/users', { firstName: 'Shadow', lastName: 'Admin', role: 'admin' })).status, 401);
  assert.equal(get<{ p: string | null }>(db(), `SELECT totp_pending_enc AS p FROM users WHERE id = ?`, [robin.id])!.p, null);

  // signed in with a setup code, the same person sets up two-step as before
  const fresh = await srv.login({ email: robin.email, employeeId: robin.employeeId }, undefined, { twoFactor: false });
  assert.equal((await fresh.get('/auth/me')).json.user.twoFactorSetupRequired, true);
  assert.equal((await fresh.post('/auth/2fa/setup', {})).status, 201);

  // an account with two-step keeps its old session (it could sign in without a setup code anyway)
  const casey = addPerson('rep', 'casey.real@office.example', 'LM-0703');
  enrolTwoFactor(db(), casey.id);
  assert.equal((await oldSession(casey.id).get('/auth/me')).status, 200);
  // and a one-tap demo account's session is what one-tap makes
  assert.equal((await oldSession(get<{ id: number }>(db(), `SELECT id FROM users WHERE employee_id = ?`, [DEMO_ACCOUNTS.rep.employeeId])!.id).get('/auth/me')).status, 200);
});

test('a one-tap session ends when the demo sign-ins are switched off (that account then needs a setup code)', async () => {
  srv = await startTestServer({ seed: true });
  const owner = await srv.login('admin');
  assert.equal((await owner.get('/auth/me')).status, 200);
  const prev = process.env.LM_DEMO_ACCOUNTS;
  process.env.LM_DEMO_ACCOUNTS = '0';
  try {
    srv.resetCache();
    assert.equal((await owner.post('/auth/2fa/setup', {})).status, 401);
    assert.equal((await owner.get('/auth/me')).status, 401);
  } finally {
    if (prev === undefined) delete process.env.LM_DEMO_ACCOUNTS;
    else process.env.LM_DEMO_ACCOUNTS = prev;
  }
});
