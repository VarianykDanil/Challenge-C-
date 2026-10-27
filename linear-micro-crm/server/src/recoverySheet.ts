/**
 * `npm run recovery-sheet`: print the recovery sheet (the app key and the steps to get Linear Hub back) on the server.
 *
 *   npm run recovery-sheet                     print it here, to copy onto paper or print from the terminal
 *   npm run recovery-sheet -- --out <file>     also save it as a text file (mode 600) to print; delete it afterwards
 *   npm run recovery-sheet -- --confirm        after printing: type the last six characters of the key from the paper,
 *                                              so backups stop carrying a copy of the key
 *
 * The key is checked against the database first (a wrong key is never put on paper). The audit trail records that a
 * sheet was made or confirmed ("Linear Hub", from the server command), never the key.
 */
import { chmodSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { BUSY_TIMEOUT_MS, openDb } from './db/connection.ts';
import { DEFAULT_DB_PATH } from './db/seed.ts';
import { appKeyRefusal, checkCurrentAppKey } from './lib/appKey.ts';
import { recordAudit } from './lib/audit.ts';
import { backupDirFor } from './lib/backup.ts';
import { configureAppSecret, currentAppSecret, secretFingerprint, shortFingerprint } from './lib/crypto.ts';
import { offsiteConfig } from './lib/offsite.ts';
import { buildRecoverySheet, confirmsKey, recordSheetConfirmed, recordSheetMade, recoverySheetText } from './lib/recoverySheet.ts';

const dbPath = process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : DEFAULT_DB_PATH;
const keyFile = process.env.LM_APP_SECRET_FILE ? path.resolve(process.env.LM_APP_SECRET_FILE) : path.join(path.dirname(dbPath), 'app-secret');
const args = process.argv.slice(2);
const outAt = args.indexOf('--out');
const out = outAt >= 0 ? args[outAt + 1] : undefined;
const confirmArg = args.find((a) => a.startsWith('--confirm'));

function stop(message: string): never {
  console.error(message);
  process.exit(1);
}

if (!existsSync(dbPath)) stop(`There is no database at ${dbPath}. Run this where Linear Hub runs, with DB_PATH set the same way.`);
configureAppSecret(keyFile);
const db = openDb(dbPath);
db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
try {
  const check = checkCurrentAppKey(db);
  if (check.status === 'missing' || check.status === 'mismatch') {
    stop(appKeyRefusal(check, { dbPath, keyFile: process.env.LM_APP_SECRET ? null : keyFile, backupDir: backupDirFor(dbPath) }));
  }
  const current = currentAppSecret();
  if (!current) stop('There is no app key yet: start Linear Hub once (npm start), then run this again.');
  const fingerprint = secretFingerprint(current.secret);
  const sheet = buildRecoverySheet({
    secret: current.secret,
    keySource: current.source,
    keyFile: current.source === 'file' ? keyFile : null,
    dbPath,
    backupDir: backupDirFor(dbPath),
    offsiteDir: offsiteConfig()?.dir ?? null,
  });
  const text = recoverySheetText(sheet);
  console.log(text);
  if (out) {
    const file = path.resolve(process.env.INIT_CWD ?? process.cwd(), out);
    writeFileSync(file, `${text}\n`, { mode: 0o600 });
    chmodSync(file, 0o600);
    console.log(`\nSaved to ${file} (mode 600). Print it, then delete the file: the key must not stay on this computer twice.`);
  }
  recordSheetMade(db, fingerprint);
  recordAudit(db, {
    userId: null,
    action: 'npm run recovery-sheet',
    entity: 'settings',
    entityId: null,
    summary: `Made the recovery sheet from the server command (key ${shortFingerprint(fingerprint)}). The key itself is never recorded`,
    after: { recoverySheetMade: true, keyFingerprint: shortFingerprint(fingerprint) },
  });

  if (confirmArg) {
    let typed = confirmArg.includes('=') ? confirmArg.slice(confirmArg.indexOf('=') + 1) : '';
    if (!typed) {
      if (!process.stdin.isTTY) stop('\nTo confirm, run it in a terminal (or add --confirm=<last six characters of the key>).');
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        typed = await rl.question('\nOnce it is printed and locked away, type the last six characters of the key from the paper: ');
      } finally {
        rl.close();
      }
    }
    if (!confirmsKey(current.secret, typed)) stop('Those are not the last six characters of the key. Nothing was confirmed: check the paper and run this again.');
    recordSheetConfirmed(db, fingerprint);
    recordAudit(db, {
      userId: null,
      action: 'npm run recovery-sheet',
      entity: 'settings',
      entityId: null,
      summary: `Confirmed the recovery sheet from the server command (key ${shortFingerprint(fingerprint)}): local backups no longer carry a copy of the key`,
      after: { recoverySheetConfirmed: true, keyFingerprint: shortFingerprint(fingerprint) },
    });
    console.log('Confirmed. From the next backup on, the backups folder no longer keeps a copy of the key: the sheet does.');
  } else {
    console.log('\nWhen it is printed and locked away, confirm it:  npm run recovery-sheet -- --confirm   (or in Settings › Backups).');
    console.log('Until then the backups folder keeps a copy of the key, so nothing can become unreadable.');
  }
} finally {
  db.close();
}
