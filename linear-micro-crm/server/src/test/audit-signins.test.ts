/**
 * Release 1.3 — P9 audit-everything: failed sign-ins and security checks are recorded (kind `sign_in`), filed under the
 * account they were tried on, worded plainly, and never with what was typed (the PIN, the employee ID, the code, the
 * challenge token). Validation answers write nothing. A flood of unknown emails from one address stops being recorded
 * after FAILED_ROWS_PER_SOURCE rows in 15 minutes, with one row that says so; a try on a real account is bounded by that
 * account's own budget only, so the flood never hides it.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { PIN_LOCK_AFTER_FAILURES } from '@lm/shared';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../app.ts';
import { all, get, openDb, run, type Db } from '../db/connection.ts';
import { createSchema } from '../db/schema.ts';
import { FAILED_ROWS_ALL, FAILED_ROWS_PER_ACCOUNT, FAILED_ROWS_PER_SOURCE } from '../lib/audit.ts';
import { IDLE_SIGN_OUT_ACTION } from '../lib/audit/sessions.ts';
import { SIGN_IN_MESSAGES } from '../lib/audit/signIns.ts';
import { purgeExpiredSessions } from '../middleware/auth.ts';
import { hashPin, savePinHash } from '../lib/pin.ts';
import { totp } from '../lib/totp.ts';
import { INVALID_LOGIN, PIN_MESSAGES, resetLoginFailures } from '../routes/auth.ts';
import { FIXTURE_ACCOUNTS, buildFixture, startTestServer, type TestClient, type TestServer } from './helpers.ts';

let srv: TestServer;
const fx = () => srv.fixture!;
const PIN = '2468';

interface Row {
  id: number;
  userId: number | null;
  action: string;
  entity: string | null;
  entityId: number | null;
  summary: string;
  afterJson: string | null;
  kind: string | null;
}
const rows = (db: Db, where = '', params: (string | number)[] = []) =>
  all<Row>(db, `SELECT id, user_id AS userId, action, entity, entity_id AS entityId, summary, after_json AS afterJson, kind FROM audit_log ${where} ORDER BY id`, params);
const count = (db: Db) => Number(get<{ n: number }>(db, `SELECT COUNT(*) AS n FROM audit_log`)!.n);
const newest = (db: Db) => rows(db).at(-1)!;

/** A person of team A with a sign-in PIN (their own email, so other tests' limiters are not shared). */
async function personWithPin(db: Db, email: string, employeeId: string): Promise<number> {
  const id = run(
    db,
    `INSERT INTO users (employee_id, email, first_name, last_name, role, position, team_id, pay_plan_id, start_date, status, avatar_color)
     VALUES (?, ?, 'Pat', 'Pin', 'rep', 'field_rep', ?, ?, '2025-01-06', 'active', '#4F46E5')`,
    [employeeId, email, fx().teams.a, fx().plans.rep],
  ).lastInsertRowid;
  savePinHash(db, id, await hashPin(PIN));
  return id;
}

before(async () => {
  srv = await startTestServer();
});

after(async () => {
  await srv.close();
});

test('the words the failure hooks recognise are the ones routes/auth.ts answers with', () => {
  assert.equal(SIGN_IN_MESSAGES.wrongCurrentPin, PIN_MESSAGES.wrongCurrent);
  assert.equal(INVALID_LOGIN, 'Invalid email or employee ID');
});

