/**
 * Release 1.2 review fix S7: behind the reverse proxy of docs/DEPLOY.md (TRUST_PROXY=1) the login limiter used to key
 * on the proxy's address, so eight wrong sign-ins from anywhere locked everyone with that email out. It now keys on
 * `req.ip` when `trust proxy` is configured (Express resolves the client through the trusted hops only) and on the
 * socket address otherwise, where a forged X-Forwarded-For changes nothing. The per-email backstop (20 from anywhere)
 * still holds either way. (The reviewer's probe6, as a regression test.)
 */
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../app.ts';
import { openDb, type Db } from '../db/connection.ts';
import { createSchema } from '../db/schema.ts';
import { configureAppSecret } from '../lib/crypto.ts';
import { LOGIN_MAX_FAILURES, LOGIN_MAX_FAILURES_PER_EMAIL, resetLoginFailures } from '../routes/auth.ts';
import { FIXTURE_ACCOUNTS, buildFixture } from './helpers.ts';

const dir = mkdtempSync(path.join(os.tmpdir(), 'linear-proxy-'));
configureAppSecret(path.join(dir, 'app-secret')); // never touch server/data/app-secret

let close: (() => Promise<void>) | null = null;
afterEach(async () => {
  await close?.();
  close = null;
});

async function serve(trustProxy: boolean | number | string): Promise<(xff: string, employeeId: string) => Promise<number>> {
  const db: Db = openDb(':memory:');
  createSchema(db);
  buildFixture(db);
  resetLoginFailures();
  const server = http.createServer(createApp(db, { trustProxy }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  close = async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    db.close();
  };
  return (xff, employeeId) =>
    fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': xff },
      body: JSON.stringify({ email: FIXTURE_ACCOUNTS.rep.email, employeeId }),
    }).then(async (r) => {
      await r.arrayBuffer();
      return r.status;
    });
}

test('behind a trusted proxy: eight wrong sign-ins from one client do not lock out the same person on another network', async () => {
  const login = await serve(1);
  const attacker: number[] = [];
  for (let i = 0; i < LOGIN_MAX_FAILURES; i++) attacker.push(await login('203.0.113.66', 'WRONG'));
  assert.deepEqual(attacker, Array(LOGIN_MAX_FAILURES).fill(401));
  assert.equal(await login('203.0.113.66', 'WRONG'), 429, 'the client that guessed is paused');
  assert.equal(await login('198.51.100.7', FIXTURE_ACCOUNTS.rep.employeeId), 200, 'the real person on another network signs in');
});

test('behind a trusted proxy: rotating client addresses still meets the per-email backstop', async () => {
  const login = await serve(1);
  for (let i = 0; i < LOGIN_MAX_FAILURES_PER_EMAIL; i++) assert.equal(await login(`203.0.113.${i + 1}`, 'WRONG'), 401, `attempt ${i + 1}`);
  assert.equal(await login('198.51.100.7', FIXTURE_ACCOUNTS.rep.employeeId), 429, '20 from anywhere pause the email');
});

test('without TRUST_PROXY a forged X-Forwarded-For changes nothing: the limiter keys on the socket address', async () => {
  const login = await serve(false);
  for (let i = 0; i < LOGIN_MAX_FAILURES; i++) assert.equal(await login(`203.0.113.${i + 1}`, 'WRONG'), 401);
  assert.equal(await login('198.51.100.7', FIXTURE_ACCOUNTS.rep.employeeId), 429, 'a made-up header is not a new source');
});

test.after(() => rmSync(dir, { recursive: true, force: true }));
