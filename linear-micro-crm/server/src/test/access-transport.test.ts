/**
 * Sessions at rest and requests on the wire (findings SEC-6, CODE-MISSED-1, SEC-3, CLAIMS-MISSED-4):
 *  - the sessions table keeps only a SHA-256 hash of each session token, and a 1.4.0 database is upgraded in place
 *    without signing anybody out;
 *  - built-in HTTPS (LM_TLS_CERT_FILE / LM_TLS_KEY_FILE) gives Secure cookies and HSTS;
 *  - money and secret actions are refused over plain http from another device (the computer itself stays allowed).
 */
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { Request } from 'express';
import { ACCESS_MESSAGES } from '@lm/shared';
import { createApp } from '../app.ts';
import { get, openDb, run } from '../db/connection.ts';
import { createSchema } from '../db/schema.ts';
import { isSecureRequest, isLoopbackAddress } from '../lib/secureRequest.ts';
import { readTlsFiles, tlsFilesFromEnv } from '../lib/tls.ts';
import { sessionKey } from '../middleware/auth.ts';
import { totp } from '../lib/totp.ts';
import { FIXTURE_ACCOUNTS, buildFixture, currentCode, signInWith, startTestServer, TestClient, type Json, type TestServer } from './helpers.ts';

let srv: TestServer | null = null;
const extra: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const e of extra.splice(0)) await e.close();
  await srv?.close();
  srv = null;
});

const db = () => srv!.db;
const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const tokenOf = (c: TestClient) => c.cookie.replace(/^lm_session=/, '');

// ───────────────────────────── sessions stored hashed ─────────────────────────────

test('the sessions table keeps a SHA-256 hash of each token, never the token itself (SEC-6)', async () => {
  srv = await startTestServer();
  const rep = await srv.login('rep');
  const token = tokenOf(rep);
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.equal(get(db(), `SELECT 1 FROM sessions WHERE token = ?`, [token]), undefined, 'the cookie value is not stored');
  assert.ok(get(db(), `SELECT 1 FROM sessions WHERE token = ?`, [sha256(token)]), 'its hash is');
  assert.equal(sessionKey(token), sha256(token));
  assert.equal((await rep.get('/auth/me')).status, 200, 'looked up by hash');
  // a stolen database row is no cookie: sending the stored value back signs nobody in
  const forged = new TestClient(srv.base);
  forged.cookie = `lm_session=${sha256(token)}`;
  assert.equal((await forged.get('/auth/me')).status, 401);
  // sign-out removes the row; a PIN change keeps this device and ends the others
  const other = await srv.login('rep');
  assert.equal((await rep.post('/auth/pin', { pin: '4917' })).status, 204);
  assert.equal((await rep.get('/auth/me')).status, 200, 'the device that changed the PIN stays signed in');
  assert.equal((await other.get('/auth/me')).status, 401, 'the other device is signed out');
  await rep.post('/auth/logout');
  assert.equal(get(db(), `SELECT 1 FROM sessions WHERE token = ?`, [sha256(token)]), undefined);
});