test('a wrong employee ID, a deactivated account and an unknown email: one sign-in row each, filed under the account', async () => {
  const n = count(srv.db);
  assert.equal((await srv.anon().post('/auth/login', { email: fx().accounts.rep.email, employeeId: 'FX-9999' })).status, 401);
  let r = newest(srv.db);
  assert.equal(r.summary, 'Failed sign-in: wrong employee ID');
  assert.deepEqual([r.userId, r.entity, r.entityId, r.kind, r.action], [fx().users.rep, 'user', fx().users.rep, 'sign_in', 'POST /auth/login']);
  assert.ok(!r.afterJson!.includes('FX-9999'), 'the employee ID typed is never stored');

  const left = run(srv.db, `INSERT INTO users (employee_id, email, first_name, last_name, role, position, team_id, pay_plan_id, start_date, status, avatar_color)
    VALUES ('FX-0090', 'gone@fixture.test', 'Gil', 'Gone', 'rep', 'field_rep', ?, ?, '2025-01-06', 'left', '#4F46E5')`, [fx().teams.a, fx().plans.rep]).lastInsertRowid;
  assert.equal((await srv.anon().post('/auth/login', { email: 'GONE@fixture.test', employeeId: 'FX-0090' })).status, 401);
  r = newest(srv.db);
  assert.equal(r.summary, 'Failed sign-in: the account is deactivated');
  assert.equal(r.userId, left);

  assert.equal((await srv.anon().post('/auth/login', { email: ' Nobody@Example.test ', employeeId: 'LM-0001' })).status, 401);
  r = newest(srv.db);
  assert.equal(r.summary, 'Failed sign-in with an unknown email: nobody@example.test');
  assert.deepEqual([r.userId, r.entity, r.entityId, r.kind], [null, null, null, 'sign_in']);
  assert.equal(JSON.parse(r.afterJson!).typedEmail, 'nobody@example.test');
  assert.ok(!r.afterJson!.includes('LM-0001'));
  assert.equal(count(srv.db), n + 3);

  // an employee ID typed into the email box is not an email: it is never stored (only the fact of the try is)
  assert.equal((await srv.anon().post('/auth/login', { email: 'LM-0010', employeeId: 'x' })).status, 401);
  r = newest(srv.db);
  assert.equal(r.summary, 'Failed sign-in with an unknown email');
  assert.deepEqual(JSON.parse(r.afterJson!), { reason: 'unknown_email', typedEmail: null });
  assert.ok(!r.afterJson!.toLowerCase().includes('lm-0010') && !r.summary.toLowerCase().includes('lm-0010'));
  assert.equal(count(srv.db), n + 4);

  // an "email" with a right-to-left override (it would display as danil.v@linear-mcr.co.uk): never stored or shown
  const disguised = `‮${[...'danil.v@linear-mcr.co.uk'].reverse().join('')}`;
  assert.equal((await srv.anon().post('/auth/login', { email: disguised, employeeId: 'x' })).status, 401);
  r = newest(srv.db);
  assert.equal(r.summary, 'Failed sign-in with an unknown email');
  assert.deepEqual(JSON.parse(r.afterJson!), { reason: 'unknown_email', typedEmail: null });
  assert.equal(count(srv.db), n + 5);

  // a missing field is a validation answer: nobody tried a credential
  assert.equal((await srv.anon().post('/auth/login', { email: fx().accounts.rep.email })).status, 400);
  assert.equal((await srv.anon().post('/auth/login', {})).status, 400);
  assert.equal(count(srv.db), n + 5);
});

