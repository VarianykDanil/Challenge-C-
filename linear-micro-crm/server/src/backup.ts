/**
 * `npm run backup`: back the database up now (safe while the server is running: the online backup copies a
 * consistent snapshot of the WAL database).  `npm run backups`: list the backup files with their size and age.
 *
 * DB_PATH, LM_BACKUP_DIR and LM_APP_SECRET_FILE are read the same way as the server reads them.
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_DB_PATH } from './db/seed.ts';
import { BACKUP_RULES, SECRET_COPY_NAME, backupDirFor, backupNow, backupStatus, formatBytes, listBackups } from './lib/backup.ts';

const dbPath = process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : DEFAULT_DB_PATH;
const dir = backupDirFor(dbPath);
const secretFile = process.env.LM_APP_SECRET_FILE ? path.resolve(process.env.LM_APP_SECRET_FILE) : path.join(path.dirname(dbPath), 'app-secret');

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
  if (!existsSync(path.join(dir, SECRET_COPY_NAME)) && !process.env.LM_APP_SECRET) {
    console.log(`No ${SECRET_COPY_NAME} copy in the folder yet: the next backup adds it (two-step codes and sign-in PINs need it after a restore).`);
  }
  console.log('Restore one with:  npm run restore -- <file>   (stop the server first).');
}

async function backup(): Promise<void> {
  if (!existsSync(dbPath)) {
    console.error(`No database at ${dbPath} yet, so there is nothing to back up. Start Linear Hub once (npm start) to create it.`);
    process.exit(1);
  }
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    const r = await backupNow(db, { dir, secretFile });
    console.log(`Backed up ${dbPath}`);
    console.log(`       to ${r.path} (${formatBytes(r.bytes)}, ${r.ms} ms).`);
    if (r.secret === 'copied') console.log(`Copied the app secret (the two-step and PIN key) to ${path.join(dir, SECRET_COPY_NAME)} (mode 600): keep the folder private.`);
    const status = backupStatus(db, dir);
    console.log(`${status.count} backup${status.count === 1 ? '' : 's'} kept in ${dir}${r.removed.length ? ` (${r.removed.length} old one${r.removed.length === 1 ? '' : 's'} removed)` : ''}.`);
    console.log('Copy that folder to iCloud Drive or Google Drive now and then: a backup on the same laptop does not survive losing the laptop.');
  } finally {
    db.close();
  }
}

if (process.argv.includes('--list')) list();
else await backup();
