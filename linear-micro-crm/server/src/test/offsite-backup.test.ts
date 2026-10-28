/**
 * REL-3 and RELIABILITY-MISSED-2: backups that survive losing the computer.
 *  - every backup carries a snapshot of the uploaded files (statement PDFs, the signature image), unchanged files
 *    shared with the previous snapshot, and the snapshot goes with its database file at rotation;
 *  - with LM_OFFSITE_DIR, an encrypted copy (database, files, app key) goes to the off-site folder, is read back before
 *    it gets its name, and is kept 30 daily + 8 weekly;
 *  - the full round trip: a new, empty computer gets everything back from one .lhbk file and its passphrase;
 *  - a wrong passphrase or a changed byte is refused without using anything from the file.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { get, openDb, type Db } from '../db/connection.ts';
import { createSchema } from '../db/schema.ts';
import { checkAppKey } from '../lib/appKey.ts';
import { backupNow, foldersOutsideBackup, lastBackupFailure, restoreDatabase, restoreKeyNotes, rotate } from '../lib/backup.ts';
import type { DataFolders } from '../lib/backupFiles.ts';
import { configureAppSecret } from '../lib/crypto.ts';
import { ARCHIVE_RE, extractArchive, offsiteStatus, rotateArchives, writeArchive, type OffsiteConfig } from '../lib/offsite.ts';
import { buildFixture, enrolTwoFactor } from './helpers.ts';

const KEY = '5'.repeat(64);
const PASSPHRASE = 'tidy-otter-copper-maple-river';
const FAST_KDF = 2 ** 12; // tests only: the real cost is 2^17
let tmp: string;
let n = 0;

before(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'linear-offsite-'));
});
after(() => {
  rmSync(tmp, { recursive: true, force: true });
});

interface Office {
  dir: string;
  dbPath: string;
  keyFile: string;
  folders: DataFolders;
  backups: string;
  offsite: OffsiteConfig;
  db: Db;
}

/** A small office: a database with a two-step secret, two uploaded files, a key, and an off-site folder. */
function office(): Office {
  const dir = path.join(tmp, `office-${++n}`);
  const dbPath = path.join(dir, 'data', 'linear.sqlite');
  const keyFile = path.join(dir, 'data', 'app-secret');
  mkdirSync(path.dirname(dbPath), { recursive: true });
  writeFileSync(keyFile, `${KEY}\n`, { mode: 0o600 });
  configureAppSecret(keyFile);
  const db = openDb(dbPath);
  createSchema(db);
  enrolTwoFactor(db, buildFixture(db).users.admin);
  const folders = foldersOutsideBackup(dbPath, {});
  mkdirSync(path.join(folders.statements, 'ab'), { recursive: true });
  writeFileSync(path.join(folders.statements, 'ab', 'abcdef.pdf'), '%PDF-1.4 statement');
  mkdirSync(folders.uploads, { recursive: true });
  writeFileSync(path.join(folders.uploads, '0123456789abcdef.png'), 'signature');
  mkdirSync(path.join(folders.media, 'videos'), { recursive: true });
  writeFileSync(path.join(folders.media, 'videos', 'big.mp4'), 'video');
  const offsiteDir = path.join(dir, 'cloud-drive');
  mkdirSync(offsiteDir);
  const passFile = path.join(dir, 'passphrase.txt');
  writeFileSync(passFile, `${PASSPHRASE}\n`, { mode: 0o600 });
  return {
    dir,
    dbPath,
    keyFile,
    folders,
    backups: path.join(dir, 'data', 'backups'),
    offsite: { dir: offsiteDir, passphraseFile: passFile, includeVideos: false, kdfN: FAST_KDF },
    db,
  };
}

