/**
 * `npm run backup`: back the database up now (safe while the server is running: the online backup copies a
 * consistent snapshot of the WAL database), with the uploaded files beside it and, when LM_OFFSITE_DIR is set, an
 * encrypted off-site copy.  `npm run backups`: list the backup files with their size and age.
 * `npm run backup -- --new-passphrase <file>`: make a passphrase for off-site copies (mode 600) and print it once, to
 * write on paper.  `--no-offsite` skips the off-site copy this time.
 *
 * DB_PATH, LM_BACKUP_DIR, LM_APP_SECRET(_FILE), LM_STATEMENTS_DIR, LM_UPLOADS_DIR, LM_BACKUP_VIDEOS, LM_OFFSITE_DIR and
 * LM_BACKUP_PASSPHRASE_FILE are read the same way as the server reads them.
 */
import { DatabaseSync } from 'node:sqlite';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BUSY_TIMEOUT_MS } from './db/connection.ts';
import { DEFAULT_DB_PATH } from './db/seed.ts';
import {
  BACKUP_RULES,
  SECRET_COPY_NAME,
  backupContentsNote,
  backupDirFor,
  backupNow,
  backupStatus,
  foldersOutsideBackup,
  formatBytes,
  listBackups,
  secretCopyNameFor,
} from './lib/backup.ts';
import { backupVideos } from './lib/backupFiles.ts';
import { configureAppSecret, currentAppSecret, secretFingerprint } from './lib/crypto.ts';
import { listArchives, newPassphrase, offsiteConfig } from './lib/offsite.ts';

const dbPath = process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : DEFAULT_DB_PATH;
const dir = backupDirFor(dbPath);
const secretFile = process.env.LM_APP_SECRET_FILE ? path.resolve(process.env.LM_APP_SECRET_FILE) : path.join(path.dirname(dbPath), 'app-secret');
configureAppSecret(secretFile);
const args = process.argv.slice(2);

