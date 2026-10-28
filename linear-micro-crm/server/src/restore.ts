/**
 * `npm run restore -- <file> [--yes] [--forget-payments]`: put a backup back as the live database.
 *
 * <file> is a backup from the backups folder (`linear-….sqlite`, with its uploaded files beside it) or an encrypted
 * off-site copy (`linear-….lhbk`: the passphrase comes from LM_BACKUP_PASSPHRASE_FILE, or is asked in the terminal).
 * It may be a path (relative to the folder you ran npm from) or just a file name from the backups folder.
 *
 * Refuses while the database is open in another process (a Linear Hub on any PORT or HOST: an exclusive-lock probe),
 * or anything answers on PORT (default 4000): stop it first with npm run stop (with the PORT it runs on), or
 * npm run service:uninstall when it runs as a background service. The backup is checked (PRAGMA integrity_check and
 * the core tables) and compared with the current database. When the current database has payments approved or sent,
 * bank files, bank details changes or pay runs marked paid that the backup does not, they are listed and the restore
 * goes ahead only when RESTORE is typed (or, without a terminal, with --yes --forget-payments). Otherwise a typed "y"
 * or --yes is enough. The current database and its -wal/-shm files are kept as <db>.before-restore-<time>; the key that
 * opens the backup is put in place (an existing different key file is kept aside); the backup's uploaded files are put
 * back.
 */
import './serviceEnv.ts'; // first: the installed service's settings, before anything reads them
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { DEFAULT_DB_PATH } from './db/seed.ts';
import {
  backupDirFor,
  foldersOutsideBackup,
  listBackups,
  restoreDatabase,
  restoreFolderNotes,
  restoreKeyNotes,
} from './lib/backup.ts';
import { readPassphrase } from './lib/offsite.ts';
import { installedServiceFile } from './service.ts';

const dbPath = process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : DEFAULT_DB_PATH;
const dir = backupDirFor(dbPath);
const port = Number(process.env.PORT ?? 4000);
const args = process.argv.slice(2);
const yes = args.includes('--yes') || args.includes('-y');
const forgetPayments = args.includes('--forget-payments');
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
  console.log('An off-site copy (.lhbk) can be restored the same way: npm run restore -- <path to the .lhbk file>');
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

/** Set when confirm has already said why nothing was changed, so the cancel line is not printed as well. */
let toldWhy = false;

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

async function confirm(question: string, opts: { typed?: string } = {}): Promise<boolean> {
  if (opts.typed) {
    if (!process.stdin.isTTY) {
      if (yes && forgetPayments) return true;
      console.log(`Nothing was changed: this restore makes Linear Hub forget the payments above. Run it in a terminal and type ${opts.typed}, or add --yes --forget-payments.`);
      toldWhy = true;
      return false;
    }
    const answer = await ask(`${question} The current database is kept as a .before-restore file. `);
    return answer.trim() === opts.typed;
  }
  if (yes) return true;
  if (!process.stdin.isTTY) {
    console.log('Nothing was changed: add --yes to confirm when not running in a terminal.');
    toldWhy = true;
    return false;
  }
  const answer = await ask(`${question} The current one is kept as a .before-restore file. [y/N] `);
  return /^y(es)?$/i.test(answer.trim());
}

async function passphrase(): Promise<string | null> {
  const fromFile = readPassphrase();
  if (fromFile) return fromFile;
  if (!process.stdin.isTTY) return null;
  return (await ask('Off-site backup passphrase: ')).trim() || null;
}

const service = installedServiceFile();
const keyFile = process.env.LM_APP_SECRET_FILE ? path.resolve(process.env.LM_APP_SECRET_FILE) : path.join(path.dirname(dbPath), 'app-secret');
const outcome = await restoreDatabase({
  dbPath,
  candidate: resolveCandidate(fileArg),
  port,
  confirm,
  passphrase,
  secretFile: process.env.LM_APP_SECRET ? null : keyFile,
  envSecret: process.env.LM_APP_SECRET || null,
  runningHint: service
    ? `Linear Hub is installed as a background service (${service}), which restarts it after npm run stop: run npm run service:uninstall first, restore, then npm run service:install.`
    : undefined,
});

if (outcome.status === 'refused') {
  console.error(outcome.reason);
  process.exit(1);
}
if (outcome.status === 'cancelled') {
  if (!toldWhy) console.log('Restore cancelled; nothing was changed.');
  process.exit(1);
}
console.log(`Restored. ${outcome.dbPath} now holds the backup (${outcome.candidate.users} users, ${outcome.candidate.gauges} gauge entries).`);
if (outcome.previous) console.log(`The database it replaced is kept as ${outcome.previous}${outcome.moved.length > 1 ? ' (with its -wal/-shm files)' : ''}.`);
for (const line of restoreKeyNotes(outcome.secret, outcome.candidate, outcome.keptKey, outcome.keySource)) console.log(line);
for (const line of restoreFolderNotes(foldersOutsideBackup(dbPath), outcome.files)) console.log(line);
if (outcome.losses.total || outcome.losses.unknown) {
  console.log('Before paying anyone: check the payments listed above against the bank. Administrators also see this warning in Linear Hub.');
}
console.log(service ? 'Start it again: npm run service:install' : 'Start it again: npm start');
