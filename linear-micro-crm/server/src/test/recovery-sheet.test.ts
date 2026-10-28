/**
 * The recovery sheet (SEC-7, SECURITY-MISSED-3, REL-1): the app key on paper, made and confirmed only on the server
 * computer (npm run recovery-sheet), so the key is never sent over the network or returned by the API. The audit
 * trail records it without the key. Confirming needs the whole key typed back from the paper: only then do local
 * backups stop carrying their copy of the key (before that they keep it, so nothing can become unreadable).
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { all, openDb } from '../db/connection.ts';
import { createSchema } from '../db/schema.ts';
import { backupNow } from '../lib/backup.ts';
import { appSecretFile, currentAppSecret } from '../lib/crypto.ts';
import { confirmsKey, keyForPaper, keyLeftOutOfBackups } from '../lib/recoverySheet.ts';
import { buildFixture, currentCode, startTestServer, type TestServer } from './helpers.ts';

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

describe('routes', () => {
  test('GET /system/status: administrators only; it shows the key fingerprint, never the key', async () => {
    const admin = await srv.login('admin');
    const r = await admin.get('/system/status');
    assert.equal(r.status, 200);
    assert.match(r.json.key.fingerprint, /^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/);
    assert.equal(r.json.key.confirmedForThisKey, false);
    assert.equal(r.json.key.inLocalBackups, true, 'until a sheet is confirmed, backups keep the key');
    assert.equal(JSON.stringify(r.json).includes(currentAppSecret()!.secret), false);
    for (const who of ['leader', 'recruiter', 'rep'] as const) {
      const c = await srv.login(who);
      assert.equal((await c.get('/system/status')).status, 403, who);
    }
    assert.equal((await (await srv.login('client')).get('/system/status')).status, 403);
    assert.equal((await srv.anon().get('/system/status')).status, 401);
  });

  test('no route hands out the key or takes it: the sheet is made and confirmed on the server computer only', async () => {
    const admin = await srv.login('admin');
    const secret = currentAppSecret()!.secret;
    const make = await admin.post('/system/recovery-sheet', { code: currentCode(srv.db, adminId()) });
    assert.equal(make.status, 404);
    assert.equal(JSON.stringify(make.json ?? {}).includes(secret), false);
    const confirm = await admin.post('/system/recovery-sheet/confirm', { key: secret, lastSix: secret.slice(-6) });
    assert.equal(confirm.status, 404);
    assert.equal((await admin.get('/system/status')).json.key.confirmedForThisKey, false, 'nothing was confirmed');
  });
});

describe('confirming the sheet', () => {
  test('needs the whole key from the paper: one wrong character in the middle is refused', () => {
    const key = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
    assert.equal(confirmsKey(key, keyForPaper(key)), true, 'typed in the groups of four from the sheet');
    assert.equal(confirmsKey(key, keyForPaper(key).toUpperCase().replace(/ /g, '-')), true, 'case, spaces and dashes do not matter');
    const oneOff = `${key.slice(0, 30)}${key[30] === '0' ? '1' : '0'}${key.slice(31)}`;
    assert.equal(confirmsKey(key, oneOff), false);
    assert.equal(confirmsKey(key, key.slice(-6)), false, 'the last six characters are not enough');
    assert.equal(confirmsKey(key, ''), false);
    assert.equal(confirmsKey(key, undefined), false);
    assert.equal(confirmsKey('a custom LM_APP_SECRET value', ' a custom LM_APP_SECRET value '), true);
    assert.equal(confirmsKey('a custom LM_APP_SECRET value', 'a custom LM_APP_SECRET valuf'), false);
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
  const serverDir = path.resolve(import.meta.dirname, '../..');
  const key = '9'.repeat(30) + '0123456789abcdef' + '8'.repeat(14) + 'abcd';
  function scratch(name: string) {
    const dir = path.join(tmp, name);
    mkdirSync(dir, { recursive: true });
    const dbPath = path.join(dir, 'linear.sqlite');
    const keyFile = path.join(dir, 'app-secret');
    writeFileSync(keyFile, `${key}\n`, { mode: 0o600 });
    const db = openDb(dbPath);
    createSchema(db);
    buildFixture(db);
    db.close();
    const env: NodeJS.ProcessEnv = { ...process.env, NODE_NO_WARNINGS: '1', DB_PATH: dbPath, LM_APP_SECRET_FILE: keyFile, LM_APP_SECRET: '', LM_OFFSITE_DIR: '' };
    const sheet = (args: string[], input?: string, extraEnv: NodeJS.ProcessEnv = {}) =>
      spawnSync(process.execPath, [path.join(serverDir, 'src', 'recoverySheet.ts'), ...args], { cwd: serverDir, encoding: 'utf8', env: { ...env, ...extraEnv }, input });
    const confirmed = () => {
      const check = openDb(dbPath);
      try {
        return keyLeftOutOfBackups(check, keyFile);
      } finally {
        check.close();
      }
    };
    const audit = () => {
      const check = openDb(dbPath);
      try {
        return all<{ summary: string; after_json: string | null }>(check, `SELECT summary, after_json FROM audit_log WHERE action = 'npm run recovery-sheet' ORDER BY id`);
      } finally {
        check.close();
      }
    };
    return { dir, dbPath, keyFile, sheet, confirmed, audit };
  }

  test('prints the key and its fingerprint and records it in the trail without the key', () => {
    const s = scratch('cli-print');
    const r = s.sheet([]);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes(keyForPaper(key)));
    assert.match(r.stdout, /Key fingerprint: [0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}/);
    assert.match(r.stdout, /npm run key:restore/);
    const rows = s.audit();
    assert.ok(rows.some((row) => /^Made the recovery sheet from the server command/.test(row.summary)));
    for (const row of rows) assert.equal(JSON.stringify(row).includes(key), false);
  });

  test('--confirm takes the whole key typed from the paper; one wrong character changes nothing and keeps the backup copy', async () => {
    const s = scratch('cli-confirm');
    const oneOff = keyForPaper(`${key.slice(0, 33)}f${key.slice(34)}`);
    assert.notEqual(oneOff, keyForPaper(key));
    const wrong = s.sheet(['--confirm'], `${oneOff}\n`);
    assert.equal(wrong.status, 1, wrong.stdout);
    assert.match(wrong.stderr, /not the key.*Nothing was confirmed/s);
    assert.equal(s.confirmed(), false);
    const db = openDb(s.dbPath);
    const backups = path.join(s.dir, 'backups');
    assert.equal((await backupNow(db, { dir: backups, secretFile: s.keyFile, now: new Date('2026-10-27T02:00:00Z') })).secret, 'copied', 'the copy stays');
    db.close();

    const six = s.sheet(['--confirm'], `${key.slice(-6)}\n`);
    assert.equal(six.status, 1, 'the last six characters are not enough');

    const ok = s.sheet(['--confirm'], `${keyForPaper(key).toUpperCase()}\n`);
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(ok.stdout.includes(keyForPaper(key)) || ok.stdout.includes(key), false, '--confirm never shows the key, so it is typed from the paper');
    assert.equal(s.confirmed(), true);
    const db2 = openDb(s.dbPath);
    assert.equal((await backupNow(db2, { dir: backups, secretFile: s.keyFile, now: new Date('2026-10-28T02:00:00Z') })).secret, 'removed');
    db2.close();
    assert.equal(existsSync(path.join(backups, 'app-secret')), false);
    assert.ok(s.audit().some((row) => /^Confirmed the recovery sheet/.test(row.summary)));
  });

  test('the key is never taken on the command line (it would stay in the shell history)', () => {
    const s = scratch('cli-arg');
    const r = s.sheet([`--confirm=${key}`]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /not taken on the command line/);
    assert.equal(s.confirmed(), false);
  });

  test('--print sends the sheet to the printer and does not show the key on screen', () => {
    if (process.platform === 'win32') return;
    const s = scratch('cli-lp');
    const bin = path.join(tmp, 'lp-bin');
    const printed = path.join(tmp, 'printed.txt');
    mkdirSync(bin, { recursive: true });
    writeFileSync(path.join(bin, 'lp'), `#!/bin/sh\ncat > "${printed}"\necho "request id is Office-1 (1 file(s))"\n`);
    chmodSync(path.join(bin, 'lp'), 0o755);
    const r = s.sheet(['--print'], undefined, { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}` });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(readFileSync(printed, 'utf8').includes(keyForPaper(key)), 'the printer got the sheet');
    assert.equal(r.stdout.includes(keyForPaper(key)), false, 'the screen did not');
    assert.match(r.stdout, /Sent the recovery sheet to the printer/);
    assert.match(r.stdout, /npm run recovery-sheet -- --confirm/);
  });
});
