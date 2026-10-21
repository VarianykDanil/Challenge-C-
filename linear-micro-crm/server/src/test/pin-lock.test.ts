/**
 * Release 1.2 review fix S1: a PIN lock expires, so nobody (not even the only administrator) is locked out for good.
 *  - 10 wrong PINs in a row lock the PIN for 15 minutes; each further run of 10 wrong while the count is not reset
 *    doubles the lock (15 min, 30 min, 1 h … capped at 24 h). A right PIN or a reset clears the count and the lock.
 *  - The 423 says when it unlocks: "Too many wrong PINs. Try again after 14:35, or ask an administrator to reset your PIN."
 *  - `npm run pin:reset -- <email>` (server/src/pinReset.ts) clears one person's PIN and lock from the server itself.
 * The lock runs on the real clock (like sessions and the login limiter); "time passing" is simulated by moving
 * users.pin_locked_until into the past, the same way pin.test.ts ages sessions.last_seen_at.
 */
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PIN_LOCK_AFTER_FAILURES } from '@lm/shared';
import { all, get, openDb, run } from '../db/connection.ts';
import { createSchema } from '../db/schema.ts';
import { pinLockMinutes, pinLockedMessage, pinUnlockTime } from '../lib/pin.ts';
import { resetLoginFailures } from '../routes/auth.ts';
import { FIXTURE_ACCOUNTS, buildFixture, startTestServer, type Json, type TestClient, type TestServer } from './helpers.ts';

const GOOD_PIN = '5821';
const OTHER_PIN = '7390';
const WRONG_PIN = '9152';
const MINUTE = 60_000;
const SERVER_DIR = path.resolve(import.meta.dirname, '../..');

let srv: TestServer | null = null;
afterEach(async () => {
  await srv?.close();
  srv = null;
});

const fx = () => srv!.fixture!;
const lockOf = (userId: number) =>
  get<{ n: number; until: string | null }>(srv!.db, `SELECT pin_failed_attempts AS n, pin_locked_until AS until FROM users WHERE id = ?`, [userId])!;
/** "15 minutes later": the lock ends a second ago. */
const expireLock = (userId: number) => run(srv!.db, `UPDATE users SET pin_locked_until = ? WHERE id = ?`, [new Date(Date.now() - 1000).toISOString(), userId]);

/** Europe/London "HH:MM" of the minute the lock ends (rounded up), as the 423 sentence shows it. */
function londonTime(iso: string): string {
  const at = new Date(Math.ceil(Date.parse(iso) / MINUTE) * MINUTE);
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }).format(at);
}

const lockedSentence = (iso: string, now = Date.now()) => {
  const day = (ms: number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date(ms));
  const end = Math.ceil(Date.parse(iso) / MINUTE) * MINUTE;
  const when = day(end) === day(now) ? londonTime(iso) : `${londonTime(iso)} tomorrow`;
  return `Too many wrong PINs. Try again after ${when}, or ask an administrator to reset your PIN.`;
};

async function withPin(account: keyof typeof FIXTURE_ACCOUNTS, pin = GOOD_PIN): Promise<TestClient> {
  const client = await srv!.login(account);
  const r = await client.post('/auth/pin', { pin });
  assert.equal(r.status, 204, JSON.stringify(r.json));
  return client;
}

/** `n` wrong PINs at sign-in, forgetting the login limiter before each (as if spread over time and networks). */
async function wrongPins(account: keyof typeof FIXTURE_ACCOUNTS, n: number): Promise<{ status: number; json: Json }> {
  let last: { status: number; json: Json } = { status: 0, json: null };
  for (let i = 0; i < n; i++) {
    resetLoginFailures();
    last = await srv!.anon().post('/auth/login', { ...FIXTURE_ACCOUNTS[account], pin: WRONG_PIN });
  }
  return last;
}

