/**
 * REL-1: the app key and the database belong together. A missing key file must never quietly become a new key for a
 * database that holds data locked with the old one, a different key must not start against it, and a backup must
 * never overwrite the saved copy of the key with a different one.
 *
 * The server is started for real (node src/index.ts) on a scratch database, as the owner's Mac or the VPS starts it.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { get, openDb } from '../db/connection.ts';
import { createSchema } from '../db/schema.ts';
import { KEY_META, checkAppKey, encryptedData } from '../lib/appKey.ts';
import { backupNow } from '../lib/backup.ts';
import { configureAppSecret, secretFingerprint } from '../lib/crypto.ts';
import { buildFixture, enrolTwoFactor } from './helpers.ts';

const serverDir = path.resolve(import.meta.dirname, '../..');
const KEY_A = 'a'.repeat(64);
const KEY_B = 'b'.repeat(64);
let tmp: string;

before(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'linear-app-key-'));
});
after(() => {
  rmSync(tmp, { recursive: true, force: true });
});

let n = 0;
/** A 1.4.0-shaped database (no key fingerprint) whose admin has two-step on, locked with KEY_A. */
function lockedDatabase(): { dir: string; dbPath: string; keyFile: string } {
  const dir = path.join(tmp, `case-${++n}`);
  mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, 'linear.sqlite');
  const keyFile = path.join(dir, 'app-secret');
  writeFileSync(keyFile, `${KEY_A}\n`, { mode: 0o600 });
  configureAppSecret(keyFile);
  const db = openDb(dbPath);
  createSchema(db);
  const f = buildFixture(db);
  enrolTwoFactor(db, f.users.admin);
  db.close();
  configureAppSecret(path.join(tmp, 'unused-app-secret'));
  return { dir, dbPath, keyFile };
}

interface Started {
  code: number | null;
  output: string;
  listening: boolean;
}

