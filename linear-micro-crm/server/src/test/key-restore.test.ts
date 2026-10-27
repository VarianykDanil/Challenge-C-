/**
 * `npm run key:restore`: puts the app key back from the recovery sheet (typed or piped), a saved key file or an
 * off-site backup, but only a key that opens this database. A key file already there is never deleted.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../db/connection.ts';
import { createSchema } from '../db/schema.ts';
import { configureAppSecret, secretFingerprint, shortFingerprint } from '../lib/crypto.ts';
import { writeArchive } from '../lib/offsite.ts';
import { keyForPaper } from '../lib/recoverySheet.ts';
import { buildFixture, enrolTwoFactor } from './helpers.ts';

const serverDir = path.resolve(import.meta.dirname, '../..');
const KEY_A = '0123456789abcdef'.repeat(4);
const KEY_B = 'f'.repeat(64);
let tmp: string;
let n = 0;

before(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'linear-key-restore-'));
});
after(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** A database whose admin has two-step on under KEY_A, and no key file. */
function lockedDatabase(): { dir: string; dbPath: string; keyFile: string } {
  const dir = path.join(tmp, `case-${++n}`);
  mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, 'linear.sqlite');
  const keyFile = path.join(dir, 'app-secret');
  const made = path.join(dir, 'made-with');
  writeFileSync(made, `${KEY_A}\n`);
  configureAppSecret(made);
  const db = openDb(dbPath);
  createSchema(db);
  enrolTwoFactor(db, buildFixture(db).users.admin);
  db.close();
  rmSync(made);
  return { dir, dbPath, keyFile };
}

function keyRestore(dbPath: string, keyFile: string, args: string[], input = '') {
  return spawnSync(process.execPath, [path.join(serverDir, 'src', 'keyRestore.ts'), ...args], {
    cwd: serverDir,
    encoding: 'utf8',
    input,
    env: { ...process.env, NODE_NO_WARNINGS: '1', DB_PATH: dbPath, LM_APP_SECRET_FILE: keyFile, LM_APP_SECRET: '', LM_BACKUP_PASSPHRASE_FILE: '' },
  });
}

describe('npm run key:restore', () => {
  test('the key typed from the sheet (groups of four, spaces) is checked and saved with mode 600', () => {
    const { dbPath, keyFile } = lockedDatabase();
    const r = keyRestore(dbPath, keyFile, [], `${keyForPaper(KEY_A)}\n`);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(readFileSync(keyFile, 'utf8').trim(), KEY_A);
    if (process.platform !== 'win32') assert.equal(statSync(keyFile).mode & 0o777, 0o600);
    assert.match(r.stdout, new RegExp(shortFingerprint(secretFingerprint(KEY_A))));
  });

  test('a wrong key changes nothing and says which fingerprint it had', () => {
    const { dbPath, keyFile } = lockedDatabase();
    const r = keyRestore(dbPath, keyFile, [], `${KEY_B}\n`);
    assert.equal(r.status, 1);
    assert.equal(existsSync(keyFile), false);
    assert.match(r.stderr, /does not open this database\. Nothing was changed/);
  });

  test('a different key file already there is kept aside, never deleted', () => {
    const { dbPath, keyFile, dir } = lockedDatabase();
    writeFileSync(keyFile, `${KEY_B}\n`);
    const saved = path.join(dir, 'saved-copy');
    writeFileSync(saved, `${KEY_A}\n`);
    const r = keyRestore(dbPath, keyFile, ['--file', saved]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(readFileSync(keyFile, 'utf8').trim(), KEY_A);
    const aside = readdirSync(dir).filter((f) => f.startsWith('app-secret.replaced-'));
    assert.equal(aside.length, 1);
    assert.equal(readFileSync(path.join(dir, aside[0]!), 'utf8').trim(), KEY_B);
  });

  test('from an off-site backup with its passphrase (piped in), and refused with a wrong passphrase', async () => {
    const { dbPath, keyFile, dir } = lockedDatabase();
    const archive = path.join(dir, 'linear-2026-10-27-0200.lhbk');
    await writeArchive(
      archive,
      [
        { name: 'manifest.json', data: Buffer.from('{}') },
        { name: 'app-secret', data: Buffer.from(`${KEY_A}\n`) },
      ],
      'correct horse battery staple',
      { kdfN: 2 ** 12 },
    );
    const wrong = keyRestore(dbPath, keyFile, ['--from', archive], 'not the passphrase\n');
    assert.equal(wrong.status, 1);
    assert.match(wrong.stderr, /passphrase does not open this backup/);
    assert.equal(existsSync(keyFile), false);
    const r = keyRestore(dbPath, keyFile, ['--from', archive], 'correct horse battery staple\n');
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(readFileSync(keyFile, 'utf8').trim(), KEY_A);
  });
});