test('the rule and the wording: lock minutes per wrong-PIN count, and the London time the lock ends (rounded up)', () => {
  const counts = [0, 1, 9, 10, 11, 19, 20, 30, 40, 50, 60, 70, 80, 90, 1000];
  assert.deepEqual(counts.map(pinLockMinutes), [0, 0, 0, 15, 0, 0, 30, 60, 120, 240, 480, 960, 1440, 1440, 1440]);
  const at = (iso: string) => Date.parse(iso);
  // British Summer Time (UTC+1) until 25 October 2026, then GMT.
  assert.equal(pinUnlockTime('2026-10-20T13:34:10.000Z', at('2026-10-20T13:19:10Z')), '14:35', 'seconds round up');
  assert.equal(pinUnlockTime('2026-10-20T13:35:00.000Z', at('2026-10-20T13:20:00Z')), '14:35', 'on the minute stays');
  assert.equal(pinUnlockTime('2026-10-26T10:00:00.000Z', at('2026-10-26T09:45:00Z')), '10:00', 'GMT after the clocks go back');
  assert.equal(pinUnlockTime('2026-10-20T23:05:00.000Z', at('2026-10-20T22:50:00Z')), '00:05 tomorrow', 'past midnight in London');
  assert.equal(pinUnlockTime('2026-10-21T13:19:10.000Z', at('2026-10-20T13:19:10Z')), '14:20 tomorrow', 'a 24-hour lock');
  assert.equal(pinUnlockTime('2026-10-22T22:59:30.000Z', at('2026-10-21T22:59:30Z')), '00:00 on 23 Oct', 'rounded into the day after');
  assert.equal(
    pinLockedMessage('2026-10-20T13:34:10.000Z', at('2026-10-20T13:19:10Z')),
    'Too many wrong PINs. Try again after 14:35, or ask an administrator to reset your PIN.',
  );
});

test('ten wrong PINs lock it for 15 minutes; the 423 says when; once the lock ends the right PIN signs in and clears it', async () => {
  srv = await startTestServer();
  const rep = await withPin('rep');
  const creds = FIXTURE_ACCOUNTS.rep;
  const ninth = await wrongPins('rep', PIN_LOCK_AFTER_FAILURES - 1);
  assert.equal(ninth.status, 401);
  assert.equal(ninth.json.details.attemptsLeft, 1);

  const before = Date.now();
  const tenth = await wrongPins('rep', 1);
  assert.equal(tenth.status, 423);
  const { n, until } = lockOf(fx().users.rep);
  assert.equal(n, PIN_LOCK_AFTER_FAILURES);
  assert.ok(until, 'the lock end is stored');
  const minutes = (Date.parse(until!) - before) / MINUTE;
  assert.ok(minutes > 14.9 && minutes < 15.1, `locked for 15 minutes (${minutes.toFixed(2)})`);
  assert.equal(tenth.json.error, lockedSentence(until!));
  assert.match(tenth.json.error, /^Too many wrong PINs\. Try again after \d{2}:\d{2}( tomorrow)?, or ask an administrator to reset your PIN\.$/);
  assert.deepEqual(tenth.json.details, { requiresPin: true, reason: 'locked', lockedUntil: until });

  resetLoginFailures();
  const during = await srv.anon().post('/auth/login', { ...creds, pin: GOOD_PIN });
  assert.equal(during.status, 423, 'locked even for the right PIN');
  assert.equal(during.json.error, lockedSentence(until!));
  resetLoginFailures();
  assert.equal((await srv.anon().post('/auth/login', creds)).status, 423, 'no PIN sent: still the lock, with its time');
  assert.equal(lockOf(fx().users.rep).n, PIN_LOCK_AFTER_FAILURES, 'tries during the lock are not counted');

  const status = (await rep.get('/auth/pin')).json;
  assert.equal(status.locked, true);
  assert.equal(status.lockedUntil, until);

  expireLock(fx().users.rep);
  assert.equal((await rep.get('/auth/pin')).json.locked, false, 'the lock has ended');
  assert.equal((await rep.get('/auth/pin')).json.lockedUntil, undefined, 'no lock time once it has ended');
  resetLoginFailures();
  const challenge = await srv.anon().post('/auth/login', creds);
  assert.deepEqual(challenge.json, { requiresPin: true, attemptsLeft: PIN_LOCK_AFTER_FAILURES }, 'a fresh run of ten');
  const ok = await srv.anon().post('/auth/login', { ...creds, pin: GOOD_PIN });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.deepEqual({ ...lockOf(fx().users.rep) }, { n: 0, until: null }, 'a right PIN clears the count and the lock');
});

