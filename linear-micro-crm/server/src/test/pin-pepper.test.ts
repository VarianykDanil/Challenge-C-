/**
 * Release 1.2 review fix S8: PIN hashes are peppered with the app secret (HMAC-SHA256 under a key derived from
 * LM_APP_SECRET or the app-secret file) before scrypt, so a leaked database or backup alone cannot be brute-forced.
 * New hashes are tagged `scrypt-hmac$…`; old `scrypt$…` hashes still verify and are re-hashed at the next sign-in.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, scryptSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { get, run } from '../db/connection.ts';
import { configureAppSecret } from '../lib/crypto.ts';
import { hashPin, verifyPin } from '../lib/pin.ts';
import { FIXTURE_ACCOUNTS, startTestServer } from './helpers.ts';

const GOOD_PIN = '5821';

/** A hash exactly as release 1.2.0 wrote it: scrypt of the bare PIN. */
function legacyHash(pin: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(pin, salt, 32, { N: 16_384, r: 8, p: 1 });
  return ['scrypt', 16_384, 8, 1, salt.toString('base64'), key.toString('base64')].join('$');
}

test('a PIN hash is tagged scrypt-hmac and is useless without the app secret it was made with', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'linear-pepper-'));
  const prevEnv = process.env.LM_APP_SECRET;
  delete process.env.LM_APP_SECRET;
  try {
    configureAppSecret(path.join(dir, 'secret-a'));
    const hash = await hashPin(GOOD_PIN);
    assert.match(hash, /^scrypt-hmac\$16384\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    assert.equal(await verifyPin(hash, GOOD_PIN), true);
    assert.equal(await verifyPin(hash, '7390'), false);

    // The same hash checked under another secret (a leaked DB on an attacker's machine, or a lost secret file).
    configureAppSecret(path.join(dir, 'secret-b'));
    assert.equal(await verifyPin(hash, GOOD_PIN), false, 'the right PIN does not match without the secret');
    // Unpeppered scrypt of the PIN (what 1.2.0 stored) does not reproduce it either.
    const [, N, r, p, salt, key] = hash.split('$');
    const bare = scryptSync(GOOD_PIN, Buffer.from(salt!, 'base64'), 32, { N: Number(N), r: Number(r), p: Number(p) }).toString('base64');
    assert.notEqual(bare, key);

    configureAppSecret(path.join(dir, 'secret-a'));
    assert.equal(await verifyPin(hash, GOOD_PIN), true, 'back on the right secret');

    process.env.LM_APP_SECRET = 'an-operator-managed-secret-for-the-test';
    assert.equal(await verifyPin(hash, GOOD_PIN), false, 'LM_APP_SECRET is the secret when set');
    assert.equal(await verifyPin(await hashPin(GOOD_PIN), GOOD_PIN), true);
  } finally {
    if (prevEnv === undefined) delete process.env.LM_APP_SECRET;
    else process.env.LM_APP_SECRET = prevEnv;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an old scrypt$ hash still verifies, and the next sign-in replaces it with a peppered one (set date kept)', async () => {
  const srv = await startTestServer();
  try {
    const repId = srv.fixture!.users.rep;
    const old = legacyHash(GOOD_PIN);
    assert.equal(await verifyPin(old, GOOD_PIN), true, 'the old format is still read');
    assert.equal(await verifyPin(old, '7390'), false);
    const setAt = '2026-10-01T09:00:00.000Z';
    run(srv.db, `UPDATE users SET pin_hash = ?, pin_set_at = ? WHERE id = ?`, [old, setAt, repId]);
    const hashOf = () => get<{ h: string; s: string }>(srv.db, `SELECT pin_hash AS h, pin_set_at AS s FROM users WHERE id = ?`, [repId])!;
    const creds = FIXTURE_ACCOUNTS.rep;

    assert.equal((await srv.anon().post('/auth/login', { ...creds, pin: '7390' })).status, 401);
    assert.equal(hashOf().h, old, 'a wrong PIN changes nothing');
    const ok = await srv.anon().post('/auth/login', { ...creds, pin: GOOD_PIN });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    const now = hashOf();
    assert.match(now.h, /^scrypt-hmac\$/, 're-hashed with the pepper');
    assert.equal(now.s, setAt, 'still the date the person chose the PIN');
    assert.equal(await verifyPin(now.h, GOOD_PIN), true);
    assert.equal((await srv.anon().post('/auth/login', { ...creds, pin: GOOD_PIN })).status, 200, 'and signs in next time');
    assert.equal(hashOf().h, now.h, 'a current hash is left alone');
  } finally {
    await srv.close();
  }
});