test('upgrade: sessions a 1.4.0 database stored in plain are hashed in place, and nobody is signed out', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'linear-sessions-'));
  try {
    const file = path.join(dir, 'linear.sqlite');
    const d = openDb(file);
    createSchema(d);
    const fx = buildFixture(d);
    // a 1.4.0-shaped database: raw tokens, and none of this release's markers
    run(d, `DELETE FROM meta WHERE key LIKE 'ext:access:%'`);
    const raw = 'a'.repeat(64);
    const now = new Date().toISOString();
    run(d, `INSERT INTO sessions (token, user_id, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?)`, [raw, fx.users.rep, now, new Date(Date.now() + 3_600_000).toISOString(), now]);
    const changed = createSchema(d);
    assert.ok(changed.includes('access:sessions.hashed'), changed.join(', '));
    assert.equal(get(d, `SELECT 1 FROM sessions WHERE token = ?`, [raw]), undefined);
    assert.ok(get(d, `SELECT 1 FROM sessions WHERE token = ?`, [sha256(raw)]));
    // idempotent: a second start changes nothing (a hash is never hashed again)
    assert.deepEqual(createSchema(d).filter((c) => c.startsWith('access:sessions')), []);
    assert.ok(get(d, `SELECT 1 FROM sessions WHERE token = ?`, [sha256(raw)]));
    d.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('upgrade, end to end: the old cookie still works after the upgrade', async () => {
  srv = await startTestServer();
  const rep = await srv.login('rep');
  const token = tokenOf(rep);
  // turn the row back into a 1.4.0 row (the raw token) and run the upgrade as a start would
  run(db(), `UPDATE sessions SET token = ? WHERE token = ?`, [token, sha256(token)]);
  run(db(), `DELETE FROM meta WHERE key = 'ext:access:sessions-hashed'`);
  createSchema(db());
  srv.resetCache();
  assert.equal((await rep.get('/auth/me')).status, 200, 'still signed in');
});

// ───────────────────────────── secure requests ─────────────────────────────

const fakeReq = (o: { secure?: boolean; ip?: string; peer?: string; trust?: boolean }) =>
  ({ secure: o.secure ?? false, ip: o.ip, socket: { remoteAddress: o.peer }, app: { get: () => (o.trust ? 'loopback' : false) } }) as unknown as Request;

test('isSecureRequest: TLS (or https behind the trusted proxy), or this very computer', () => {
  for (const a of ['127.0.0.1', '127.8.9.10', '::1', '::ffff:127.0.0.1']) assert.equal(isLoopbackAddress(a), true, a);
  for (const a of ['192.168.1.20', '10.0.0.5', '::ffff:192.168.1.20', 'fe80::1', '', undefined]) assert.equal(isLoopbackAddress(a), false, String(a));
  assert.equal(isSecureRequest(fakeReq({ secure: true, peer: '192.168.1.20' })), true, 'https from a phone');
  assert.equal(isSecureRequest(fakeReq({ peer: '127.0.0.1' })), true, 'plain http on the Mac itself');
  assert.equal(isSecureRequest(fakeReq({ peer: '192.168.1.20' })), false, 'plain http from a phone');
  // behind the trusted proxy the socket is the proxy: the client address decides, and X-Forwarded-Proto via req.secure
  assert.equal(isSecureRequest(fakeReq({ trust: true, peer: '127.0.0.1', ip: '203.0.113.9' })), false, 'proxied plain http');
  assert.equal(isSecureRequest(fakeReq({ trust: true, secure: true, peer: '127.0.0.1', ip: '203.0.113.9' })), true, 'proxied https');
});

/** A second app on the test database that trusts a proxy on this machine, so a test can say "from 192.168.1.20". */
async function proxiedApp(): Promise<string> {
  const server = http.createServer(createApp(db(), { trustProxy: 'loopback' }));
  server.keepAliveTimeout = 0;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  extra.push({ close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }) });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
}