test('each further run of ten wrong PINs, while the count is not reset, doubles the lock: 15 min, 30 min, 1 h … 24 h at most', async () => {
  srv = await startTestServer();
  await withPin('rep');
  const expected = [15, 30, 60, 120, 240, 480, 960, 1440, 1440];
  for (const [run, mins] of expected.entries()) {
    const before = Date.now();
    const r = await wrongPins('rep', PIN_LOCK_AFTER_FAILURES);
    assert.equal(r.status, 423, `run ${run + 1}`);
    const { n, until } = lockOf(fx().users.rep);
    assert.equal(n, PIN_LOCK_AFTER_FAILURES * (run + 1));
    const minutes = (Date.parse(until!) - before) / MINUTE;
    assert.ok(minutes > mins - 0.2 && minutes < mins + 0.2, `run ${run + 1}: ${mins} minutes expected, got ${minutes.toFixed(2)}`);
    assert.equal(r.json.error, lockedSentence(until!));
    if (mins >= 1440) assert.match(r.json.error, / tomorrow, /, 'a lock into the next day says so');
    expireLock(fx().users.rep);
  }
  // A right PIN at the end of it all starts from nothing again.
  resetLoginFailures();
  assert.equal((await srv.anon().post('/auth/login', { ...FIXTURE_ACCOUNTS.rep, pin: GOOD_PIN })).status, 200);
  assert.deepEqual({ ...lockOf(fx().users.rep) }, { n: 0, until: null });
  const again = await wrongPins('rep', PIN_LOCK_AFTER_FAILURES);
  const minutes = (Date.parse(lockOf(fx().users.rep).until!) - Date.now()) / MINUTE;
  assert.equal(again.status, 423);
  assert.ok(minutes > 14.8 && minutes <= 15, 'back to 15 minutes after the count was reset');
});

test('signed in with a locked PIN: change and remove say when it unlocks, and work once it has', async () => {
  srv = await startTestServer();
  const rep = await withPin('rep');
  await wrongPins('rep', PIN_LOCK_AFTER_FAILURES);
  const { until } = lockOf(fx().users.rep);
  for (const [path, body] of [['/auth/pin', { pin: OTHER_PIN, currentPin: GOOD_PIN }], ['/auth/pin/remove', { currentPin: GOOD_PIN }]] as const) {
    const r = await rep.post(path, body);
    assert.equal(r.status, 423, path);
    assert.equal(r.json.error, lockedSentence(until!), path);
  }
  expireLock(fx().users.rep);
  assert.equal((await rep.post('/auth/pin', { pin: OTHER_PIN, currentPin: GOOD_PIN })).status, 204);
  assert.deepEqual({ ...lockOf(fx().users.rep) }, { n: 0, until: null }, 'a new PIN starts with no count and no lock');

  // Wrong current PINs in Settings count towards the same lock (the 429 brake after 6 is forgotten between tries).
  let last: { status: number; json: Json } = { status: 0, json: null };
  for (let i = 0; i < PIN_LOCK_AFTER_FAILURES; i++) {
    resetLoginFailures();
    last = await rep.post('/auth/pin', { pin: '4826', currentPin: WRONG_PIN });
  }
  assert.equal(last.status, 423, 'the tenth wrong current PIN locks it');
  assert.equal(last.json.error, lockedSentence(lockOf(fx().users.rep).until!));
});

