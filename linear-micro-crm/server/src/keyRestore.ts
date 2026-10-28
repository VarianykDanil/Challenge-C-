/**
 * `npm run key:restore`: put the app key back when Linear Hub says it is missing or wrong.
 *
 *   npm run key:restore                              type the key from the recovery sheet (or pipe it in)
 *   npm run key:restore -- --file <path>             use a saved key file (for example <backups>/app-secret)
 *   npm run key:restore -- --from <file>.lhbk        take the key out of an off-site backup (asks for its passphrase,
 *                                                    or reads LM_BACKUP_PASSPHRASE_FILE)
 *
 * The key is checked against the database first (its recorded fingerprint, or by opening a few of its locked values),
 * so a wrong key changes nothing. A key file that is already there with a different key is never deleted: it is kept
 * as app-secret.replaced-<time>. DB_PATH and LM_APP_SECRET_FILE are read the way the server reads them.
 */
import './serviceEnv.ts'; // first: the installed service's settings, before anything reads them
import { existsSync, renameSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { DatabaseSync } from 'node:sqlite';
import { DEFAULT_DB_PATH } from './db/seed.ts';
import { checkAppKey, storedFingerprint } from './lib/appKey.ts';
import { londonStamp } from './lib/backup.ts';
import { readSecretFile, secretFingerprint, shortFingerprint, writeSecretFile } from './lib/crypto.ts';
import { readArchiveKey, readPassphrase } from './lib/offsite.ts';
import { keyFromPaper } from './lib/recoverySheet.ts';

const dbPath = process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : DEFAULT_DB_PATH;
const keyFile = process.env.LM_APP_SECRET_FILE ? path.resolve(process.env.LM_APP_SECRET_FILE) : path.join(path.dirname(dbPath), 'app-secret');
const args = process.argv.slice(2);
const optionValue = (name: string) => {
  const i = args.indexOf(name);
  const inline = args.find((a) => a.startsWith(`${name}=`));
  return inline ? inline.slice(name.length + 1) : i >= 0 ? args[i + 1] : undefined;
};

function stop(message: string): never {
  console.error(message);
  process.exit(1);
}

/** A path as typed (relative to where npm was run). */
const typedPath = (p: string) => path.resolve(process.env.INIT_CWD ?? process.cwd(), p);

async function readTyped(question: string): Promise<string> {
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString('utf8');
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

if (process.env.LM_APP_SECRET) {
  stop('LM_APP_SECRET is set, so the server takes the key from it, not from a file. Set LM_APP_SECRET to the key from your recovery sheet instead.');
}
if (!existsSync(dbPath)) stop(`There is no database at ${dbPath}. Run this where Linear Hub runs, with DB_PATH set the same way.`);

let candidate: string | null;
const fromFile = optionValue('--file');
const fromArchive = optionValue('--from');
if (fromFile) {
  candidate = readSecretFile(typedPath(fromFile));
  if (!candidate) stop(`No key in ${typedPath(fromFile)} (the file is missing or empty).`);
} else if (fromArchive) {
  const archive = typedPath(fromArchive);
  if (!existsSync(archive)) stop(`No backup file at ${archive}.`);
  const passphrase = readPassphrase() ?? (await readTyped('Off-site backup passphrase: ')).trim();
  try {
    candidate = await readArchiveKey(archive, passphrase);
  } catch (err) {
    stop(err instanceof Error ? err.message : String(err));
  }
  if (!candidate) stop('That backup holds no app key (it was made while LM_APP_SECRET was used): use your recovery sheet instead.');
} else {
  candidate = keyFromPaper(await readTyped('Type the app key from your recovery sheet (spaces do not matter): '));
  if (!candidate) stop('Nothing was typed, so nothing was changed.');
}

const db = new DatabaseSync(dbPath, { readOnly: true });
let check: ReturnType<typeof checkAppKey>;
let needed: string | null;
try {
  check = checkAppKey(db, candidate);
  needed = storedFingerprint(db);
} finally {
  db.close();
}
const fingerprint = shortFingerprint(secretFingerprint(candidate));
if (check.status === 'mismatch') {
  stop(
    `That key (fingerprint ${fingerprint}) does not open this database` +
      `${needed ? `, which needs the key with fingerprint ${shortFingerprint(needed)}` : ''}. Nothing was changed.\n` +
      'Check each character against the sheet and try again, or use another copy of the key.',
  );
}

const existing = readSecretFile(keyFile);
if (existing === candidate) {
  console.log(`The key in ${keyFile} is already this key (fingerprint ${fingerprint}). Nothing to change.`);
  process.exit(0);
}
if (existsSync(keyFile)) {
  // never delete a key: it may be the only copy of another database's key
  const aside = `${keyFile}.replaced-${londonStamp(new Date())}`;
  renameSync(keyFile, aside);
  console.log(`Kept the key file that was there as ${aside}.`);
}
writeSecretFile(keyFile, candidate);
console.log(`Saved the app key to ${keyFile} (mode 600). Fingerprint ${fingerprint}${check.status === 'ok' && !check.record ? ', the one this database needs' : ''}.`);
if (check.status === 'create') console.log('Note: nothing in this database is locked yet, so the key could not be checked against it.');
console.log('Start Linear Hub again: npm start (or npm run service:install when it runs as a background service).');