async function from(base: string, cookie: string, method: string, url: string, proto: 'http' | 'https', body?: unknown): Promise<{ status: number; json: Json }> {
  const res = await fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', cookie, 'x-forwarded-for': '192.168.1.20', 'x-forwarded-proto': proto },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

test('over plain http from another device: bank details, payments, connection keys and codes are refused (SEC-3)', async () => {
  srv = await startTestServer();
  const base = await proxiedApp();
  const admin = new TestClient(base);
  // signing in itself works over plain http from a phone (the trial on the office Wi-Fi)
  assert.equal((await signInWith(db(), admin, FIXTURE_ACCOUNTS.admin)).status, 200);
  const adminId = srv.fixture!.users.admin;
  const refused: [string, string, unknown?][] = [
    ['PUT', '/me/bank-details', { holderName: 'Ada Admin', sortCode: '000000', accountNumber: '00000001' }],
    ['PUT', `/users/${srv.fixture!.users.rep}/bank-details`, { holderName: 'Remy Rep', sortCode: '000000', accountNumber: '00000002' }],
    ['POST', `/users/${srv.fixture!.users.rep}/bank-details/confirm`, {}],
    ['POST', '/payments/batches/1/approve', { code: '123456' }],
    ['GET', '/payments/batches/1/file'],
    ['POST', '/payments/connections', { provider: 'bank_file', name: 'x' }],
    ['PATCH', '/payments/connections/1', { mode: 'live' }],
    ['POST', `/users/${srv.fixture!.users.rep}/setup-code`, { code: '123456' }],
    ['POST', `/users/${srv.fixture!.users.rep}/2fa/reset`, { code: '123456' }],
    ['POST', `/auth/pin/reset/${srv.fixture!.users.rep}`, { code: '123456' }],
    ['POST', '/auth/2fa/recovery-codes', { code: '123456' }],
  ];
  for (const [m, p, b] of refused) {
    const r = await from(base, admin.cookie, m, p, 'http', b);
    assert.equal(r.status, 403, `${m} ${p}: ${JSON.stringify(r.json)}`);
    assert.equal(r.json.error, ACCESS_MESSAGES.insecure, `${m} ${p}`);
    assert.deepEqual(r.json.details, { code: 'insecure_connection' });
  }
  assert.equal(get(db(), `SELECT 1 FROM bank_accounts WHERE user_id = ?`, [adminId]), undefined, 'nothing stored');
  // the same over https (the proxy says so) passes the guard
  const ok = await from(base, admin.cookie, 'POST', `/users/${srv.fixture!.users.rep}/setup-code`, 'https', { code: currentCode(db(), adminId) });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  // reading is fine over plain http
  assert.equal((await from(base, admin.cookie, 'GET', '/me/bank-details', 'http')).status, 200);
});

test('over plain http from another device: adding a person works but the setup code is not shown; recovery codes neither', async () => {
  srv = await startTestServer();
  const base = await proxiedApp();
  const admin = new TestClient(base);
  await signInWith(db(), admin, FIXTURE_ACCOUNTS.admin);
  const plan = get<{ id: number }>(db(), `SELECT id FROM pay_plans WHERE position = 'field_rep' ORDER BY id LIMIT 1`)!.id;
  const made = await from(base, admin.cookie, 'POST', '/users', 'http', {
    email: 'lan.person@example.test', firstName: 'Lan', lastName: 'Person', role: 'rep', position: 'field_rep', teamId: null, payPlanId: plan,
    startDate: srv.fixture!.today, status: 'active', phone: null, city: null,
  });
  assert.equal(made.status, 201, JSON.stringify(made.json));
  assert.equal(made.json.setupCode, null);
  assert.equal(made.json.setupCodeWithheld, true);
  assert.doesNotMatch(made.json.signInInstructions, /[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}/);
  // turning two-step on from a phone over plain http still works; the recovery codes wait for a secure connection
  const local = await srv.login('admin');
  const issued = await local.post(`/users/${srv.fixture!.users.repA2}/setup-code`, { code: currentCode(db(), srv.fixture!.users.admin) });
  assert.equal(issued.status, 200);
  const signIn = await fetch(`${base}/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '192.168.1.20', 'x-forwarded-proto': 'http' },
    body: JSON.stringify({ ...FIXTURE_ACCOUNTS.repA2, setupCode: issued.json.setupCode }),
  });
  assert.equal(signIn.status, 200);
  const cookie = /lm_session=[^;]*/.exec(signIn.headers.getSetCookie().join(';'))![0];
  const setup = await from(base, cookie, 'POST', '/auth/2fa/setup', 'http');
  assert.equal(setup.status, 201);
  const on = await from(base, cookie, 'POST', '/auth/2fa/enable', 'http', { code: totp(setup.json.secret) });
  assert.equal(on.status, 200, JSON.stringify(on.json));
  assert.deepEqual(on.json.recoveryCodes, []);
  assert.equal(on.json.recoveryCodesWithheld, true);
  assert.equal(on.json.message, ACCESS_MESSAGES.recoveryCodesWithheld);
  assert.equal(get<{ n: number }>(db(), `SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = ?`, [srv.fixture!.users.repA2])!.n, 0, 'none made, so none to steal');
});

// ───────────────────────────── built-in HTTPS ─────────────────────────────

function makeCert(dir: string): { cert: string; key: string } | null {
  const cert = path.join(dir, 'cert.pem');
  const key = path.join(dir, 'key.pem');
  const r = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '2', '-subj', '/CN=localhost'], { encoding: 'utf8' });
  return r.status === 0 ? { cert, key } : null;
}

test('LM_TLS_CERT_FILE and LM_TLS_KEY_FILE: both or neither, with a plain message for a missing file', () => {
  assert.equal(tlsFilesFromEnv({}), null);
  assert.throws(() => tlsFilesFromEnv({ LM_TLS_CERT_FILE: '/x/cert.pem' }), /Set both LM_TLS_CERT_FILE and LM_TLS_KEY_FILE/);
  assert.throws(() => tlsFilesFromEnv({ LM_TLS_KEY_FILE: '/x/key.pem' }), /Set both LM_TLS_CERT_FILE and LM_TLS_KEY_FILE/);
  assert.deepEqual(tlsFilesFromEnv({ LM_TLS_CERT_FILE: ' /x/cert.pem ', LM_TLS_KEY_FILE: '/x/key.pem' }), { certFile: '/x/cert.pem', keyFile: '/x/key.pem' });
  assert.throws(() => readTlsFiles({ certFile: '/nonexistent/cert.pem', keyFile: '/nonexistent/key.pem' }), /Could not read the HTTPS certificate/);
});

test('built-in HTTPS: cookies are Secure without COOKIE_SECURE, and every answer carries HSTS', async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'linear-tls-'));
  try {
    const files = makeCert(dir);
    if (!files) {
      t.skip('openssl is not installed');
      return;
    }
    srv = await startTestServer();
    const tls = readTlsFiles({ certFile: files.cert, keyFile: files.key });
    const server = https.createServer({ ...tls }, createApp(db()));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    extra.push({ close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }) });
    const port = (server.address() as AddressInfo).port;
    const ask = (method: string, p: string, body?: unknown) =>
      new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
        const req = https.request({ host: '127.0.0.1', port, path: `/api${p}`, method, rejectUnauthorized: false, headers: { 'content-type': 'application/json' } }, (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data }));
        });
        req.on('error', reject);
        if (body !== undefined) req.write(JSON.stringify(body));
        req.end();
      });
    const health = await ask('GET', '/health');
    assert.equal(health.status, 200);
    assert.match(String(health.headers['strict-transport-security']), /max-age=\d+/);
    // a session cookie over https is Secure: sign in someone without a PIN or two-step step (a setup code)
    const admin = await srv.login('admin');
    const code = await admin.post(`/users/${srv.fixture!.users.repB}/setup-code`, { code: currentCode(db(), srv.fixture!.users.admin) });
    const signedIn = await ask('POST', '/auth/login', { ...FIXTURE_ACCOUNTS.repB, setupCode: code.json.setupCode });
    assert.equal(signedIn.status, 200, signedIn.body);
    const setCookie = String(signedIn.headers['set-cookie'] ?? '');
    assert.match(setCookie, /lm_session=/);
    assert.match(setCookie, /;\s*Secure/i);
    assert.match(setCookie, /HttpOnly/i);
    // the same app over plain http sets no Secure flag and no HSTS (COOKIE_SECURE=1 would still force Secure)
    const plain = await srv.anon().get('/health');
    assert.equal(plain.headers.get('strict-transport-security'), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
