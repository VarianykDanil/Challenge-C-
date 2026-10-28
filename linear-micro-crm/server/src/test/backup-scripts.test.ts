/**
 * `npm run backup` and `npm run restore` as Matt runs them. The folders they name are the ones the server really uses;
 * since 1.5 the backups hold the uploaded files (client statement PDFs, the signature image) beside the database and
 * restore puts them back, while learning videos stay out unless LM_BACKUP_VIDEOS=1 (both commands say so); a restore
 * refused for want of --yes says so once. (Before 1.5 these tests checked that the files were left out of the backups:
 * RELIABILITY-MISSED-2.)
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../db/connection.ts';
import { createSchema } from '../db/schema.ts';
import { backupContentsNote, foldersOutsideBackup, restoreFolderNotes } from '../lib/backup.ts';
import { configureAppSecret } from '../lib/crypto.ts';
import { uploadsDir } from '../lib/invoices.ts';
import { statementsDir } from '../lib/statements/files.ts';
import { mediaRootFor } from '../lib/videos/files.ts';

const serverDir = path.resolve(import.meta.dirname, '../..');
let tmp: string;
let dataDir: string;
let dbPath: string;
let backupDir: string;

/** A port nothing listens on, so restore's "is it running?" check passes. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

function run(script: string, args: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: serverDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'], // stdin is not a terminal, as under a script or launchd
    env: { ...process.env, NODE_NO_WARNINGS: '1', TZ: 'Europe/London', HOME: tmp, XDG_CONFIG_HOME: '', DB_PATH: dbPath, LM_BACKUP_DIR: backupDir, ...env },
  });
}

before(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'linear-backup-scripts-'));
  dataDir = path.join(tmp, 'data');
  dbPath = path.join(dataDir, 'linear.sqlite');
  backupDir = path.join(tmp, 'backups');
  const db = openDb(dbPath);
  createSchema(db);
  db.close();
});
after(() => {
  rmSync(tmp, { recursive: true, force: true });
});


/** A folder's real path (its parent resolved through links), so two spellings of one folder compare equal. */
function realFolder(p: string): string {
  return path.join(realpathSync(path.dirname(p)), path.basename(p));
}

test('foldersOutsideBackup names the folders the server itself uses (defaults and the LM_* settings)', () => {
  const db = openDb(dbPath);
  try {
    configureAppSecret(path.join(dataDir, 'app-secret'));
    const plain = foldersOutsideBackup(dbPath, {});
    assert.deepEqual(plain, { media: path.join(dataDir, 'media'), statements: path.join(dataDir, 'statements'), uploads: path.join(dataDir, 'uploads') });
    // the same folder, however it is spelt: on a Mac the temporary folder is reached through a link (/var is /private/var)
    assert.equal(realFolder(plain.media), realFolder(mediaRootFor(db)));
    const saved = { s: process.env.LM_STATEMENTS_DIR, u: process.env.LM_UPLOADS_DIR };
    try {
      delete process.env.LM_STATEMENTS_DIR;
      delete process.env.LM_UPLOADS_DIR;
      assert.equal(realFolder(plain.statements), realFolder(statementsDir(db)));
      assert.equal(realFolder(plain.uploads), realFolder(uploadsDir()));

      const env = { LM_STATEMENTS_DIR: path.join(tmp, 'stmts'), LM_UPLOADS_DIR: 'rel/uploads', LM_APP_SECRET_FILE: path.join(tmp, 'keys', 'app-secret') };
      const moved = foldersOutsideBackup(dbPath, env);
      process.env.LM_STATEMENTS_DIR = env.LM_STATEMENTS_DIR;
      process.env.LM_UPLOADS_DIR = env.LM_UPLOADS_DIR;
      assert.equal(moved.statements, statementsDir(db));
      assert.equal(moved.uploads, uploadsDir());
      // without LM_UPLOADS_DIR the uploads sit next to the app secret, wherever LM_APP_SECRET_FILE puts it
      assert.equal(foldersOutsideBackup(dbPath, { LM_APP_SECRET_FILE: env.LM_APP_SECRET_FILE }).uploads, path.join(tmp, 'keys', 'uploads'));
    } finally {
      if (saved.s === undefined) delete process.env.LM_STATEMENTS_DIR;
      else process.env.LM_STATEMENTS_DIR = saved.s;
      if (saved.u === undefined) delete process.env.LM_UPLOADS_DIR;
      else process.env.LM_UPLOADS_DIR = saved.u;
    }
  } finally {
    db.close();
  }
});

test('the backup note says what is in the backup: files, the key (or where it is instead), and the videos left out', () => {
  const f = { media: '/d/media', statements: '/d/statements', uploads: '/d/uploads' };
  const files = { dir: '/b/x.files', files: 3, bytes: 10, linked: 0 };
  const withKey = backupContentsNote(f, { files, secret: 'copied' }, { includeVideos: false, envSecret: false });
  assert.match(withKey, /^This backup holds the database, 3 uploaded files \(client statement PDFs and the signature image\) and the app key\./);
  assert.match(withKey, /Learning videos \(\/d\/media\) are not in it: .*LM_BACKUP_VIDEOS=1/);
  assert.match(backupContentsNote(f, { files, secret: 'none' }, { includeVideos: false, envSecret: true }), /LM_APP_SECRET is not in them: keep it on your recovery sheet\./);
  assert.match(backupContentsNote(f, { files, secret: 'removed' }, { includeVideos: true, envSecret: false }), /not in the local backups: it is on your recovery sheet/);
  assert.doesNotMatch(backupContentsNote(f, { files, secret: 'removed' }, { includeVideos: true, envSecret: false }), /Learning videos/);
  // a backup without a files snapshot names the folders to copy by hand
  assert.match(backupContentsNote(f, { files: null, secret: 'none' }, { includeVideos: false, envSecret: false }), /Copy \/d\/statements .* and \/d\/uploads .* yourself too/);
});