test('a wrong PIN says how many tries are left; the try that locks the PIN, and tries during the lock, are recorded', async () => {
  const id = await personWithPin(srv.db, 'pat.pin@fixture.test', 'FX-0091');
  const login = (pin: string) => srv.anon().post('/auth/login', { email: 'pat.pin@fixture.test', employeeId: 'FX-0091', pin });
  const n = count(srv.db);
  assert.equal((await login('1357')).status, 401);
  let r = newest(srv.db);
  assert.equal(r.summary, `Failed sign-in: wrong PIN (${PIN_LOCK_AFTER_FAILURES - 1} tries left before a lock)`);
  assert.deepEqual([r.userId, r.entity, r.entityId, r.kind], [id, 'user', id, 'sign_in']);
  assert.ok(!r.afterJson!.includes('1357'), 'the PIN typed is never stored');
  for (let i = 2; i < PIN_LOCK_AFTER_FAILURES; i++) {
    resetLoginFailures(); // the login limiter (8 a quarter-hour) would answer 429 first; this test is about the PIN lock
    assert.equal((await login('1357')).status, 401);
  }
  assert.equal(newest(srv.db).summary, 'Failed sign-in: wrong PIN (1 try left before a lock)');
  resetLoginFailures();
  assert.equal((await login('1357')).status, 423, 'the tenth wrong PIN locks it');
  r = newest(srv.db);
  assert.match(r.summary, new RegExp(`^PIN locked after ${PIN_LOCK_AFTER_FAILURES} wrong PINs in a row, until \\d{2}:\\d{2}`));
  resetLoginFailures();
  assert.equal((await login(PIN)).status, 423, 'even the right PIN waits for the lock');
  assert.match(newest(srv.db).summary, /^Sign-in refused: the PIN is locked until \d{2}:\d{2}/);
  assert.equal(count(srv.db), n + PIN_LOCK_AFTER_FAILURES + 1);
  // the step that asks for the PIN (no PIN sent yet) is not a failure
  run(srv.db, `UPDATE users SET pin_locked_until = NULL, pin_failed_attempts = 0 WHERE id = ?`, [id]);
  resetLoginFailures();
  const step = await srv.anon().post('/auth/login', { email: 'pat.pin@fixture.test', employeeId: 'FX-0091' });
  assert.equal(step.json.requiresPin, true);
  assert.equal(count(srv.db), n + PIN_LOCK_AFTER_FAILURES + 1);
  resetLoginFailures();
});

test('the login limiter\'s refusal (429) is recorded, with when to try again', async () => {
  resetLoginFailures();
  for (let i = 0; i < 8; i++) assert.equal((await srv.anon().post('/auth/login', { email: fx().accounts.repA2.email, employeeId: `X-${i}` })).status, 401);
  const refused = await srv.anon().post('/auth/login', { email: fx().accounts.repA2.email, employeeId: fx().accounts.repA2.employeeId });
  assert.equal(refused.status, 429);
  const r = newest(srv.db);
  assert.match(r.summary, /^Sign-in refused: too many attempts, try again in \d+ minutes?$/);
  assert.equal(r.userId, fx().users.repA2);
  resetLoginFailures();
});

test('two-step: a wrong code at sign-in, and wrong codes in Settings, are recorded; the code never is', async () => {
  const lee = await srv.login('leader');
  const setup = await lee.post('/auth/2fa/setup');
  assert.equal(setup.status, 201);
  const n0 = count(srv.db);
  assert.equal((await lee.post('/auth/2fa/enable', { code: '000000' })).status, 400);
  assert.equal(newest(srv.db).summary, 'Wrong two-step code while turning on two-step verification');
  assert.equal(newest(srv.db).kind, 'sign_in');
  assert.equal(count(srv.db), n0 + 1);
  assert.equal((await lee.post('/auth/2fa/enable', { code: totp(setup.json.secret) })).status, 200);
  assert.equal(newest(srv.db).summary, 'Turned on two-step verification');
  assert.equal(newest(srv.db).kind, 'change');

  const step1 = await srv.anon().post('/auth/login', fx().accounts.leader);
  assert.equal(step1.json.requiresTwoFactor, true);
  const n1 = count(srv.db);
  assert.equal(n1, n0 + 2, 'step one (a challenge, no session) writes nothing');
  const wrong = await srv.anon().post('/auth/login/2fa', { challengeToken: step1.json.challengeToken, code: '000000' });
  assert.equal(wrong.status, 401);
  const r = newest(srv.db);
  assert.equal(r.summary, 'Failed sign-in: wrong two-step code');
  assert.deepEqual([r.userId, r.entityId, r.kind, r.action], [fx().users.leader, fx().users.leader, 'sign_in', 'POST /auth/login/2fa']);
  assert.ok(!JSON.stringify(rows(srv.db, 'WHERE id > ?', [n0])).includes(step1.json.challengeToken), 'the challenge token is never stored');
  // an unknown challenge has no account to file anything under
  assert.equal((await srv.anon().post('/auth/login/2fa', { challengeToken: 'not-a-token', code: '123456' })).status, 410);
  assert.equal(count(srv.db), n1 + 1);

  assert.equal((await lee.post('/auth/2fa/recovery-codes', { code: '000000' })).status, 400);
  assert.equal(newest(srv.db).summary, 'Wrong two-step code while making new recovery codes');
  assert.equal((await lee.post('/auth/2fa/disable', { code: '000000' })).status, 400);
  assert.equal(newest(srv.db).summary, 'Wrong two-step code while turning off two-step verification');
  assert.equal(newest(srv.db).userId, fx().users.leader);
  assert.equal((await lee.post('/auth/2fa/disable', {})).status, 400, 'validation');
  assert.equal(count(srv.db), n1 + 3);
  resetLoginFailures();
});

