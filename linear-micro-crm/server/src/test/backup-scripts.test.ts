/**
 * `npm run backup` and `npm run restore` as Matt runs them: both say that the 1.3 folders outside the database
 * (learning videos, client statement PDFs, the signature image) are not in the backups, the folders they name are the
 * ones the server really uses, and a restore refused for want of --yes says so once.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../db/connection.ts';
import { createSchema } from '../db/schema.ts';
import { foldersOutsideBackup, restoreFolderNotes } from '../lib/backup.ts';
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

test('foldersOutsideBackup names the folders the server itself uses (defaults and the LM_* settings)', () => {
  const db = openDb(dbPath);
  try {
    configureAppSecret(path.join(dataDir, 'app-secret'));
    const plain = foldersOutsideBackup(dbPath, {});
    assert.deepEqual(plain, { media: path.join(dataDir, 'media'), statements: path.join(dataDir, 'statements'), uploads: path.join(dataDir, 'uploads') });
    assert.equal(plain.media, mediaRootFor(db));
    const saved = { s: process.env.LM_STATEMENTS_DIR, u: process.env.LM_UPLOADS_DIR };
    try {
      delete process.env.LM_STATEMENTS_DIR;
      delete process.env.LM_UPLOADS_DIR;
      assert.equal(plain.statements, statementsDir(db));
      assert.equal(plain.uploads, uploadsDir());

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

test('the orphan-video sentence appears only when the media folder holds videos', () => {
  const f = { media: '/d/media', statements: '/d/statements', uploads: '/d/uploads' };
  const none = restoreFolderNotes(f, () => false);
  assert.equal(none.length, 1);
  assert.match(none[0]!, /^Only the database was restored\./);
  assert.match(none[0]!, /\/d\/media.*\/d\/statements.*\/d\/uploads/);
  const some = restoreFolderNotes(f, () => true);
  assert.equal(some.length, 2);
  assert.match(some[1]!, /Videos uploaded after this backup stay in \/d\/media\/videos/);
});

test('npm run backup ends by naming the folders the backup leaves out', () => {
  const r = run('src/backup.ts', []);
  assert.equal(r.status, 0, r.stderr);
  const out = r.stdout;
  assert.match(out, /Backed up /);
  for (const name of ['media', 'statements', 'uploads']) assert.ok(out.includes(path.join(dataDir, name)), `${name} named:\n${out}`);
  assert.match(out, /the backups hold the database and the app secret only/i);
  assert.match(out, /learning videos/);
  assert.match(out, /client statement PDFs/);
  assert.match(out, /signature image/);
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
  const ok = run('src/restore.ts', [file!, '--yes'], { PORT });
  assert.equal(ok.status, 0, ok.stderr + ok.stdout);
  assert.match(ok.stdout, /^Restored\./m);
  assert.match(ok.stdout, /Only the database was restored\./);
  for (const name of ['media', 'statements', 'uploads']) assert.ok(ok.stdout.includes(path.join(dataDir, name)), `${name} named:\n${ok.stdout}`);
  assert.match(ok.stdout, /Videos uploaded after this backup stay in .*media[/\\]videos/);
  const lines = ok.stdout.trim().split('\n');
  assert.match(lines.at(-1)!, /^Start it again: npm start$/, 'the start hint stays last');
});