describe('uploaded files in the local backups', () => {
  test('each backup gets a snapshot; unchanged files are shared with the previous one; videos only when asked', async () => {
    const o = office();
    try {
      const first = await backupNow(o.db, { dir: o.backups, secretFile: o.keyFile, files: { folders: o.folders, includeVideos: false }, now: new Date('2026-10-26T02:00:00Z') });
      assert.equal(first.files?.files, 2);
      assert.equal(first.files?.linked, 0);
      const snap1 = path.join(o.backups, 'linear-2026-10-26-0200.files');
      assert.equal(readFileSync(path.join(snap1, 'statements', 'ab', 'abcdef.pdf'), 'utf8'), '%PDF-1.4 statement');
      assert.equal(existsSync(path.join(snap1, 'media')), false, 'no videos by default');

      writeFileSync(path.join(o.folders.uploads, '0123456789abcdef.png'), 'new signature');
      const second = await backupNow(o.db, { dir: o.backups, secretFile: o.keyFile, files: { folders: o.folders, includeVideos: true }, now: new Date('2026-10-27T02:00:00Z') });
      assert.equal(second.files?.files, 3);
      assert.equal(second.files?.linked, 1, 'the unchanged statement PDF is a link to the previous copy');
      const snap2 = path.join(o.backups, 'linear-2026-10-27-0200.files');
      assert.equal(statSync(path.join(snap2, 'statements', 'ab', 'abcdef.pdf')).ino, statSync(path.join(snap1, 'statements', 'ab', 'abcdef.pdf')).ino);
      assert.equal(readFileSync(path.join(snap2, 'uploads', '0123456789abcdef.png'), 'utf8'), 'new signature');
      assert.equal(readFileSync(path.join(snap1, 'uploads', '0123456789abcdef.png'), 'utf8'), 'signature', 'the older snapshot keeps its own version');
      assert.equal(readFileSync(path.join(snap2, 'media', 'videos', 'big.mp4'), 'utf8'), 'video');
    } finally {
      o.db.close();
    }
  });

  test('rotation removes a snapshot together with its database file', async () => {
    const o = office();
    try {
      for (const day of ['2026-06-01', '2026-06-02']) {
        await backupNow(o.db, { dir: o.backups, secretFile: o.keyFile, files: { folders: o.folders, includeVideos: false }, now: new Date(`${day}T02:00:00Z`), rotate: false });
      }
      // both made long ago (file times), on two days of the same week far back: the weekly rule keeps the newer one
      const old = new Date('2026-06-02T03:00:00Z');
      for (const name of readdirSync(o.backups)) utimesSync(path.join(o.backups, name), old, old);
      const plan = rotate(o.backups, new Date('2026-10-27T02:00:00Z'));
      // (02:00 UTC is 03:00 in London in June)
      assert.deepEqual(plan.remove, ['linear-2026-06-01-0300.sqlite']);
      assert.equal(existsSync(path.join(o.backups, 'linear-2026-06-01-0300.files')), false);
      assert.equal(existsSync(path.join(o.backups, 'linear-2026-06-02-0300.files')), true);
    } finally {
      o.db.close();
    }
  });
});