test('PIN settings: a wrong current PIN while changing or removing it is recorded; removing it is a change ("Removed their PIN")', async () => {
  await personWithPin(srv.db, 'pia.pin@fixture.test', 'FX-0092');
  const pia: TestClient = await srv.login({ email: 'pia.pin@fixture.test', employeeId: 'FX-0092' }, PIN);
  const n = count(srv.db);
  assert.equal((await pia.post('/auth/pin', { pin: '3579', currentPin: '0000' })).status, 400);
  assert.equal(newest(srv.db).summary, 'Wrong current PIN while changing their PIN');
  assert.equal((await pia.post('/auth/pin/remove', { currentPin: '0000' })).status, 400);
  assert.equal(newest(srv.db).summary, 'Wrong current PIN while removing their PIN');
  assert.equal((await pia.post('/auth/pin', { pin: '1111', currentPin: PIN })).status, 400, 'a PIN that breaks the rules: validation');
  assert.equal((await pia.post('/auth/pin', { pin: '3579' })).status, 400, 'no current PIN sent: validation');
  assert.equal(count(srv.db), n + 2);
  assert.equal((await pia.post('/auth/pin/remove', { currentPin: PIN })).status, 204);
  const r = newest(srv.db);
  assert.equal(r.summary, 'Removed their PIN');
  assert.equal(r.kind, 'change');
  assert.equal(JSON.parse(r.afterJson!).pinSet, false);
  assert.ok(!r.afterJson!.includes(PIN));
});

test('nothing typed is ever stored: no PIN, employee ID or code in any sign-in row', () => {
  const text = JSON.stringify(rows(srv.db, `WHERE kind = 'sign_in'`));
  for (const typed of ['1357', 'FX-9999', 'X-3', '000000', '0000"', PIN]) assert.ok(!text.includes(typed), typed);
});

test(`a flood of failed sign-ins from one address stops being recorded after ${FAILED_ROWS_PER_SOURCE}, with one row that says so`, async () => {
  const flood = await startTestServer();
  try {
    const n = count(flood.db);
    for (let i = 0; i < FAILED_ROWS_PER_SOURCE + 10; i++) {
      const r = await flood.anon().post('/auth/login', { email: `bot${i}@example.test`, employeeId: 'LM-0001' });
      assert.equal(r.status, 401);
    }
    const added = rows(flood.db, 'WHERE id > ?', [n]);
    assert.equal(added.length, FAILED_ROWS_PER_SOURCE + 1);
    assert.ok(added.slice(0, FAILED_ROWS_PER_SOURCE).every((r) => r.summary.startsWith('Failed sign-in with an unknown email')));
    // the cap is a count in a 15-minute window, not "in a row"
    assert.match(added.at(-1)!.summary, new RegExp(`^Stopped recording failed sign-ins with unknown emails from .+ after ${FAILED_ROWS_PER_SOURCE} in 15 minutes; recording starts again within 15 minutes$`));
    assert.equal(added.at(-1)!.kind, 'sign_in');
    // successful sign-ins are never held back
    await flood.login('admin');
    assert.equal(newest(flood.db).summary, 'Signed in');
  } finally {
    await flood.close();
  }
});