/** Starts the server and stops it once it listens (or reports how it ended when it refuses). */
async function startServer(dbPath: string, keyFile: string, env: Record<string, string> = {}): Promise<Started> {
  const child = spawn(process.execPath, [path.join(serverDir, 'src', 'index.ts')], {
    cwd: serverDir,
    env: {
      ...process.env,
      NODE_NO_WARNINGS: '1',
      TZ: 'Europe/London',
      PORT: '0',
      HOST: '127.0.0.1',
      DB_PATH: dbPath,
      LM_APP_SECRET_FILE: keyFile,
      LM_APP_SECRET: '',
      LM_BACKUP: '0',
      LM_PAYMENTS_JOB: '0',
      LM_STATEMENTS_JOB: '0',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  let listening = false;
  const code = await new Promise<number | null>((resolve) => {
    const onData = (b: Buffer) => {
      output += b.toString();
      if (!listening && /listening on/.test(output)) {
        listening = true;
        child.kill('SIGTERM');
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (c) => resolve(c));
    setTimeout(() => child.kill('SIGKILL'), 30_000).unref();
  });
  return { code, output, listening };
}

const meta = (dbPath: string, key: string) => {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return (db.prepare(`SELECT value FROM meta WHERE key = ?`).get(key) as { value?: string } | undefined)?.value ?? null;
  } finally {
    db.close();
  }
};

describe('start-up with the app key', () => {
  test('a missing key file for a database with locked data: refuses to start, makes no new key, says how to recover', async () => {
    const { dbPath, keyFile } = lockedDatabase();
    rmSync(keyFile);
    const r = await startServer(dbPath, keyFile);
    assert.equal(r.listening, false, r.output);
    assert.equal(r.code, 78, r.output);
    assert.equal(existsSync(keyFile), false, 'no new key was written');
    assert.match(r.output, /the app key is missing/);
    assert.match(r.output, /two-step sign-in/);
    assert.match(r.output, /npm run key:restore/);
    assert.match(r.output, /recovery sheet/);
    assert.match(r.output, /off-site backup/);
  });

  test('a different key: refuses to start and leaves the key file alone', async () => {
    const { dbPath, keyFile } = lockedDatabase();
    writeFileSync(keyFile, `${KEY_B}\n`);
    const r = await startServer(dbPath, keyFile);
    assert.equal(r.listening, false, r.output);
    assert.equal(r.code, 78, r.output);
    assert.equal(readFileSync(keyFile, 'utf8').trim(), KEY_B);
    assert.match(r.output, /is not the key this database was locked with/);
  });

  test('upgrading a 1.4.0 database with its own key: starts and records the key fingerprint; a later swap is then caught', async () => {
    const { dbPath, keyFile } = lockedDatabase();
    assert.equal(meta(dbPath, KEY_META.fingerprint), null, '1.4.0 had no fingerprint');
    const r = await startServer(dbPath, keyFile);
    assert.equal(r.listening, true, r.output);
    assert.equal(meta(dbPath, KEY_META.fingerprint), secretFingerprint(KEY_A));

    writeFileSync(keyFile, `${KEY_B}\n`);
    const again = await startServer(dbPath, keyFile);
    assert.equal(again.listening, false, again.output);
    assert.match(again.output, /is not the key this database was locked with/);
    assert.match(again.output, new RegExp(secretFingerprint(KEY_A).slice(0, 4).toUpperCase()), 'names the fingerprint it needs');
  });

  test('a brand-new database: makes a key, records its fingerprint and starts', async () => {
    const dir = path.join(tmp, 'fresh');
    mkdirSync(dir, { recursive: true });
    const dbPath = path.join(dir, 'linear.sqlite');
    const keyFile = path.join(dir, 'app-secret');
    const r = await startServer(dbPath, keyFile);
    assert.equal(r.listening, true, r.output);
    assert.ok(existsSync(keyFile));
    assert.equal(meta(dbPath, KEY_META.fingerprint), secretFingerprint(readFileSync(keyFile, 'utf8').trim()));
  });
});

describe('checkAppKey', () => {
  test('counts the kinds of locked data and decides missing / mismatch / ok / create', () => {
    const { dbPath } = lockedDatabase();
    const db = new DatabaseSync(dbPath);
    try {
      const data = encryptedData(db);
      assert.equal(data.parts['two-step sign-in'], 1);
      assert.equal(data.samples.length, 1);
      assert.equal(checkAppKey(db, null).status, 'missing');
      assert.equal(checkAppKey(db, KEY_B).status, 'mismatch');
      const ok = checkAppKey(db, KEY_A);
      assert.equal(ok.status, 'ok');
      assert.equal(ok.status === 'ok' && ok.record, true);
      // nothing locked: a missing key may be made again, a changed key is just recorded
      db.exec(`UPDATE users SET totp_secret_enc = NULL`);
      db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?)`).run(KEY_META.fingerprint, secretFingerprint(KEY_A));
      assert.equal(checkAppKey(db, null).status, 'create');
      const changed = checkAppKey(db, KEY_B);
      assert.equal(changed.status, 'ok');
      assert.equal(changed.status === 'ok' && changed.record, true);
    } finally {
      db.close();
    }
  });
});

describe('the key copy in the backups folder', () => {
  test('a backup never overwrites a saved key copy that has a different fingerprint', async () => {
    const { dbPath, keyFile, dir } = lockedDatabase();
    const backups = path.join(dir, 'backups');
    const db = openDb(dbPath);
    try {
      await backupNow(db, { dir: backups, secretFile: keyFile, rotate: false });
      assert.equal(readFileSync(path.join(backups, 'app-secret'), 'utf8').trim(), KEY_A);
      // the key file is replaced (say by mistake); the next backup must keep the only saved copy of the old key
      writeFileSync(keyFile, `${KEY_B}\n`);
      const r = await backupNow(db, { dir: backups, secretFile: keyFile, rotate: false, now: new Date(Date.now() + 120_000) });
      assert.equal(readFileSync(path.join(backups, 'app-secret'), 'utf8').trim(), KEY_A, 'the old copy is untouched');
      assert.equal(r.secret, 'kept-both');
      const other = readdirSync(backups).filter((f) => f.startsWith('app-secret-'));
      assert.equal(other.length, 1);
      assert.equal(readFileSync(path.join(backups, other[0]!), 'utf8').trim(), KEY_B, 'the new key is saved beside it under its fingerprint');
      assert.match(other[0]!, new RegExp(`^app-secret-${secretFingerprint(KEY_B).slice(0, 12)}$`));
    } finally {
      db.close();
    }
  });
});

describe('npm run doctor', () => {
  test('reports a key that does not match the database as a failure', () => {
    const { dbPath, keyFile } = lockedDatabase();
    writeFileSync(keyFile, `${KEY_B}\n`);
    const r = spawnSync(process.execPath, [path.join(serverDir, 'src', 'doctor.ts')], {
      cwd: serverDir,
      encoding: 'utf8',
      env: { ...process.env, NODE_NO_WARNINGS: '1', DB_PATH: dbPath, LM_APP_SECRET_FILE: keyFile, LM_APP_SECRET: '', LM_DOCTOR_SKIP_BOOT: '1', PORT: '0', HOME: tmp },
    });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /✖ .*app key/i);
    assert.match(r.stdout, /is not the key this database was locked with/);
  });

  test('a missing key file for a database with locked data is a failure too (not "generated on first start")', () => {
    const { dbPath, keyFile } = lockedDatabase();
    rmSync(keyFile);
    const r = spawnSync(process.execPath, [path.join(serverDir, 'src', 'doctor.ts')], {
      cwd: serverDir,
      encoding: 'utf8',
      env: { ...process.env, NODE_NO_WARNINGS: '1', DB_PATH: dbPath, LM_APP_SECRET_FILE: keyFile, LM_APP_SECRET: '', LM_DOCTOR_SKIP_BOOT: '1', PORT: '0', HOME: tmp },
    });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /✖ .*app key is missing/i);
    assert.equal(existsSync(keyFile), false);
    const db = new DatabaseSync(dbPath, { readOnly: true });
    assert.equal(get<{ n: number }>(db, `SELECT COUNT(*) AS n FROM meta WHERE key = ?`, [KEY_META.fingerprint])?.n, 0, 'doctor writes nothing');
    db.close();
  });
});
