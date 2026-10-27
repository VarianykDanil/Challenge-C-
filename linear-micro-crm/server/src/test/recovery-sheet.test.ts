/**
 * The recovery sheet (SEC-7, SECURITY-MISSED-3, REL-1): the owner makes a printable sheet with the app key (fresh
 * two-step code, secure request only); the audit trail records it without the key; once the owner confirms the sheet,
 * local backups stop carrying the key (and before that they keep it, so nothing becomes unreadable).
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { createApp } from '../app.ts';
import { all, openDb, run } from '../db/connection.ts';
import { createSchema } from '../db/schema.ts';
import { backupNow } from '../lib/backup.ts';
import { appSecretFile, currentAppSecret } from '../lib/crypto.ts';
import { keyForPaper, lastSix } from '../lib/recoverySheet.ts';
import { OWNER_ONLY_MESSAGE, SECURE_ONLY_MESSAGE } from '../routes/system.ts';
import { buildFixture, currentCode, enrolTwoFactor, signInWith, startTestServer, TestClient, type TestServer } from './helpers.ts';

let srv: TestServer;
let tmp: string;

before(async () => {
  srv = await startTestServer();
  tmp = mkdtempSync(path.join(os.tmpdir(), 'linear-sheet-'));
});
after(async () => {
  await srv.close();
  rmSync(tmp, { recursive: true, force: true });
});

const adminId = () => srv.fixture!.users.admin;
const auditRows = () => all<{ summary: string; after_json: string | null; before_json: string | null; action: string }>(srv.db, `SELECT * FROM audit_log ORDER BY id`);

describe('routes', () => {
  test('GET /system/status: administrators only; it shows the key fingerprint, never the key', async () => {
    const admin = await srv.login('admin');
    const r = await admin.get('/system/status');
    assert.equal(r.status, 200);
    assert.match(r.json.key.fingerprint, /^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/);
    assert.equal(r.json.key.confirmedForThisKey, false);
    assert.equal(r.json.key.inLocalBackups, true, 'until a sheet is confirmed, backups keep the key');
    assert.equal(r.json.canMakeSheet, true, 'the fixture admin is the owner');
    assert.equal(r.json.secure, true, 'the test client is on this computer');
    assert.equal(JSON.stringify(r.json).includes(currentAppSecret()!.secret), false);
    for (const who of ['leader', 'recruiter', 'rep'] as const) {
      const c = await srv.login(who);
      assert.equal((await c.get('/system/status')).status, 403, who);
      assert.equal((await c.post('/system/recovery-sheet', {})).status, 403, who);
    }
    assert.equal((await (await srv.login('client')).get('/system/status')).status, 403);
    assert.equal((await srv.anon().get('/system/status')).status, 401);
  });

  test('POST /system/recovery-sheet: the owner with a fresh code gets the sheet (no-store); the trail says so without the key', async () => {
    const admin = await srv.login('admin');
    const noCode = await admin.post('/system/recovery-sheet', {});
    assert.equal(noCode.status, 400);
    const wrong = await admin.post('/system/recovery-sheet', { code: '000000' });
    assert.equal(wrong.status, 400);
    const r = await admin.post('/system/recovery-sheet', { code: currentCode(srv.db, adminId()) });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.headers.get('cache-control'), 'no-store');
    const secret = currentAppSecret()!.secret;
    assert.equal(r.json.sheet.key, keyForPaper(secret));
    assert.equal(r.json.sheet.keyFile, appSecretFile());
    assert.ok(r.json.sheet.steps.some((s: string) => /npm run key:restore/.test(s)));
    const rows = auditRows();
    assert.ok(rows.some((row) => /^Made the recovery sheet for the app key \(key [0-9A-F-]+\)/.test(row.summary)));
    assert.ok(rows.some((row) => /^Tried to make the recovery sheet/.test(row.summary)), 'refused attempts are recorded');
    const bare = secret.toLowerCase();
    for (const row of rows) assert.equal(JSON.stringify(row).toLowerCase().includes(bare), false, 'the key is never in the audit trail');
    const status = await admin.get('/system/status');
    assert.ok(status.json.key.sheetMadeAt);
  });

  test('another administrator who is not the owner is refused', async () => {
    const id = run(
      srv.db,
      `INSERT INTO users (employee_id, email, first_name, last_name, role, position, team_id, pay_plan_id, start_date, status, avatar_color)
       VALUES ('LM-0901', 'office.admin@fixture.test', 'Olly', 'Office', 'admin', 'assistant_owner', NULL, ?, '2026-01-01', 'active', '#000000')`,
      [srv.fixture!.plans.owner],
    ).lastInsertRowid;
    enrolTwoFactor(srv.db, id);
    const office = await srv.login({ email: 'office.admin@fixture.test', employeeId: 'LM-0901' });
    const status = await office.get('/system/status');
    assert.equal(status.status, 200);
    assert.equal(status.json.canMakeSheet, false);
    const r = await office.post('/system/recovery-sheet', { code: currentCode(srv.db, id) });
    assert.equal(r.status, 403);
    assert.equal(r.json.error, OWNER_ONLY_MESSAGE);
  });

  test('confirming takes the last six characters of the key from the paper', async () => {
    const admin = await srv.login('admin');
    const wrong = await admin.post('/system/recovery-sheet/confirm', { lastSix: 'zzzzzz' });
    assert.equal(wrong.status, 400);
    const r = await admin.post('/system/recovery-sheet/confirm', { lastSix: lastSix(currentAppSecret()!.secret).toUpperCase() });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const status = await admin.get('/system/status');
    assert.equal(status.json.key.confirmedForThisKey, true);
    assert.equal(status.json.key.inLocalBackups, false);
    assert.ok(auditRows().some((row) => /^Confirmed the recovery sheet/.test(row.summary)));
  });

  test('from another device on plain HTTP (not a secure request) the sheet is refused', async (t) => {
    const lan = Object.values(os.networkInterfaces())
      .flat()
      .find((i) => i && i.family === 'IPv4' && !i.internal)?.address;
    if (!lan) {
      t.skip('no network address on this machine');
      return;
    }
    const server = http.createServer(createApp(srv.db));
    await new Promise<void>((resolve) => server.listen(0, '0.0.0.0', () => resolve()));
    try {
      const client = new TestClient(`http://${lan}:${(server.address() as AddressInfo).port}/api`);
      const signedIn = await signInWith(srv.db, client, srv.fixture!.accounts.admin);
      assert.equal(signedIn.status, 200);
      const status = await client.get('/system/status');
      assert.equal(status.json.secure, false);
      const r = await client.post('/system/recovery-sheet', { code: currentCode(srv.db, adminId()) });
      assert.equal(r.status, 403);
      assert.equal(r.json.error, SECURE_ONLY_MESSAGE);
      const confirm = await client.post('/system/recovery-sheet/confirm', { lastSix: lastSix(currentAppSecret()!.secret) });
      assert.equal(confirm.status, 403);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('the key in the local backups', () => {
  test('kept until the sheet is confirmed, then left out (and the copy removed); a copy of another key stays', async () => {
    const dir = path.join(tmp, 'separation');
    mkdirSync(dir, { recursive: true });
    const dbPath = path.join(dir, 'linear.sqlite');
    const db = openDb(dbPath);
    createSchema(db);
    buildFixture(db);
    const backups = path.join(dir, 'backups');
    const keyFile = appSecretFile();
    const before = await backupNow(db, { dir: backups, secretFile: keyFile, now: new Date('2026-10-26T02:00:00Z') });
    assert.equal(before.secret, 'copied');
    writeFileSync(path.join(backups, 'app-secret-0123456789ab'), 'an older key\n');
    // the owner confirms the sheet (as the route does)
    const { recordSheetConfirmed } = await import('../lib/recoverySheet.ts');
    const { secretFingerprint } = await import('../lib/crypto.ts');
    recordSheetConfirmed(db, secretFingerprint(currentAppSecret()!.secret));
    const afterConfirm = await backupNow(db, { dir: backups, secretFile: keyFile, now: new Date('2026-10-27T02:00:00Z') });
    assert.equal(afterConfirm.secret, 'removed');
    assert.equal(existsSync(path.join(backups, 'app-secret')), false);
    assert.equal(readFileSync(path.join(backups, 'app-secret-0123456789ab'), 'utf8'), 'an older key\n', 'another key is never removed');
    const next = await backupNow(db, { dir: backups, secretFile: keyFile, now: new Date('2026-10-28T02:00:00Z') });
    assert.equal(next.secret, 'left-out');
    db.close();
  });
});

describe('npm run recovery-sheet', () => {
  test('prints the key and its fingerprint, records it in the trail, and --confirm with the last six characters', () => {
    const dir = path.join(tmp, 'cli');
    mkdirSync(dir, { recursive: true });
    const dbPath = path.join(dir, 'linear.sqlite');
    const keyFile = path.join(dir, 'app-secret');
    const key = '9'.repeat(60) + 'abcd';
    writeFileSync(keyFile, `${key}\n`, { mode: 0o600 });
    const db = openDb(dbPath);
    createSchema(db);
    buildFixture(db);
    db.close();
    const env = { ...process.env, NODE_NO_WARNINGS: '1', DB_PATH: dbPath, LM_APP_SECRET_FILE: keyFile, LM_APP_SECRET: '', LM_OFFSITE_DIR: '' };
    const serverDir = path.resolve(import.meta.dirname, '../..');
    const r = spawnSync(process.execPath, [path.join(serverDir, 'src', 'recoverySheet.ts')], { cwd: serverDir, encoding: 'utf8', env });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes(keyForPaper(key)));
    assert.match(r.stdout, /Key fingerprint: [0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}/);
    assert.match(r.stdout, /npm run key:restore/);
    const wrong = spawnSync(process.execPath, [path.join(serverDir, 'src', 'recoverySheet.ts'), '--confirm=000000'], { cwd: serverDir, encoding: 'utf8', env });
    assert.equal(wrong.status, 1);
    const ok = spawnSync(process.execPath, [path.join(serverDir, 'src', 'recoverySheet.ts'), '--confirm=99abcd'], { cwd: serverDir, encoding: 'utf8', env });
    assert.equal(ok.status, 0, ok.stderr);
    const check = openDb(dbPath);
    try {
      const rows = all<{ summary: string; after_json: string | null }>(check, `SELECT summary, after_json FROM audit_log WHERE action = 'npm run recovery-sheet' ORDER BY id`);
      assert.ok(rows.some((row) => /^Made the recovery sheet from the server command/.test(row.summary)));
      assert.ok(rows.some((row) => /^Confirmed the recovery sheet/.test(row.summary)));
      for (const row of rows) assert.equal(JSON.stringify(row).includes(key), false);
    } finally {
      check.close();
    }
  });
});