/** A server behind a trusted proxy, so each request can come "from" its own address (X-Forwarded-For). */
async function proxiedServer() {
  const db = openDb(':memory:');
  createSchema(db);
  const fixture = buildFixture(db);
  resetLoginFailures();
  const server = http.createServer(createApp(db, { trustProxy: true }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const login = async (from: string, body: unknown) =>
    (await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': from }, body: JSON.stringify(body) })).status;
  const close = async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  };
  /** An admin session's GET (the fixture's owner, no PIN), for reading what was recorded through the API. */
  const adminGet = async (path: string) => {
    const signIn = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.250.0.1' }, body: JSON.stringify(FIXTURE_ACCOUNTS.admin) });
    const cookie = /lm_session=[^;]*/.exec(signIn.headers.get('set-cookie') ?? '')?.[0] ?? '';
    return (await fetch(`${base}${path}`, { headers: { cookie } })).json();
  };
  return { db, fixture, login, adminGet, close };
}

const address = (i: number) => `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`;

test(`a flood from many addresses cannot hide a try on a real account: unknown emails stop at ${FAILED_ROWS_ALL}, each account has a budget of its own (${FAILED_ROWS_PER_ACCOUNT})`, async () => {
  const p = await proxiedServer();
  try {
    const n = count(p.db);
    // 1. the flood: an email nobody has, every try from another address (no address reaches its own cap)
    for (let i = 0; i < FAILED_ROWS_ALL + 20; i += 20) {
      const batch = Array.from({ length: 20 }, (_, k) => p.login(address(1 + i + k), { email: `bot${i + k}@example.test`, employeeId: 'LM-0001' }));
      assert.ok((await Promise.all(batch)).every((s) => s === 401));
    }
    let added = rows(p.db, 'WHERE id > ?', [n]);
    assert.equal(added.length, FAILED_ROWS_ALL + 1, 'the unknown-email rows stop at the cap, with one row that says so');
    assert.equal(added.filter((r) => r.summary.startsWith('Failed sign-in with an unknown email')).length, FAILED_ROWS_ALL);
    const paused = added.find((r) => r.summary.startsWith('Stopped recording'))!;
    assert.equal(paused.summary, `Stopped recording failed sign-ins with unknown emails after ${FAILED_ROWS_ALL} in 15 minutes from many addresses; recording starts again within 15 minutes`);
    assert.equal(paused.userId, null);

    // 2. a try on the owner's account, from yet another address: still recorded, filed under the owner
    const m = count(p.db);
    assert.equal(await p.login(address(5000), { email: FIXTURE_ACCOUNTS.admin.email, employeeId: 'FX-9999' }), 401);
    added = rows(p.db, 'WHERE id > ?', [m]);
    assert.equal(added.length, 1);
    assert.equal(added[0]!.summary, 'Failed sign-in: wrong employee ID');
    assert.equal(added[0]!.userId, p.fixture.users.admin);
    // …while one more unknown email is not
    assert.equal(await p.login(address(5001), { email: 'one.more@example.test', employeeId: 'LM-0001' }), 401);
    assert.equal(count(p.db), m + 1);

    // 3. one account's own budget: tries on Remy's account from many addresses stop being recorded after the cap
    const k = count(p.db);
    for (let i = 0; i < FAILED_ROWS_PER_ACCOUNT + 5; i++) {
      const status = await p.login(address(6000 + i), { email: FIXTURE_ACCOUNTS.rep.email, employeeId: `X-${i}` });
      assert.ok(status === 401 || status === 429, String(status)); // the per-email login limiter answers 429 after 20
    }
    added = rows(p.db, 'WHERE id > ?', [k]);
    assert.equal(added.length, FAILED_ROWS_PER_ACCOUNT + 1);
    assert.ok(added.slice(0, FAILED_ROWS_PER_ACCOUNT).every((r) => r.userId === p.fixture.users.rep && r.entity === 'user' && r.entityId === p.fixture.users.rep));
    const accountPause = added.at(-1)!;
    assert.equal(accountPause.summary, `Stopped recording failed sign-ins on Remy Rep's account after ${FAILED_ROWS_PER_ACCOUNT} in 15 minutes; recording starts again within 15 minutes`);
    assert.deepEqual([accountPause.userId, accountPause.entity, accountPause.entityId, accountPause.kind], [null, 'user', p.fixture.users.rep, 'sign_in']);
    // …and another account is not affected
    assert.equal(await p.login(address(7000), { email: FIXTURE_ACCOUNTS.repA2.email, employeeId: 'X-1' }), 401);
    assert.equal(newest(p.db).userId, p.fixture.users.repA2);
  } finally {
    await p.close();
  }
});

test('one address: made-up emails up to its cap, then a try on a real account from that address is still recorded', async () => {
  const p = await proxiedServer();
  try {
    const from = '10.66.66.66';
    const n = count(p.db);
    for (let i = 0; i < FAILED_ROWS_PER_SOURCE; i++) assert.equal(await p.login(from, { email: `junk${i}@example.test`, employeeId: 'LM-0000' }), 401);
    let added = rows(p.db, 'WHERE id > ?', [n]);
    assert.equal(added.length, FAILED_ROWS_PER_SOURCE + 1);
    assert.equal(added.at(-1)!.summary, `Stopped recording failed sign-ins with unknown emails from ${from} after ${FAILED_ROWS_PER_SOURCE} in 15 minutes; recording starts again within 15 minutes`);
    // the address's room for unknown emails is used up…
    const m = count(p.db);
    assert.equal(await p.login(from, { email: 'junk.more@example.test', employeeId: 'LM-0000' }), 401);
    assert.equal(count(p.db), m, 'one more unknown email: not recorded');
    // …but a try on the leader's account from the same address is recorded, filed under the leader
    assert.equal(await p.login(from, { email: FIXTURE_ACCOUNTS.leader.email, employeeId: 'LM-0000' }), 401);
    added = rows(p.db, 'WHERE id > ?', [m]);
    assert.equal(added.length, 1);
    assert.deepEqual([added[0]!.summary, added[0]!.userId], ['Failed sign-in: wrong employee ID', p.fixture.users.leader]);
    const activity = await p.adminGet(`/audit/person/${p.fixture.users.leader}`);
    assert.equal(activity.failedSignIns, 1, 'on the leader\'s Activity');
  } finally {
    await p.close();
  }
});

test('an account\'s pause note is on that person\'s Activity, as Linear Hub\'s, and is not them being active', async () => {
  const p = await proxiedServer();
  try {
    for (let i = 0; i < FAILED_ROWS_PER_ACCOUNT + 2; i++) {
      const status = await p.login(address(9000 + i), { email: FIXTURE_ACCOUNTS.recruiter.email, employeeId: `X-${i}` });
      assert.ok(status === 401 || status === 429, String(status));
    }
    const activity = await p.adminGet(`/audit/person/${p.fixture.users.recruiter}`);
    const pause = activity.rows.find((r: { summary: string }) => r.summary.startsWith('Stopped recording'));
    assert.ok(pause, 'the pause note is listed');
    assert.equal(pause.summary, `Stopped recording failed sign-ins on Rae Recruiter's account after ${FAILED_ROWS_PER_ACCOUNT} in 15 minutes; recording starts again within 15 minutes`);
    assert.equal(pause.userName, null, 'no actor: the Audit page names it Linear Hub');
    assert.equal(activity.failedSignIns, FAILED_ROWS_PER_ACCOUNT);
    assert.equal(activity.lastActiveAt, null, 'tries on the account, and the note, are not the recruiter being active');
    assert.equal(activity.total, FAILED_ROWS_PER_ACCOUNT + 1);
  } finally {
    await p.close();
  }
});

test('a sign-out by the idle timeout is recorded once, under the person, when they come back or at start-up', async () => {
  const s = await startTestServer();
  try {
    const db = s.db;
    const tokenOf = (c: TestClient) => c.cookie.replace('lm_session=', '');
    const ago = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
    const idleRows = () => rows(db, `WHERE action = ?`, [IDLE_SIGN_OUT_ACTION]);
    const SUMMARY = /^Signed out after 12 hours without activity \(last active \d{2}:\d{2} [A-Z][a-z]{2} \d{1,2} [A-Z][a-z]{2}\)$/;

    // 1. the leader comes back 13 hours later (the default timeout is 12): one sign-out row, then nothing more
    const leader = await s.login('leader');
    run(db, `UPDATE sessions SET last_seen_at = ? WHERE token = ?`, [ago(13), tokenOf(leader)]);
    assert.equal((await leader.get('/auth/me')).status, 401);
    assert.equal((await leader.get('/auth/me')).status, 401);
    let idle = idleRows();
    assert.equal(idle.length, 1);
    assert.deepEqual([idle[0]!.userId, idle[0]!.kind, idle[0]!.entity], [fx2(s).users.leader, 'sign_in', null]);
    assert.match(idle[0]!.summary, SUMMARY);
    // 11 hours is still inside the timeout: nothing
    const rep = await s.login('rep');
    run(db, `UPDATE sessions SET last_seen_at = ? WHERE token = ?`, [ago(11), tokenOf(rep)]);
    assert.equal((await rep.get('/auth/me')).status, 200);
    assert.equal(idleRows().length, 1);

    // 2. start-up: an idle session of a current account is a sign-out; a 14-day expiry and a deactivated account are not
    const recruiter = await s.login('recruiter');
    run(db, `UPDATE sessions SET last_seen_at = ? WHERE token = ?`, [ago(20), tokenOf(recruiter)]);
    const repB = await s.login('repB');
    run(db, `UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE token = ?`, [ago(20), ago(1), tokenOf(repB)]);
    const repA2 = await s.login('repA2');
    run(db, `UPDATE sessions SET last_seen_at = ? WHERE token = ?`, [ago(20), tokenOf(repA2)]);
    run(db, `UPDATE users SET status = 'left' WHERE id = ?`, [fx2(s).users.repA2]);
    purgeExpiredSessions(db);
    idle = idleRows();
    assert.equal(idle.length, 2);
    assert.equal(idle[1]!.userId, fx2(s).users.recruiter);
    assert.match(idle[1]!.summary, SUMMARY);
    assert.equal(get<{ n: number }>(db, `SELECT COUNT(*) AS n FROM sessions`)!.n, 1, 'only the rep\'s live session is left');

    // 3. it is a sign-out on the person's Activity, not them being active
    const admin = await s.login('admin');
    const activity = (await admin.get(`/audit/person/${fx2(s).users.recruiter}`)).json;
    assert.ok(activity.rows.some((r: { action: string }) => r.action === IDLE_SIGN_OUT_ACTION));
    const signIn = rows(db, `WHERE user_id = ? AND action = 'POST /auth/login'`, [fx2(s).users.recruiter]).length;
    assert.equal(signIn, 1);
    assert.ok(activity.lastActiveAt < get<{ at: string }>(db, `SELECT at FROM audit_log WHERE action = ? AND user_id = ?`, [IDLE_SIGN_OUT_ACTION, fx2(s).users.recruiter])!.at);
    // …and a Sign-ins row: the kind filter finds it
    const signIns = (await admin.get(`/audit?kind=sign_in&userId=${fx2(s).users.recruiter}`)).json;
    assert.ok(signIns.rows.some((r: { action: string }) => r.action === IDLE_SIGN_OUT_ACTION));
  } finally {
    await s.close();
  }
});

const fx2 = (s: TestServer) => s.fixture!;