test('an admin reset clears the count and the lock; your own reset points at the server command', async () => {
  srv = await startTestServer();
  await withPin('rep');
  const admin = await withPin('admin', OTHER_PIN);
  await wrongPins('rep', PIN_LOCK_AFTER_FAILURES);
  const seen = (await admin.get(`/auth/pin/${fx().users.rep}`)).json;
  assert.equal(seen.locked, true);
  assert.equal(typeof seen.lockedUntil, 'string');
  assert.equal((await admin.post(`/auth/pin/reset/${fx().users.rep}`)).status, 204);
  assert.deepEqual({ ...lockOf(fx().users.rep) }, { n: 0, until: null });

  const own = await admin.post(`/auth/pin/reset/${fx().users.admin}`);
  assert.equal(own.status, 400, 'still not from the app');
  assert.match(own.json.error, /Settings → Security/);
  assert.ok(own.json.error.includes(`npm run pin:reset -- ${FIXTURE_ACCOUNTS.admin.email}`), own.json.error);
});

test('extension upgrade: pin_locked_until is added once; a PIN locked by 1.2.0 (10+ wrong) gets a 15-minute lock from the upgrade', async () => {
  const { extension } = await import('../db/extensions/pin.ts');
  const db = openDb(':memory:');
  createSchema(db);
  buildFixture(db);
  db.exec(`ALTER TABLE users DROP COLUMN pin_locked_until`);
  run(db, `UPDATE users SET pin_hash = 'scrypt$x', pin_failed_attempts = 12 WHERE email = ?`, [FIXTURE_ACCOUNTS.rep.email]);
  run(db, `UPDATE users SET pin_hash = 'scrypt$x', pin_failed_attempts = 3 WHERE email = ?`, [FIXTURE_ACCOUNTS.repB.email]);
  const before = Date.now();
  assert.deepEqual(extension.upgrade(db), ['users.pin_locked_until']);
  const rows = all<{ email: string; until: string | null }>(db, `SELECT email, pin_locked_until AS until FROM users WHERE pin_hash IS NOT NULL ORDER BY email`);
  const rep = rows.find((r) => r.email === FIXTURE_ACCOUNTS.rep.email)!;
  const repB = rows.find((r) => r.email === FIXTURE_ACCOUNTS.repB.email)!;
  const minutes = (Date.parse(rep.until!) - before) / MINUTE;
  assert.ok(minutes > 14.9 && minutes < 15.1, `the old lock now ends 15 minutes after the upgrade (${minutes})`);
  assert.equal(repB.until, null, 'three wrong PINs are not a lock');
  assert.deepEqual(extension.upgrade(db), [], 'idempotent');
  db.close();
});

/* ─────────────────────────── npm run pin:reset ─────────────────────────── */