/** "4 min ago", "3 h ago", "2 days ago". */
function age(ms: number): string {
  const s = Math.max(0, ms / 1000);
  if (s < 90) return 'just now';
  if (s < 90 * 60) return `${Math.round(s / 60)} min ago`;
  if (s < 36 * 3600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

function list(): void {
  const files = listBackups(dir);
  if (!files.length) {
    console.log(`No backups yet in ${dir}.`);
    console.log('Make one now:  npm run backup   (the server also makes one every night while it runs).');
    return;
  }
  const now = Date.now();
  const rows = files.map((f) => [f.name, formatBytes(f.bytes), age(now - f.mtimeMs)]);
  const w = [0, 1, 2].map((i) => Math.max(['File', 'Size', 'Age'][i]!.length, ...rows.map((r) => r[i]!.length)));
  const line = (r: string[]) => `  ${r[0]!.padEnd(w[0]!)}  ${r[1]!.padStart(w[1]!)}  ${r[2]}`;
  console.log(`Backups in ${dir}\n`);
  console.log(line(['File', 'Size', 'Age']));
  for (const r of rows) console.log(line(r));
  const total = files.reduce((n, f) => n + f.bytes, 0);
  console.log(`\n${files.length} backup${files.length === 1 ? '' : 's'}, ${formatBytes(total)} in all.`);
  const newestAgeH = (now - files[0]!.mtimeMs) / 3_600_000;
  if (newestAgeH > BACKUP_RULES.staleHours) console.log(`The newest is ${age(now - files[0]!.mtimeMs)}: is the server running? Run  npm run backup  now.`);
  const offsite = offsiteConfig();
  if (offsite) {
    const copies = listArchives(offsite.dir);
    console.log(
      copies.length
        ? `\nOff-site copies in ${offsite.dir}: ${copies.length}, the newest ${copies[0]!.name} (${age(now - copies[0]!.mtimeMs)}).`
        : `\nNo off-site copies yet in ${offsite.dir}.`,
    );
  }
  console.log('Restore one with:  npm run restore -- <file>   (stop the server first).');
}

function makePassphrase(target: string): void {
  const file = path.resolve(process.env.INIT_CWD ?? process.cwd(), target);
  if (existsSync(file)) {
    console.error(`${file} already exists, so it was left as it is: a backup made with that passphrase needs it. Pick another file name.`);
    process.exit(1);
  }
  const passphrase = newPassphrase();
  writeFileSync(file, `${passphrase}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  console.log(`Saved a new off-site backup passphrase to ${file} (mode 600):\n\n    ${passphrase}\n`);
  console.log('Write it on paper now and keep it apart from the recovery sheet: without it no off-site copy can be opened.');
  console.log(`Then set  LM_BACKUP_PASSPHRASE_FILE=${file}  and  LM_OFFSITE_DIR=<the off-site folder>  for the server (npm run service:install again).`);
}

function version(): string {
  try {
    return (JSON.parse(readFileSync(path.resolve(import.meta.dirname, '../../package.json'), 'utf8')) as { version?: string }).version ?? '';
  } catch {
    return '';
  }
}

async function backup(): Promise<void> {
  if (!existsSync(dbPath)) {
    console.error(`No database at ${dbPath} yet, so there is nothing to back up. Start Linear Hub once (npm start) to create it.`);
    process.exit(1);
  }
  const folders = foldersOutsideBackup(dbPath);
  const includeVideos = backupVideos();
  const offsite = args.includes('--no-offsite') ? null : offsiteConfig();
  const db = new DatabaseSync(dbPath);
  let failed = false;
  try {
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    const r = await backupNow(db, { dir, secretFile, files: { folders, includeVideos }, offsite, version: version() });
    console.log(`Backed up ${dbPath}`);
    console.log(`       to ${r.path} (${formatBytes(r.bytes)}, ${r.ms} ms).`);
    if (r.files) console.log(`Uploaded files: ${r.files.files} (${formatBytes(r.files.bytes)}) in ${r.files.dir}${r.files.linked ? `, ${r.files.linked} shared with the previous backup` : ''}.`);
    if (r.secret === 'copied') console.log(`Copied the app key to ${path.join(dir, SECRET_COPY_NAME)} (mode 600): keep the folder private.`);
    if (r.secret === 'kept-both') {
      const fp = secretFingerprint(currentAppSecret()?.secret ?? '');
      console.log(
        `▲ The app key copy already in ${dir} is a DIFFERENT key, so it was kept, and this key was saved beside it as ${secretCopyNameFor(fp)}. ` +
          'Older backups may need the other one: never delete either.',
      );
    }
    if (r.secret === 'removed') console.log('Removed the copy of the app key from the backups folder: the owner has confirmed the recovery sheet for it.');
    const status = backupStatus(db, dir);
    console.log(`${status.count} backup${status.count === 1 ? '' : 's'} kept in ${dir}${r.removed.length ? ` (${r.removed.length} old one${r.removed.length === 1 ? '' : 's'} removed)` : ''}.`);
    if (r.offsite) {
      console.log(`Off-site copy (encrypted): ${r.offsite.path} (${formatBytes(r.offsite.bytes)}, ${r.offsite.ms} ms, checked by reading it back).`);
    } else if (r.offsiteError) {
      failed = true;
      console.error(`✖ The off-site copy failed: ${r.offsiteError}\n  The local backup above is fine. Fix the problem, then run  npm run backup  again.`);
    } else if (!offsite) {
      console.log('No off-site copy: a backup on the same computer does not survive losing it. Set LM_OFFSITE_DIR (docs/DEPLOY.md), or copy the backups folder somewhere else yourself.');
    }
    console.log(backupContentsNote(folders, r, { includeVideos, envSecret: Boolean(process.env.LM_APP_SECRET) }));
  } finally {
    db.close();
  }
  if (failed) process.exit(1);
}

const passphraseAt = args.indexOf('--new-passphrase');
if (passphraseAt >= 0) {
  const target = args[passphraseAt + 1];
  if (!target || target.startsWith('-')) {
    console.error('Usage: npm run backup -- --new-passphrase <file>');
    process.exit(1);
  }
  makePassphrase(target);
} else if (args.includes('--list')) list();
else await backup();
