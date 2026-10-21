/**
 * `npm run restore -- <file> [--yes]`: put a backup back as the live database.
 *
 * Refuses while the database is open in another process (a Linear Hub on any PORT or HOST: an exclusive-lock probe),
 * or anything answers on PORT (default 4000): stop it first with npm run stop (with the PORT it runs on), or
 * npm run service:uninstall when it runs as a background service. The backup is checked (PRAGMA integrity_check and
 * the core tables), compared with the current database, and only replaces it after --yes or a typed "y". The current
 * database and its -wal/-shm files are kept as <db>.before-restore-<time>.
 *
 * <file> may be a path (relative to the folder you ran npm from) or just a file name from the backups folder.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { DEFAULT_DB_PATH } from './db/seed.ts';
import { backupDirFor, listBackups, restoreDatabase, restoreKeyNotes } from './lib/backup.ts';
import { installedServiceFile } from './service.ts';

const dbPath = process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : DEFAULT_DB_PATH;
const dir = backupDirFor(dbPath);
const port = Number(process.env.PORT ?? 4000);
const args = process.argv.slice(2);
const yes = args.includes('--yes') || args.includes('-y');
const fileArg = args.find((a) => !a.startsWith('-'));

function usage(): never {
  console.log('Usage: npm run restore -- <backup file> [--yes]\n');
  const files = listBackups(dir).slice(0, 5);
  if (files.length) {
    console.log(`Newest backups in ${dir}:`);
    for (const f of files) console.log(`  ${f.name}`);
    console.log(`\nFor example:  npm run restore -- ${files[0]!.name}`);
  } else {
    console.log(`There are no backups in ${dir} yet.`);
  }
  process.exit(1);
}

if (!fileArg) usage();

/** A path as typed (relative to where npm was run), else a name in the backups folder. */
function resolveCandidate(arg: string): string {
  if (path.isAbsolute(arg)) return arg;
  const typed = path.resolve(process.env.INIT_CWD ?? process.cwd(), arg);
  if (existsSync(typed)) return typed;
  const inDir = path.join(dir, arg);
  return existsSync(inDir) ? inDir : typed;
}

async function confirm(question: string): Promise<boolean> {
  if (yes) return true;
  if (!process.stdin.isTTY) {
    console.log('Nothing was changed: add --yes to confirm when not running in a terminal.');
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${question} The current one is kept as a .before-restore file. [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

const service = installedServiceFile();
const outcome = await restoreDatabase({
  dbPath,
  candidate: resolveCandidate(fileArg),
  port,
  confirm,
  secretFile: process.env.LM_APP_SECRET ? null : process.env.LM_APP_SECRET_FILE ? path.resolve(process.env.LM_APP_SECRET_FILE) : path.join(path.dirname(dbPath), 'app-secret'),
  runningHint: service
    ? `Linear Hub is installed as a background service (${service}), which restarts it after npm run stop: run npm run service:uninstall first, restore, then npm run service:install.`
    : undefined,
});

if (outcome.status === 'refused') {
  console.error(outcome.reason);
  process.exit(1);
}
if (outcome.status === 'cancelled') {
  console.log('Restore cancelled; nothing was changed.');
  process.exit(1);
}
console.log(`Restored. ${outcome.dbPath} now holds the backup (${outcome.candidate.users} users, ${outcome.candidate.gauges} gauge entries).`);
if (outcome.previous) console.log(`The database it replaced is kept as ${outcome.previous}${outcome.moved.length > 1 ? ' (with its -wal/-shm files)' : ''}.`);
for (const line of restoreKeyNotes(outcome.secret, outcome.candidate)) console.log(line);
console.log(service ? 'Start it again: npm run service:install' : 'Start it again: npm start');
