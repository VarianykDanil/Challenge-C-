/**
 * `npm run recovery-sheet`: the recovery sheet (the app key and the steps to get Linear Hub back), made and confirmed
 * only here on the server computer, so the key never travels over the network.
 *
 *   npm run recovery-sheet                     show it here, to print or copy onto paper by hand
 *   npm run recovery-sheet -- --print          send it straight to this computer's printer (lp), not to the screen
 *   npm run recovery-sheet -- --out <file>     also save it as a text file (mode 600) to print; delete it afterwards
 *   npm run recovery-sheet -- --confirm        once it is on paper: type the whole key back from the paper, so backups
 *                                              stop carrying a copy of the key (the key is not shown in this step)
 *
 * The key is checked against the database first (a wrong key is never put on paper). Confirming needs every character
 * of the key, typed when asked (never on the command line, where it would stay in the shell history). The audit trail
 * records that a sheet was made or confirmed ("Linear Hub", from the server command), never the key.
 */
import { spawnSync } from 'node:child_process';
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
const toPrinter = args.includes('--print');
const confirmArg = args.find((a) => a.startsWith('--confirm'));

function stop(message: string): never {
  console.error(message);
  process.exit(1);
}

/** What was typed: asked in a terminal, or read from a pipe. */
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

if (confirmArg && confirmArg !== '--confirm') {
  stop('The key is not taken on the command line: it would stay in the shell history. Run  npm run recovery-sheet -- --confirm  and type the key when asked.');
}
if (confirmArg && (toPrinter || out)) stop('Make the sheet first (with --print or --out), then confirm it in a second run:  npm run recovery-sheet -- --confirm');

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
  const short = shortFingerprint(fingerprint);

  if (confirmArg) {
    const typed = await readTyped('Type the whole key from the paper (the spaces between the groups do not matter): ');
    if (!confirmsKey(current.secret, typed)) {
      stop(
        'That is not the key this server uses. Nothing was confirmed: the backups folder keeps its copy of the key.\n' +
          'Check the paper character by character (a sheet with a mistake cannot open the data), then run this again. ' +
          'If it still does not match, make a new sheet.',
      );
    }
    recordSheetConfirmed(db, fingerprint);
    recordAudit(db, {
      userId: null,
      action: 'npm run recovery-sheet',
      entity: 'settings',
      entityId: null,
      summary: `Confirmed the recovery sheet from the server command (key ${short}): local backups no longer carry a copy of the key`,
      after: { recoverySheetConfirmed: true, keyFingerprint: short },
    });
    console.log(`Confirmed: the paper holds the key (fingerprint ${short}). From the next backup on, the backups folder no longer keeps a copy of the key.`);
  } else {
    const sheet = buildRecoverySheet({
      secret: current.secret,
      keySource: current.source,
      keyFile: current.source === 'file' ? keyFile : null,
      dbPath,
      backupDir: backupDirFor(dbPath),
      offsiteDir: offsiteConfig()?.dir ?? null,
    });
    const text = recoverySheetText(sheet);
    if (toPrinter) {
      const lp = spawnSync('lp', ['-t', 'Linear Hub recovery sheet'], { input: `${text}\n`, encoding: 'utf8' });
      if (lp.error || lp.status !== 0) {
        stop(
          `The printer did not take the sheet (${(lp.error?.message ?? lp.stderr ?? '').trim() || `lp exited ${lp.status}`}). ` +
            'Nothing was recorded. Run it without --print to show the sheet on screen, or with --out <file> to save it for printing.',
        );
      }
      console.log(`Sent the recovery sheet to the printer${lp.stdout.trim() ? ` (${lp.stdout.trim()})` : ''}. Key fingerprint on it: ${short}.`);
    } else {
      console.log(text);
    }
    if (out) {
      const file = path.resolve(process.env.INIT_CWD ?? process.cwd(), out);
      writeFileSync(file, `${text}\n`, { mode: 0o600 });
      chmodSync(file, 0o600);
      console.log(`\nSaved to ${file} (mode 600). Print it, then delete the file (and empty the Bin): the key must not stay on this computer twice.`);
    }
    recordSheetMade(db, fingerprint);
    recordAudit(db, {
      userId: null,
      action: 'npm run recovery-sheet',
      entity: 'settings',
      entityId: null,
      summary: `Made the recovery sheet from the server command (key ${short}). The key itself is never recorded`,
      after: { recoverySheetMade: true, keyFingerprint: short },
    });
    console.log('\nWhen it is on paper and locked away, confirm it:  npm run recovery-sheet -- --confirm   and type the whole key back from the paper.');
    console.log('Until then the backups folder keeps a copy of the key, so nothing can become unreadable.');
  }
} finally {
  db.close();
}