describe('off-site encrypted copies', () => {
  test('full round trip: a new, empty computer gets the database, the uploaded files and the key back from one file', async () => {
    const o = office();
    const r = await backupNow(o.db, { dir: o.backups, secretFile: o.keyFile, files: { folders: o.folders, includeVideos: false }, offsite: o.offsite, now: new Date('2026-10-27T02:00:00Z') });
    assert.equal(r.offsiteError, null);
    assert.ok(r.offsite);
    assert.equal(r.offsite!.file, 'linear-2026-10-27-0200.lhbk');
    assert.match(r.offsite!.file, ARCHIVE_RE);
    assert.equal(r.offsite!.includesKey, true);
    if (process.platform !== 'win32') assert.equal(statSync(r.offsite!.path).mode & 0o777, 0o600);
    // nothing readable in it: no SQLite header, no key, no file contents
    const raw = readFileSync(r.offsite!.path);
    for (const needle of ['SQLite format 3', KEY, '%PDF-1.4 statement', 'signature']) assert.equal(raw.includes(Buffer.from(needle)), false, needle);
    const status = offsiteStatus(o.db, o.offsite);
    assert.equal(status.file, 'linear-2026-10-27-0200.lhbk');
    assert.equal(status.error, null);
    o.db.close();

    // the computer is lost; a new one has only the .lhbk file and the passphrase from paper
    const fresh = path.join(tmp, `new-computer-${n}`);
    const dbPath = path.join(fresh, 'data', 'linear.sqlite');
    const keyFile = path.join(fresh, 'data', 'app-secret');
    const folders = foldersOutsideBackup(dbPath, {});
    const copy = path.join(fresh, 'downloaded.lhbk');
    mkdirSync(fresh, { recursive: true });
    writeFileSync(copy, raw);
    const lines: string[] = [];
    const done = await restoreDatabase({
      dbPath,
      candidate: copy,
      port: 1,
      confirm: async () => true,
      passphrase: async () => PASSPHRASE,
      secretFile: keyFile,
      folders,
      log: (l) => lines.push(l),
    });
    assert.equal(done.status, 'restored', JSON.stringify(done));
    if (done.status !== 'restored') return;
    assert.equal(done.secret, 'installed');
    assert.equal(done.keySource, 'archive');
    const notes = restoreKeyNotes(done.secret, done.candidate, done.keptKey, done.keySource).join(' ');
    assert.match(notes, /app key from the off-site backup/, 'says where the key really came from');
    assert.doesNotMatch(notes, /backups folder/);
    assert.equal(readFileSync(keyFile, 'utf8').trim(), KEY);
    assert.equal(done.files?.restored, 2);
    assert.equal(readFileSync(path.join(folders.statements, 'ab', 'abcdef.pdf'), 'utf8'), '%PDF-1.4 statement');
    assert.equal(readFileSync(path.join(folders.uploads, '0123456789abcdef.png'), 'utf8'), 'signature');
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      assert.equal(checkAppKey(db, KEY).status, 'ok', 'the restored key opens the restored database');
      assert.ok(Number(get<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM users')!.n) > 0);
    } finally {
      db.close();
    }
    assert.equal(readdirSync(path.dirname(dbPath)).filter((f) => f.includes('restoring')).length, 0, 'nothing left in the staging folder');
  });

  test('a wrong passphrase, or one changed byte, is refused and nothing is restored', async () => {
    const o = office();
    const r = await backupNow(o.db, { dir: o.backups, secretFile: o.keyFile, offsite: o.offsite, now: new Date('2026-10-27T02:00:00Z') });
    o.db.close();
    const file = r.offsite!.path;
    await assert.rejects(extractArchive(file, 'not-the-passphrase', null), /passphrase does not open this backup/);
    const bytes = readFileSync(file);
    bytes[bytes.length - 40] = bytes[bytes.length - 40]! ^ 0x01;
    const tampered = path.join(o.dir, 'tampered.lhbk');
    writeFileSync(tampered, bytes);
    await assert.rejects(extractArchive(tampered, PASSPHRASE, null), /damaged or was changed/);
    const target = path.join(o.dir, 'elsewhere', 'linear.sqlite');
    const refused = await restoreDatabase({ dbPath: target, candidate: tampered, port: 1, confirm: async () => true, passphrase: async () => PASSPHRASE, log: () => {} });
    assert.equal(refused.status, 'refused');
    assert.equal(existsSync(target), false);
    assert.deepEqual(readdirSync(path.dirname(target)).filter((f) => f.includes('restoring')), []);
  });

  test('a header that was edited (say, a weaker scrypt cost) is refused too: the header is authenticated', async () => {
    const file = path.join(tmp, 'header.lhbk');
    await writeArchive(file, [{ name: 'manifest.json', data: Buffer.from('{}') }], PASSPHRASE, { kdfN: FAST_KDF });
    const bytes = readFileSync(file);
    const text = bytes.toString('latin1');
    const at = text.indexOf('"createdAt":"') + '"createdAt":"'.length;
    bytes[at] = '1'.charCodeAt(0) === bytes[at] ? '2'.charCodeAt(0) : '1'.charCodeAt(0);
    writeFileSync(file, bytes);
    await assert.rejects(extractArchive(file, PASSPHRASE, null), /damaged or was changed/);
  });

  test('a missing off-site folder (a cloud drive not mounted) fails the off-site copy only, and the failure is recorded', async () => {
    const o = office();
    try {
      rmSync(o.offsite.dir, { recursive: true });
      const r = await backupNow(o.db, { dir: o.backups, secretFile: o.keyFile, offsite: o.offsite, now: new Date('2026-10-27T02:00:00Z') });
      assert.ok(existsSync(r.path), 'the local backup is made');
      assert.match(r.offsiteError ?? '', /off-site folder .* is not there/);
      assert.equal(existsSync(o.offsite.dir), false, 'never created on this disk');
      const status = offsiteStatus(o.db, o.offsite);
      assert.match(status.error ?? '', /is not there/);
      assert.equal(lastBackupFailure(o.db), null, 'the local backup itself did not fail');

      // a passphrase that is too short is refused before anything is written
      mkdirSync(o.offsite.dir);
      writeFileSync(o.offsite.passphraseFile!, 'short\n');
      const weak = await backupNow(o.db, { dir: o.backups, secretFile: o.keyFile, offsite: o.offsite, now: new Date('2026-10-27T03:00:00Z') });
      assert.match(weak.offsiteError ?? '', /too short/);
      assert.deepEqual(readdirSync(o.offsite.dir), []);
    } finally {
      o.db.close();
    }
  });

  test('the off-site folder keeps 30 daily and 8 weekly copies, and never touches other files', () => {
    const dir = path.join(tmp, 'rotation-offsite');
    mkdirSync(dir);
    const old = new Date('2026-01-01T00:00:00Z');
    const names: string[] = [];
    for (let i = 0; i < 120; i++) {
      const d = new Date(Date.UTC(2026, 6, 1) + i * 86_400_000).toISOString().slice(0, 10);
      names.push(`linear-${d}-0200.lhbk`);
    }
    for (const name of [...names, 'notes.txt', 'linear-2026-07-01-0200.sqlite']) {
      writeFileSync(path.join(dir, name), 'x');
      utimesSync(path.join(dir, name), old, old);
    }
    const removed = rotateArchives(dir, new Date('2026-10-28T12:00:00Z'));
    const left = readdirSync(dir).filter((f) => ARCHIVE_RE.test(f));
    assert.ok(removed.length > 0);
    assert.ok(left.length <= 30 + 8 && left.length >= 30, `${left.length} kept`);
    assert.ok(existsSync(path.join(dir, 'notes.txt')));
    assert.ok(existsSync(path.join(dir, 'linear-2026-07-01-0200.sqlite')));
  });
});