test('restore notes: files put back from the snapshot, or the old note for a backup without one; the orphan-video sentence only when videos exist', () => {
  const f = { media: '/d/media', statements: '/d/statements', uploads: '/d/uploads' };
  const none = restoreFolderNotes(f, null, () => false);
  assert.equal(none.length, 1);
  assert.match(none[0]!, /^Learning videos \(/);
  assert.match(none[0]!, /\/d\/media.*\/d\/statements.*\/d\/uploads/);
  const some = restoreFolderNotes(f, null, () => true);
  assert.equal(some.length, 2);
  assert.match(some[1]!, /Videos uploaded after this backup stay in \/d\/media\/videos/);
  const back = restoreFolderNotes(f, { restored: 2, unchanged: 1, setAside: 1, parts: ['statements', 'uploads'] }, () => false);
  assert.match(back[0]!, /^Uploaded files: 2 put back from the backup, 1 already the same, 1 that differed kept beside them/);
  assert.match(back[1]!, /Learning videos \(\/d\/media\) are not in this backup/);
});

test('npm run backup copies the uploaded files beside the database and names the videos folder it leaves out', () => {
  mkdirSync(path.join(dataDir, 'statements', 'ab'), { recursive: true });
  writeFileSync(path.join(dataDir, 'statements', 'ab', 'abcd.pdf'), '%PDF-statement');
  mkdirSync(path.join(dataDir, 'uploads'), { recursive: true });
  writeFileSync(path.join(dataDir, 'uploads', '0123456789abcdef.png'), 'png');
  const r = run('src/backup.ts', []);
  assert.equal(r.status, 0, r.stderr);
  const out = r.stdout;
  assert.match(out, /Backed up /);
  assert.match(out, /Uploaded files: 2 /);
  const snapshot = readdirSync(backupDir).find((n) => n.endsWith('.files'));
  assert.ok(snapshot, 'a files snapshot beside the database file');
  assert.equal(readFileSync(path.join(backupDir, snapshot!, 'statements', 'ab', 'abcd.pdf'), 'utf8'), '%PDF-statement');
  assert.equal(readFileSync(path.join(backupDir, snapshot!, 'uploads', '0123456789abcdef.png'), 'utf8'), 'png');
  assert.match(out, /This backup holds the database and 2 uploaded files \(client statement PDFs and the signature image\)\./);
  assert.ok(out.includes(path.join(dataDir, 'media')), `the videos folder is named:\n${out}`);
  assert.match(out, /No off-site copy/);
});

test('npm run restore: without --yes and no terminal it says why once; with --yes it names the folders it left alone', async () => {
  const file = readdirSync(backupDir).find((n) => n.endsWith('.sqlite'));
  assert.ok(file, 'the previous test made a backup');
  const PORT = String(await freePort());

  const refused = run('src/restore.ts', [file!], { PORT });
  assert.equal(refused.status, 1, refused.stderr);
  assert.match(refused.stdout, /Nothing was changed: add --yes/);
  assert.ok(!/Restore cancelled/.test(refused.stdout), `one refusal, not two:\n${refused.stdout}`);

  mkdirSync(path.join(dataDir, 'media', 'videos'), { recursive: true });
  writeFileSync(path.join(dataDir, 'media', 'videos', '00000000-0000-4000-8000-000000000000.mp4'), 'x');
  // the statement PDF is lost and the signature image replaced after the backup
  rmSync(path.join(dataDir, 'statements'), { recursive: true });
  writeFileSync(path.join(dataDir, 'uploads', '0123456789abcdef.png'), 'changed');
  const ok = run('src/restore.ts', [file!, '--yes'], { PORT });
  assert.equal(ok.status, 0, ok.stderr + ok.stdout);
  assert.match(ok.stdout, /^Restored\./m);
  assert.match(ok.stdout, /Uploaded files: 2 put back from the backup, 0 already the same, 1 that differed kept beside them/);
  assert.equal(readFileSync(path.join(dataDir, 'statements', 'ab', 'abcd.pdf'), 'utf8'), '%PDF-statement');
  assert.equal(readFileSync(path.join(dataDir, 'uploads', '0123456789abcdef.png'), 'utf8'), 'png');
  assert.ok(readdirSync(path.join(dataDir, 'uploads')).some((n) => n.startsWith('0123456789abcdef.png.before-restore-')));
  assert.ok(ok.stdout.includes(path.join(dataDir, 'media')), `media named:\n${ok.stdout}`);
  assert.match(ok.stdout, /Videos uploaded after this backup stay in .*media[/\\]videos/);
  const lines = ok.stdout.trim().split('\n');
  assert.match(lines.at(-1)!, /^Start it again: npm start$/, 'the start hint stays last');
});