function pinReset(dbPath: string, ...args: string[]) {
  const r = spawnSync(process.execPath, ['src/pinReset.ts', ...args], {
    cwd: SERVER_DIR,
    env: { ...process.env, DB_PATH: dbPath, NODE_NO_WARNINGS: '1' },
    encoding: 'utf8',
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

test('npm run pin:reset -- <email>: clears the PIN and its lock, signs the person out everywhere and writes an audit row', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'linear-pin-reset-'));
  try {
    const file = path.join(dir, 'linear.sqlite');
    const db = openDb(file);
    createSchema(db);
    buildFixture(db);
    const admin = get<{ id: number }>(db, `SELECT id FROM users WHERE email = ?`, [FIXTURE_ACCOUNTS.admin.email])!.id;
    const future = new Date(Date.now() + 15 * MINUTE).toISOString();
    run(db, `UPDATE users SET pin_hash = 'scrypt-hmac$16384$8$1$c2FsdA==$a2V5', pin_set_at = ?, pin_failed_attempts = 10, pin_locked_until = ? WHERE id = ?`, [new Date().toISOString(), future, admin]);
    for (const token of ['phone', 'laptop']) {
      run(db, `INSERT INTO sessions (token, user_id, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?)`, [
        token, admin, new Date().toISOString(), new Date(Date.now() + 86_400_000).toISOString(), new Date().toISOString(),
      ]);
    }
    const auditBefore = get<{ n: number }>(db, `SELECT COUNT(*) AS n FROM audit_log`)!.n;
    db.close();

    const usage = pinReset(file);
    assert.equal(usage.code, 1);
    assert.match(usage.out, /Usage: npm run pin:reset -- <email>/);

    const missingDb = pinReset(path.join(dir, 'nope.sqlite'), FIXTURE_ACCOUNTS.admin.email);
    assert.equal(missingDb.code, 1);
    assert.match(missingDb.out, /There is no database at .*nope\.sqlite/);

    // a DB_PATH that is not SQLite at all (random bytes, or a folder): a plain sentence, no stack trace
    const junk = path.join(dir, 'notdb.sqlite');
    writeFileSync(junk, randomBytes(64));
    for (const wrong of [junk, dir]) {
      const notDb = pinReset(wrong, FIXTURE_ACCOUNTS.admin.email);
      assert.equal(notDb.code, 1, notDb.out);
      assert.match(notDb.out, /is not a Linear Hub database \(it could not be opened as SQLite\)\. Check DB_PATH\./);
      assert.doesNotMatch(notDb.out, /\bat \S+\.ts:\d+|ERR_SQLITE_ERROR|Node\.js v/, 'no stack trace');
    }
    const plainSqlite = path.join(dir, 'other.sqlite');
    new DatabaseSync(plainSqlite).close();
    const notOurs = pinReset(plainSqlite, FIXTURE_ACCOUNTS.admin.email);
    assert.equal(notOurs.code, 1, notOurs.out);
    assert.match(notOurs.out, /is not a Linear Hub database \(it has no people in it\)/);

    const unknown = pinReset(file, 'nobody@fixture.test');
    assert.equal(unknown.code, 1);
    assert.match(unknown.out, /No one .* nobody@fixture\.test/);

    const nothing = pinReset(file, FIXTURE_ACCOUNTS.repB.email);
    assert.equal(nothing.code, 0, nothing.out);
    assert.match(nothing.out, /has no PIN/);

    const done = pinReset(file, FIXTURE_ACCOUNTS.admin.email.toUpperCase());
    assert.equal(done.code, 0, done.out);
    assert.match(done.out, /Reset the sign-in PIN of .+ \(.+\) and signed them out on 2 devices/);

    const after = openDb(file);
    const row = get<{ hash: string | null; setAt: string | null; n: number; until: string | null }>(
      after, `SELECT pin_hash AS hash, pin_set_at AS setAt, pin_failed_attempts AS n, pin_locked_until AS until FROM users WHERE id = ?`, [admin],
    )!;
    assert.deepEqual({ ...row }, { hash: null, setAt: null, n: 0, until: null });
    assert.equal(get<{ n: number }>(after, `SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?`, [admin])!.n, 0);
    const audit = all<{ userId: number | null; action: string; entity: string; entityId: number; summary: string; after: string }>(
      after, `SELECT user_id AS userId, action, entity, entity_id AS entityId, summary, after_json AS after FROM audit_log ORDER BY id`,
    );
    assert.equal(audit.length, auditBefore + 1, 'one row, and none for the person who had no PIN');
    const last = audit.at(-1)!;
    assert.equal(last.userId, null, 'no signed-in person did it');
    assert.equal(last.action, 'npm run pin:reset');
    assert.equal(last.entity, 'user');
    assert.equal(last.entityId, admin);
    assert.match(last.summary, /^Reset PIN from the server command: /);
    assert.equal(JSON.parse(last.after).pinSet, false);
    after.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
